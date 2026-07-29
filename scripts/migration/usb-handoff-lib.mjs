import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const FAT32_MAX_FILE_BYTES = 4_294_967_294;
const MANIFEST_LINE = /^([a-f0-9]{64}) {2}([^\r\n]+)$/;

const REPORT_RULES = Object.freeze([
  {
    name: "secret-assignment",
    pattern: /(?:^|[\s"'])(?:[A-Z0-9]+_)*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|COOKIE|SESSION)(?:_[A-Z0-9]+)*\s*[:=]\s*\S+/i
  },
  {
    name: "authorization-value",
    pattern: /^\s*(?:authorization|proxy-authorization)\s*:\s*\S+/i
  },
  {
    name: "private-key-material",
    pattern: /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/i
  },
  {
    name: "cloudflare-credential-json",
    pattern: /"(?:AccountTag|TunnelSecret|TunnelID)"\s*:\s*"[^"]+"/i
  }
]);

export function assertPathWithin(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".") return candidate;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the handoff root: ${candidate}`);
  }
  return candidate;
}

export function assertFat32CompatibleSize(size, label) {
  if (!Number.isSafeInteger(size) || size < 0 || size > FAT32_MAX_FILE_BYTES) {
    throw new Error(`${label} is not compatible with the FAT32 single-file limit`);
  }
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function normalizeManifestPath(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\\") || /^[A-Za-z]:/.test(raw) || path.posix.isAbsolute(raw)) {
    throw new Error(`Unsafe manifest path: ${raw}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    throw new Error(`Unsafe manifest path: ${raw}`);
  }
  return normalized;
}

function manifestPathToHostPath(rootPath, relativePath) {
  return assertPathWithin(
    rootPath,
    path.join(path.resolve(rootPath), ...normalizeManifestPath(relativePath).split("/"))
  );
}

export async function writeSha256Manifest({ rootPath, relativePaths, manifestPath }) {
  const root = path.resolve(rootPath);
  const finalPath = assertPathWithin(root, manifestPath);
  const partialPath = assertPathWithin(root, `${finalPath}.partial`);
  const paths = [...new Set(relativePaths.map(normalizeManifestPath))].sort();
  const records = [];

  for (const relativePath of paths) {
    const filePath = manifestPathToHostPath(root, relativePath);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error(`Manifest source is not a file: ${relativePath}`);
    assertFat32CompatibleSize(metadata.size, relativePath);
    records.push({ path: relativePath, sha256: await sha256File(filePath) });
  }

  await mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await writeFile(
      partialPath,
      `${records.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
      { flag: "wx" }
    );
    await rename(partialPath, finalPath);
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
  return records;
}

export async function verifySha256Manifest({ rootPath, manifestPath }) {
  const root = path.resolve(rootPath);
  const raw = await readFile(assertPathWithin(root, manifestPath), "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  const records = [];
  for (const line of lines) {
    const match = MANIFEST_LINE.exec(line);
    if (!match) throw new Error("Invalid SHA-256 manifest line");
    const relativePath = normalizeManifestPath(match[2]);
    if (seen.has(relativePath)) throw new Error(`Duplicate manifest path: ${relativePath}`);
    seen.add(relativePath);
    const filePath = manifestPathToHostPath(root, relativePath);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error(`Manifest entry is not a file: ${relativePath}`);
    assertFat32CompatibleSize(metadata.size, relativePath);
    const actual = await sha256File(filePath);
    if (actual !== match[1]) throw new Error(`Checksum mismatch for ${relativePath}`);
    records.push({ path: relativePath, sha256: actual });
  }
  return records;
}

export function scanReturnedReport(text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of REPORT_RULES) {
      if (rule.pattern.test(lines[index])) {
        findings.push({ line: index + 1, rule: rule.name });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}
