import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readProjectFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("operational helper scripts default to the deployed local port", async () => {
  const manualBuilder = await readProjectFile("scripts/build-user-manual-pdf.ps1");
  const manualScreenshots = await readProjectFile("scripts/capture-manual-screenshots.mjs");
  const itBootstrap = await readProjectFile("scripts/first-run-it-bootstrap.ps1");

  assert.match(manualBuilder, /http:\/\/localhost:3116/);
  assert.match(manualScreenshots, /http:\/\/localhost:3116/);
  assert.match(itBootstrap, /\[int\]\$Port = 3116/);
  assert.match(itBootstrap, /http:\/\/localhost:\$Port\/palzivalerts\/it/);
});

test("public health check covers every shipped login route", async () => {
  const healthCheck = await readProjectFile("scripts/health-check.ps1");

  assert.match(healthCheck, /\/palzivalerts\/employee/);
  assert.match(healthCheck, /\/palzivalerts\/hr/);
  assert.match(healthCheck, /\/palzivalerts\/webmaster/);
  assert.match(healthCheck, /\/palzivalerts\/it/);
});

test("operational smoke surfaces cover the IT route", async () => {
  const smokeDeployed = await readProjectFile("scripts/smoke-deployed.mjs");
  const smokeRegression = await readProjectFile("scripts/smoke-regression.mjs");
  const windowsStartup = await readProjectFile("scripts/windows-startup.ps1");
  const deployDocs = await readProjectFile("DEPLOY_CLOUDFLARE.md");
  const launchChecklist = await readProjectFile("docs/PILOT_LAUNCH_CHECKLIST.md");
  const operationsRunbook = await readProjectFile("docs/OPERATIONS_RUNBOOK.md");

  for (const source of [smokeDeployed, smokeRegression, windowsStartup, deployDocs, launchChecklist, operationsRunbook]) {
    assert.match(source, /\/palzivalerts\/it/);
  }
});

test("cleanup docs and ignore rules do not keep stale local artifacts", async () => {
  const gitignore = await readProjectFile(".gitignore");
  const userManual = await readProjectFile("docs/USER_MANUAL.md");
  const operationsRunbook = await readProjectFile("docs/OPERATIONS_RUNBOOK.md");
  const quickStart = await readProjectFile("docs/QUICK_START_MANUAL.md");

  assert.match(gitignore, /^\.tmp-\*/m);
  assert.match(gitignore, /^output\//m);
  assert.doesNotMatch(userManual, /Access pin panel/i);
  assert.doesNotMatch(operationsRunbook, /Company Board PWA/);
  assert.doesNotMatch(quickStart, /\/C:\/Users\/admin\/Documents\/Codex\/Project-A/);
});

test("manual screenshots capture full mobile pages in public and authenticated modes", async () => {
  const manualBuilder = await readProjectFile("scripts/build-user-manual-pdf.ps1");
  const fullPageCaptureCount = (manualBuilder.match(/--full-page/g) || []).length;

  assert.ok(fullPageCaptureCount >= 3);
  assert.match(
    manualBuilder,
    /npx playwright screenshot --device="iPhone 13" --full-page --wait-for-timeout=1200 \$r\.url \$out/
  );
});
