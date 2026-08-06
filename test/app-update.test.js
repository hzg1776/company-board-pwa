import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function loadClientApp() {
  return readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
}

test("app update detector reads the live version from the versioned script URL", async () => {
  const app = await loadClientApp();
  const parserSource = app.match(/function parseAssetVersionFromHtml\(html\) \{[\s\S]*?\n\}/)?.[0] || "";
  const parseAssetVersionFromHtml = Function(`${parserSource}\nreturn parseAssetVersionFromHtml;`)();
  const html = `
    <!doctype html>
    <link rel="stylesheet" href="/styles.css?v=next-build">
    <script type="module" src="/app.js?v=next-build"></script>
  `;

  assert.equal(parseAssetVersionFromHtml(html), "next-build");
});

test("update reload navigates without waiting for stalled service-worker cleanup", async () => {
  const app = await loadClientApp();
  const reloadSource = app.match(/async function reloadForAppUpdate\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  let replacedUrl = "";
  const windowObject = {
    caches: {},
    location: {
      href: "https://example.test/palzivalerts/employee",
      replace(value) {
        replacedUrl = String(value);
      }
    }
  };
  const navigatorObject = {
    serviceWorker: {
      async getRegistrations() {
        return [{ update: () => new Promise(() => {}) }];
      }
    }
  };
  const cacheStorage = {
    async keys() {
      return [];
    },
    async delete() {
      return true;
    }
  };
  const reloadForAppUpdate = Function(
    "navigator",
    "window",
    "caches",
    "URL",
    `${reloadSource}\nreturn reloadForAppUpdate;`
  )(navigatorObject, windowObject, cacheStorage, URL);

  void reloadForAppUpdate();
  await new Promise((resolve) => setImmediate(resolve));

  assert.notEqual(replacedUrl, "");
  const nextUrl = new URL(replacedUrl);
  assert.equal(nextUrl.pathname, "/palzivalerts/employee");
  assert.ok(nextUrl.searchParams.get("v"));
});
