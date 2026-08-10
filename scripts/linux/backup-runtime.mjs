#!/usr/bin/env node
import { createRuntimeBackup, parseArguments } from "./runtime-backup-lib.mjs";

try {
  const args = parseArguments(process.argv.slice(2));
  const result = await createRuntimeBackup({
    dataDir: args["data-dir"],
    outputDir: args["output-dir"],
    releaseSha: args["release-sha"] || process.env.RELEASE_SHA || "unknown",
    dailyRetention: Number(args["daily-retention"] || 14),
    weeklyRetention: Number(args["weekly-retention"] || 8)
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
