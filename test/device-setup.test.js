import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDeviceSetupAction,
  resolveDeviceSetupSecondaryAction
} from "../public/device-setup.js";

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

test("employee self-unenroll uses the disable-alerts path only when the current device is enrolled", () => {
  assert.equal(resolveDeviceSetupSecondaryAction({ hasCurrentDevice: true }), "disable-alerts");
  assert.equal(resolveDeviceSetupSecondaryAction({ hasCurrentDevice: false }), null);
  assert.equal(resolveDeviceSetupSecondaryAction({}), null);
});
