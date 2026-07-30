import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanReturnedReport,
  verifySha256Manifest
} from "./usb-handoff-lib.mjs";

const TOP_LEVEL = Object.freeze([
  "CHECKSUMS",
  "FROM-DEBIAN",
  "ISOLATION-BOUNDARY.txt",
  "README-FIRST.txt",
  "SECRETS-ENCRYPTED",
  "TO-DEBIAN"
]);
const TOP_LEVEL_DIRECTORIES = new Set([
  "CHECKSUMS",
  "FROM-DEBIAN",
  "SECRETS-ENCRYPTED",
  "TO-DEBIAN"
]);
const INBOUND_FILES = Object.freeze([
  "ISOLATION-BOUNDARY.txt",
  "README-FIRST.txt",
  "TO-DEBIAN/collect-debian-readiness.sh"
]);
const FIXED_DIRECTORY_ENTRIES = Object.freeze({
  CHECKSUMS: ["TO-DEBIAN.sha256"],
  "SECRETS-ENCRYPTED": [],
  "TO-DEBIAN": ["collect-debian-readiness.sh"]
});
const RETURN_NAME = /^debian-readiness-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.txt(?:\.sha256)?$/;
const scriptPath = fileURLToPath(import.meta.url);

function sameEntries(actual, expected) {
  return (
    actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index])
  );
}

async function requireNonSymlinkDirectory(directoryPath, label) {
  const metadata = await lstat(directoryPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a non-symbolic-link directory`);
  }
}

async function verifyTopLevelLayout(root) {
  await requireNonSymlinkDirectory(root, "Handoff root");
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (!sameEntries(names, TOP_LEVEL)) {
    throw new Error("Handoff top-level layout does not match the approved structure");
  }

  for (const entry of entries) {
    const expectedDirectory = TOP_LEVEL_DIRECTORIES.has(entry.name);
    if (
      entry.isSymbolicLink()
      || (expectedDirectory ? !entry.isDirectory() : !entry.isFile())
    ) {
      throw new Error("Handoff top-level layout does not match the approved structure");
    }
  }
}

async function verifyFixedInboundLayout(root) {
  for (const [directoryName, expectedNames] of Object.entries(FIXED_DIRECTORY_ENTRIES)) {
    const directoryPath = path.join(root, directoryName);
    await requireNonSymlinkDirectory(directoryPath, directoryName);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    if (
      !sameEntries(names, expectedNames)
      || entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())
    ) {
      throw new Error("Handoff inbound layout does not match the approved structure");
    }
  }
}

export async function verifyUsbHandoff({ handoffRoot, mode }) {
  if (typeof handoffRoot !== "string" || !path.isAbsolute(handoffRoot)) {
    throw new Error("--handoff-root must be an absolute path");
  }
  if (!["outbound", "returned"].includes(mode)) {
    throw new Error("--mode must be outbound or returned");
  }

  const root = path.resolve(handoffRoot);
  await verifyTopLevelLayout(root);
  await verifyFixedInboundLayout(root);

  const inbound = await verifySha256Manifest({
    rootPath: root,
    manifestPath: path.join(root, "CHECKSUMS", "TO-DEBIAN.sha256")
  });
  if (!sameEntries(inbound.map((entry) => entry.path), INBOUND_FILES)) {
    throw new Error("Inbound checksum manifest does not contain the approved files");
  }

  const returnDir = path.join(root, "FROM-DEBIAN");
  await requireNonSymlinkDirectory(returnDir, "FROM-DEBIAN");
  const returnedEntries = await readdir(returnDir, { withFileTypes: true });
  const returnedNames = returnedEntries.map((entry) => entry.name).sort();

  if (mode === "outbound") {
    if (returnedNames.length) {
      throw new Error("Outbound handoff already contains returned files");
    }
    return { ok: true, mode, inboundFiles: inbound.length, reports: [] };
  }

  if (!returnedNames.length) {
    throw new Error("At least one returned report is required");
  }
  const unexpected = returnedNames.find((name) => !RETURN_NAME.test(name));
  if (unexpected) {
    throw new Error(`Unexpected return file: ${unexpected}`);
  }
  const invalidType = returnedEntries.find(
    (entry) => entry.isSymbolicLink() || !entry.isFile()
  );
  if (invalidType) {
    throw new Error(`Returned entry is not a file: ${invalidType.name}`);
  }

  const reportNames = returnedNames.filter((name) => name.endsWith(".txt"));
  const sidecarNames = new Set(
    returnedNames.filter((name) => name.endsWith(".txt.sha256"))
  );
  for (const sidecarName of sidecarNames) {
    const reportName = sidecarName.slice(0, -".sha256".length);
    if (!reportNames.includes(reportName)) {
      throw new Error(`Missing returned report for ${sidecarName}`);
    }
  }

  const reports = [];
  for (const reportName of reportNames) {
    const sidecarName = `${reportName}.sha256`;
    if (!sidecarNames.has(sidecarName)) {
      throw new Error(`Missing checksum sidecar for ${reportName}`);
    }
    const verified = await verifySha256Manifest({
      rootPath: returnDir,
      manifestPath: path.join(returnDir, sidecarName)
    });
    if (verified.length !== 1 || verified[0].path !== reportName) {
      throw new Error(`Checksum sidecar does not name only ${reportName}`);
    }

    const report = await readFile(path.join(returnDir, reportName), "utf8");
    const screening = scanReturnedReport(report);
    if (!screening.ok) {
      const finding = screening.findings[0];
      throw new Error(
        `Potential secret material detected at line ${finding.line} (${finding.rule}); do not open or share this report.`
      );
    }
    reports.push({ fileName: reportName, sha256: verified[0].sha256 });
  }

  return { ok: true, mode, inboundFiles: inbound.length, reports };
}

function parseCliArguments(args) {
  const usage = "Usage: node scripts/migration/verify-usb-handoff.mjs --handoff-root <absolute path> --mode outbound|returned";
  if (args.length !== 4) throw new Error(usage);

  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !["--handoff-root", "--mode"].includes(name)
      || !value
      || values.has(name)
    ) {
      throw new Error(usage);
    }
    values.set(name, value);
  }
  if (!values.has("--handoff-root") || !values.has("--mode")) {
    throw new Error(usage);
  }
  return {
    handoffRoot: values.get("--handoff-root"),
    mode: values.get("--mode")
  };
}

const invokedDirectly = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)
);

if (invokedDirectly) {
  try {
    const result = await verifyUsbHandoff(
      parseCliArguments(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
