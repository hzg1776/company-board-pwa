import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildNotificationPayload,
  createNotificationHub,
  normalizeNotificationState
} from "../notifications.js";

test("buildNotificationPayload prepares a safe notification payload", () => {
  const payload = buildNotificationPayload({
    id: "post-123",
    title: "System outage",
    body: "Open the employee board for details.",
    type: "Safety",
    priority: "Urgent"
  });

  const testPayload = buildNotificationPayload({
    id: "push-test",
    title: "Alert Center test push",
    body: "This is a delivery check for the current device.",
    type: "Test",
    priority: "Normal",
    url: "/palzivalerts/hr",
    tag: "alert-center-test-push",
    requireInteraction: true
  });

  assert.equal(payload.title, "System outage");
  assert.equal(payload.body, "Open the employee board for details.");
  assert.equal(payload.data.url, "/palzivalerts/employee");
  assert.equal(payload.data.postId, "post-123");
  assert.equal(payload.requireInteraction, true);
  assert.equal(payload.renotify, true);

  assert.equal(testPayload.title, "Alert Center test push");
  assert.equal(testPayload.body, "This is a delivery check for the current device.");
  assert.equal(testPayload.data.url, "/palzivalerts/hr");
  assert.equal(testPayload.tag, "alert-center-test-push");
  assert.equal(testPayload.requireInteraction, true);
});

test("createNotificationHub persists subscriptions and keys", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "company-board-push-"));
  const dataFile = path.join(tempDir, "push.json");
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    expirationTime: null,
    keys: {
      p256dh: "sample-public-key",
      auth: "sample-auth-key"
    }
  };

  try {
    const firstHub = createNotificationHub({ dataFile });
    await firstHub.init();

    const publicKey = firstHub.getPublicKey();
    assert.ok(publicKey.length > 0);

    const subscribeResult = await firstHub.subscribe(subscription);
    assert.equal(subscribeResult.totalSubscriptions, 1);

    const firstSnapshot = await firstHub.readData();
    assert.equal(firstSnapshot.subscriptions.length, 1);

    const secondHub = createNotificationHub({ dataFile });
    await secondHub.init();
    assert.equal(secondHub.getPublicKey(), publicKey);

    const secondSnapshot = await secondHub.readData();
    assert.equal(secondSnapshot.subscriptions.length, 1);
    assert.equal(secondSnapshot.subscriptions[0].endpoint, subscription.endpoint);

    const unsubscribeResult = await secondHub.unsubscribe(subscription.endpoint);
    assert.equal(unsubscribeResult.removed, true);
    assert.equal(unsubscribeResult.totalSubscriptions, 0);

    const finalSnapshot = await secondHub.readData();
    assert.equal(finalSnapshot.subscriptions.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeNotificationState strips legacy SMS data", () => {
  const normalized = normalizeNotificationState({
    vapid: {
      publicKey: "public-key",
      privateKey: "private-key"
    },
    subscriptions: [
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/device-legacy",
        expirationTime: null,
        keys: {
          p256dh: "legacy-public-key",
          auth: "legacy-auth-key"
        },
        label: "Front desk Chrome",
        browser: "Chrome",
        platform: "Windows"
      }
    ],
    smsSubscribers: [
      {
        phoneNumber: "+15555551212",
        label: "Front desk iPhone"
      }
    ]
  });

  assert.equal(normalized.subscriptions.length, 1);
  assert.equal(normalized.subscriptions[0].label, "Front desk Chrome");
  assert.equal(normalized.smsSubscribers, undefined);
});

test("createNotificationHub tracks push labels and persists push only", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "company-board-push-only-"));
  const dataFile = path.join(tempDir, "push.json");
  const hub = createNotificationHub({ dataFile });

  try {
    await hub.init();

    const pushResult = await hub.subscribe({
      endpoint: "https://fcm.googleapis.com/fcm/send/device-1",
      expirationTime: null,
      keys: {
        p256dh: "sample-public-key",
        auth: "sample-auth-key"
      },
      deviceId: "device-push-1",
      label: "Front desk Chrome",
      browser: "Chrome",
      platform: "Windows",
      userAgent: "Mozilla/5.0"
    });
    assert.equal(pushResult.totalSubscriptions, 1);

    const snapshot = await hub.readData();
    assert.equal(snapshot.subscriptions.length, 1);
    assert.equal(snapshot.subscriptions[0].label, "Front desk Chrome");
    assert.equal(snapshot.subscriptions[0].deviceId, "device-push-1");
    assert.equal(snapshot.smsSubscribers, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createNotificationHub keeps enrollment open and deduplicates subscriptions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "company-board-push-open-"));
  const dataFile = path.join(tempDir, "push.json");
  const hub = createNotificationHub({ dataFile });

  try {
    await hub.init();

    const subscribeResult = await hub.subscribe({
      endpoint: "https://fcm.googleapis.com/fcm/send/open",
      expirationTime: null,
      keys: {
        p256dh: "sample-public-key",
        auth: "sample-auth-key"
      },
      deviceId: "device-open",
      label: "Open device",
      browser: "Chrome",
      platform: "Windows"
    });

    assert.equal(subscribeResult.totalSubscriptions, 1);

    const updatedSubscription = await hub.subscribe({
      endpoint: "https://fcm.googleapis.com/fcm/send/open",
      expirationTime: null,
      keys: {
        p256dh: "sample-public-key",
        auth: "sample-auth-key"
      },
      deviceId: "device-open",
      label: "Updated device label",
      browser: "Edge",
      platform: "Windows",
      userAgent: "Mozilla/5.0"
    });

    assert.equal(updatedSubscription.totalSubscriptions, 1);

    const snapshot = await hub.readData();
    assert.equal(snapshot.subscriptions.length, 1);
    assert.equal(snapshot.subscriptions[0].label, "Updated device label");
    assert.equal(snapshot.subscriptions[0].browser, "Edge");
    assert.equal("accessPin" in snapshot, false);
    assert.equal("accessPinVersion" in snapshot.subscriptions[0], false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createNotificationHub rejects untrusted push endpoints", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "company-board-push-invalid-"));
  const dataFile = path.join(tempDir, "push.json");
  const hub = createNotificationHub({ dataFile });

  try {
    await hub.init();
    await assert.rejects(
      hub.subscribe({
        endpoint: "https://attacker.example.com/push",
        expirationTime: null,
        keys: {
          p256dh: "sample-public-key",
          auth: "sample-auth-key"
        }
      }),
      /Invalid push subscription\./
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
