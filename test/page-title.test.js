import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

async function loadClientApp() {
  return readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
}

function extractFunctionSource(source, functionName) {
  const signature = `function ${functionName}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${functionName} should exist in public/app.js`);
  let parenDepth = 1;
  let parameterEnd = -1;

  for (let index = start + signature.length; index < source.length; index += 1) {
    const character = source[index];

    if (character === "(") {
      parenDepth += 1;
      continue;
    }

    if (character === ")") {
      parenDepth -= 1;

      if (parenDepth === 0) {
        parameterEnd = index;
        break;
      }
    }
  }

  assert.notEqual(parameterEnd, -1, `${functionName} should include a complete parameter list in public/app.js`);

  const bodyStart = source.indexOf("{", parameterEnd);
  assert.notEqual(bodyStart, -1, `${functionName} should include a function body in public/app.js`);

  let depth = 1;

  for (let index = bodyStart + 1; index < source.length; index += 1) {
    const character = source[index];

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  assert.fail(`${functionName} should have a complete body in public/app.js`);
}

async function loadBuildDocumentTitle() {
  const source = await loadClientApp();
  const functionSource = extractFunctionSource(source, "buildDocumentTitle");
  const context = { module: { exports: {} } };
  vm.runInNewContext(`${functionSource}\nmodule.exports = buildDocumentTitle;`, context);
  return context.module.exports;
}

test("buildDocumentTitle front-loads distinct page names for each main route and admin tab", async () => {
  const buildDocumentTitle = await loadBuildDocumentTitle();
  const appTitle = "Communications and Alert Center";

  assert.equal(buildDocumentTitle({ appTitle, route: "launcher" }), "Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "employee", employeeAuthorized: true }), "Employee Feed - Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "hr", hrAuthorized: true, activeAdminTab: "feed" }), "HR Feed - Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "hr", hrAuthorized: true, activeAdminTab: "share" }), "HR Users - Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "webmaster", webmasterAuthorized: true, activeWebmasterTab: "overview" }), "Systems Overview - Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "webmaster", webmasterAuthorized: true, activeWebmasterTab: "traffic" }), "Systems Traffic - Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "it", itAuthorized: true, activeItTab: "accounts" }), "IT Admin Accounts - Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "it", itAuthorized: true, activeItTab: "audit" }), "IT Audit Log - Communications and Alert Center");
});

test("buildDocumentTitle uses concise login titles before admin and employee access is authorized", async () => {
  const buildDocumentTitle = await loadBuildDocumentTitle();
  const appTitle = "Communications and Alert Center";

  assert.equal(buildDocumentTitle({ appTitle, route: "employee", employeeAuthorized: false }), "Employee Login - Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "hr", hrAuthorized: false }), "HR Login - Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "webmaster", webmasterAuthorized: false }), "Systems Login - Communications and Alert Center");
  assert.equal(buildDocumentTitle({ appTitle, route: "it", itAuthorized: false }), "IT Login - Communications and Alert Center");
});
