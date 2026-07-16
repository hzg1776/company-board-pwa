import assert from "node:assert/strict";
import test from "node:test";

import * as deviceSetup from "../public/device-setup.js";

const {
  resolveDeviceSetupAction,
  resolveDeviceSetupSecondaryAction
} = deviceSetup;

test("only iOS requires standalone mode before push setup is complete", () => {
  const samsungInternet = "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
  const pixelChrome = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36";
  const iphoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

  assert.equal(deviceSetup.requiresStandaloneForPush?.(samsungInternet), false);
  assert.equal(deviceSetup.requiresStandaloneForPush?.(pixelChrome), false);
  assert.equal(deviceSetup.requiresStandaloneForPush?.(iphoneSafari), true);
});

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
