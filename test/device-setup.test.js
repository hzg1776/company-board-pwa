import assert from "node:assert/strict";
import test from "node:test";

import { resolveDeviceSetupAction } from "../public/device-setup.js";

test("resolveDeviceSetupAction prefers an explicit submitter action", () => {
  assert.equal(
    resolveDeviceSetupAction({
      submitterAction: "push",
      primaryActionId: "profile"
    }),
    "push"
  );
});

test("resolveDeviceSetupAction falls back to the current primary action", () => {
  assert.equal(
    resolveDeviceSetupAction({
      submitterAction: "",
      primaryActionId: "push"
    }),
    "push"
  );

  assert.equal(
    resolveDeviceSetupAction({
      submitterAction: null,
      primaryActionId: "profile"
    }),
    "profile"
  );
});

test("resolveDeviceSetupAction defaults to profile when nothing else is available", () => {
  assert.equal(resolveDeviceSetupAction({}), "profile");
});
