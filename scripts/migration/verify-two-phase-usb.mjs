#!/usr/bin/env node
import { verifyTwoPhaseUsb } from "./two-phase-usb-lib.mjs";

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Invalid arguments");
    result[key.slice(2)] = value;
  }
  return result;
}

try {
  const args = parseArguments(process.argv.slice(2));
  if (!args["bundle-root"] || !args.mode) {
    throw new Error("Usage: verify-two-phase-usb.mjs --bundle-root <absolute path> --mode <mode>");
  }
  const summary = await verifyTwoPhaseUsb({ bundleRoot: args["bundle-root"], mode: args.mode });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
