import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

async function loadRoutingHelpers() {
  const source = await readFile(path.join(process.cwd(), "public", "sw-routing.js"), "utf8");
  const context = {
    self: {},
    URL
  };

  vm.createContext(context);
  vm.runInContext(source, context);
  return context.self.__palzivSwRouting;
}

test("service worker routing normalizes notification targets onto the app origin", async () => {
  const routing = await loadRoutingHelpers();

  assert.equal(
    routing.normalizePortalUrl("//evil.example/phish", "https://portal.example", "/palzivalerts/employee"),
    "https://portal.example/palzivalerts/employee"
  );

  assert.equal(
    routing.normalizePortalUrl("/palzivalerts/hr", "https://portal.example", "/palzivalerts/employee"),
    "https://portal.example/palzivalerts/hr"
  );
});

test("service worker routing reuses only relevant app tabs", async () => {
  const routing = await loadRoutingHelpers();
  const origin = "https://portal.example";
  const clients = [
    { url: `${origin}/palzivalerts/hr` },
    { url: `${origin}/palzivalerts/employee` },
    { url: `${origin}/reports` }
  ];

  const employeeTarget = `${origin}/palzivalerts/employee`;
  const employeeClient = routing.chooseNotificationClient(clients, employeeTarget, origin);
  assert.equal(employeeClient?.url, `${origin}/palzivalerts/employee`);

  const hrTarget = `${origin}/palzivalerts/hr`;
  const hrClient = routing.chooseNotificationClient(clients, hrTarget, origin);
  assert.equal(hrClient?.url, `${origin}/palzivalerts/hr`);

  const otherTarget = `${origin}/palzivalerts/webmaster`;
  const webmasterClient = routing.chooseNotificationClient(clients, otherTarget, origin);
  assert.equal(webmasterClient, null);
});
