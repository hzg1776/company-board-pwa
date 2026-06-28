import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readRuntimeTextFile,
  writeRuntimeJsonFileAtomic
} from "../runtime-files.js";

test("writeRuntimeJsonFileAtomic writes JSON without orphaning temp files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-runtime-files-"));
  const dataFile = path.join(tempDir, "runtime", "data", "security.json");

  try {
    await writeRuntimeJsonFileAtomic(dataFile, { ok: true });

    const raw = await readRuntimeTextFile(dataFile);
    assert.equal(raw, "{\n  \"ok\": true\n}\n");

    const entries = await readdir(path.dirname(dataFile));
    assert.deepEqual(
      entries.filter((entry) => /^security\.json\..+\.tmp$/i.test(entry)),
      []
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime file helpers reject symlinked runtime directories", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-runtime-link-"));
  const outsideDir = path.join(tempDir, "outside");
  const linkedDataDir = path.join(tempDir, "runtime-data");
  const dataFile = path.join(linkedDataDir, "security.json");

  try {
    await rm(outsideDir, { recursive: true, force: true });
    await writeRuntimeJsonFileAtomic(path.join(outsideDir, "placeholder.json"), { ok: true });

    try {
      await symlink(outsideDir, linkedDataDir, "junction");
    } catch (error) {
      t.skip(`symlink creation is not available in this environment: ${error.code || error.message}`);
      return;
    }

    await assert.rejects(
      () => writeRuntimeJsonFileAtomic(dataFile, { leaked: true }),
      /Runtime data path must not contain symlinks/i
    );

    await assert.rejects(
      () => readRuntimeTextFile(dataFile),
      /Runtime data path must not contain symlinks/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
