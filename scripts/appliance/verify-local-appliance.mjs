#!/usr/bin/env node
import path from "node:path";

import { verifyApplianceArtifacts } from "./appliance-lib.mjs";

if (!process.argv[2]) throw new Error("Usage: verify-local-appliance.mjs <artifact-directory>");
const artifactRoot = path.resolve(process.argv[2]);
process.stdout.write(`${JSON.stringify(await verifyApplianceArtifacts({ artifactRoot }))}\n`);
