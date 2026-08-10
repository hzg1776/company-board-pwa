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
    if (character === "(") parenDepth += 1;
    if (character === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        parameterEnd = index;
        break;
      }
    }
  }

  assert.notEqual(parameterEnd, -1, `${functionName} should include a complete parameter list`);
  const bodyStart = source.indexOf("{", parameterEnd);
  assert.notEqual(bodyStart, -1, `${functionName} should include a function body`);
  let depth = 1;

  for (let index = bodyStart + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  assert.fail(`${functionName} should have a complete body`);
}

async function loadClientFunction(functionName) {
  const source = await loadClientApp();
  const functionSource = extractFunctionSource(source, functionName);
  const context = { module: { exports: {} } };
  vm.runInNewContext(`${functionSource}\nmodule.exports = ${functionName};`, context);
  return context.module.exports;
}

test("employee password panel opens for a local temporary-password account", async () => {
  const employeePasswordPanelState = await loadClientFunction("employeePasswordPanelState");

  assert.equal(
    JSON.stringify(employeePasswordPanelState({ identityProvider: "local", passwordResetRequired: true })),
    '{"visible":true,"open":true}'
  );
  assert.equal(
    JSON.stringify(employeePasswordPanelState({ identityProvider: "local", passwordResetRequired: false })),
    '{"visible":true,"open":false}'
  );
  assert.equal(
    JSON.stringify(employeePasswordPanelState({ identityProvider: "saml", passwordResetRequired: true })),
    '{"visible":false,"open":false}'
  );
});

test("employee password form rejects mismatched confirmation", async () => {
  const employeePasswordChangeValidation = await loadClientFunction("employeePasswordChangeValidation");

  assert.equal(employeePasswordChangeValidation({
    password: "EmployeePass2!",
    confirmPassword: "EmployeePass3!"
  }), "New passwords do not match.");
  assert.equal(employeePasswordChangeValidation({
    password: "EmployeePass2!",
    confirmPassword: "EmployeePass2!"
  }), "");
});
