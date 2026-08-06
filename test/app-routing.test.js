import assert from "node:assert/strict";
import test from "node:test";

import { requiresInstallProfileReload } from "../public/app-routing.js";

test("route changes reload the document only when the install profile changes", () => {
  const expectations = [
    { current: "launcher", next: "employee", expected: false },
    { current: "employee", next: "launcher", expected: false },
    { current: "webmaster", next: "it", expected: false },
    { current: "launcher", next: "hr", expected: true },
    { current: "employee", next: "hr", expected: true },
    { current: "webmaster", next: "hr", expected: true },
    { current: "hr", next: "launcher", expected: true },
    { current: "hr", next: "employee", expected: true },
    { current: "hr", next: "hr", expected: false }
  ];

  for (const expectation of expectations) {
    assert.equal(
      requiresInstallProfileReload(expectation.current, expectation.next),
      expectation.expected,
      `${expectation.current} -> ${expectation.next}`
    );
  }
});
