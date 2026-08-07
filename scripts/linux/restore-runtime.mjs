#!/usr/bin/env node
import { parseArguments, restoreRuntimeBackup } from "./runtime-backup-lib.mjs";

try {
  const args = parseArguments(process.argv.slice(2));
  const result = await restoreRuntimeBackup({
    archivePath: args.archive,
    dataDir: args["data-dir"],
    force: /^(1|true|yes)$/i.test(args.force || "false")
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
