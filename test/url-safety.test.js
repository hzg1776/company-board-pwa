import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRelativeAppPath } from "../url-safety.js";

test("normalizeRelativeAppPath keeps safe app-relative paths", () => {
  assert.equal(
    normalizeRelativeAppPath("/palzivalerts/employee?view=latest#post-1"),
    "/palzivalerts/employee?view=latest#post-1"
  );
});

test("normalizeRelativeAppPath rejects protocol-relative and malformed paths", () => {
  assert.equal(
    normalizeRelativeAppPath("//evil.example/phish", "/palzivalerts/employee"),
    "/palzivalerts/employee"
  );
  assert.equal(
    normalizeRelativeAppPath("/\\evil.example", "/palzivalerts/employee"),
    "/palzivalerts/employee"
  );
  assert.equal(
    normalizeRelativeAppPath("javascript:alert(1)", "/palzivalerts/employee"),
    "/palzivalerts/employee"
  );
});
