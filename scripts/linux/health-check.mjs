#!/usr/bin/env node
import { parseArguments } from "./runtime-backup-lib.mjs";

async function probe(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  const url = new URL("/api/health", baseUrl).toString();

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok && body?.ok === true,
      status: response.status,
      durationMs: Date.now() - startedAt,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      error: String(error?.cause?.code || error?.message || error).slice(0, 160)
    };
  }
}

try {
  const args = parseArguments(process.argv.slice(2));
  const localUrl = args["local-url"] || "http://127.0.0.1:3116";
  const publicUrl = args["public-url"] || process.env.PUBLIC_BASE_URL || "https://itotexpress.com";
  const timeoutMs = Math.max(250, Number(args["timeout-ms"] || 5_000));
  const [local, publicResult] = await Promise.all([
    probe(localUrl, timeoutMs),
    probe(publicUrl, timeoutMs)
  ]);
  const classification = !local.ok
    ? "local-app-failure"
    : !publicResult.ok
      ? "public-dns-or-tunnel-failure"
      : "healthy";
  const summary = {
    checkedAt: new Date().toISOString(),
    classification,
    local,
    public: publicResult
  };

  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = classification === "healthy" ? 0 : classification === "local-app-failure" ? 1 : 2;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
