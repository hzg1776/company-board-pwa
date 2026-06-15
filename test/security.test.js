import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSecurityStore } from "../security.js";

function cookiePair(setCookieHeader) {
  return String(setCookieHeader || "").split(";")[0];
}

test("createSecurityStore persists browser approval and binds it to the approved browser", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-"));
  const dataFile = path.join(tempDir, "security.json");
  const previousAdminPassword = process.env.ADMIN_PASSWORD;
  const previousHrPin = process.env.HR_PIN;
  const previousSessionSecret = process.env.SESSION_SECRET;
  const approvedUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0 Safari/537.36";

  delete process.env.ADMIN_PASSWORD;
  delete process.env.HR_PIN;
  process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";

  try {
    const firstStore = createSecurityStore({ dataFile });
    await firstStore.init();

    const bootstrapPin = firstStore.getBootstrapHrPin();
    assert.match(bootstrapPin, /^\d{4}-\d{4}$/);

    const lockedHr = await firstStore.checkHrAccess({ headers: {} });
    assert.equal(lockedHr.authorized, false);
    assert.equal(lockedHr.pinRequired, true);

    const unlockedHr = await firstStore.unlockHrAccess({ headers: {} }, bootstrapPin);
    assert.equal(unlockedHr.authorized, true);
    assert.match(unlockedHr.setCookie, /^palziv_hr_auth=/);
    assert.ok(unlockedHr.csrfToken);

    const hrCookie = cookiePair(unlockedHr.setCookie);
    const unlockedStatus = await firstStore.checkHrAccess({ headers: { cookie: hrCookie } });
    assert.equal(unlockedStatus.authorized, true);
    assert.equal(unlockedStatus.pinVersion, 1);

    const approved = await firstStore.approveWebmasterAccess(
      {
        headers: {
          cookie: hrCookie,
          "user-agent": approvedUserAgent
        }
      },
      {
        label: "Office Chrome",
        browser: "Chrome",
        platform: "Windows",
        userAgent: approvedUserAgent
      }
    );

    assert.equal(approved.authorized, true);
    assert.match(approved.setCookie, /^palziv_webmaster_auth=/);
    assert.ok(approved.csrfToken);

    const webmasterCookie = cookiePair(approved.setCookie);
    const webmasterStatus = await firstStore.checkWebmasterAccess({
      headers: {
        cookie: webmasterCookie,
        "user-agent": approvedUserAgent
      }
    });
    assert.equal(webmasterStatus.authorized, true);
    assert.equal(webmasterStatus.hrAuthorized, false);
    assert.equal(webmasterStatus.approvedBrowser.label, "Office Chrome");
    assert.equal(webmasterStatus.browserBound, true);

    const restartedStore = createSecurityStore({ dataFile });
    await restartedStore.init();

    const persistedState = await restartedStore.readData();
    assert.equal(persistedState.webmaster?.label, "Office Chrome");

    const persistedStatus = await restartedStore.checkWebmasterAccess({
      headers: {
        cookie: webmasterCookie,
        "user-agent": approvedUserAgent
      }
    });
    assert.equal(persistedStatus.authorized, true);
    assert.equal(persistedStatus.approvedBrowser.label, "Office Chrome");

    const revoked = await restartedStore.lockWebmasterAccess({
      headers: {
        cookie: hrCookie,
        "user-agent": approvedUserAgent
      }
    });
    assert.equal(revoked.authorized, false);
    assert.match(revoked.setCookie, /^palziv_webmaster_auth=/);

    const revokedStatus = await restartedStore.checkWebmasterAccess({
      headers: {
        cookie: webmasterCookie,
        "user-agent": approvedUserAgent
      }
    });
    assert.equal(revokedStatus.authorized, false);
    assert.equal(revokedStatus.browserBound, false);
  } finally {
    if (previousAdminPassword === undefined) {
      delete process.env.ADMIN_PASSWORD;
    } else {
      process.env.ADMIN_PASSWORD = previousAdminPassword;
    }

    if (previousHrPin === undefined) {
      delete process.env.HR_PIN;
    } else {
      process.env.HR_PIN = previousHrPin;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = previousSessionSecret;
    }

    await rm(tempDir, { recursive: true, force: true });
  }
});
