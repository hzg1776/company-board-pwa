import crypto from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const webpush = require("web-push");

const DEFAULT_SUBJECT = process.env.PUSH_VAPID_SUBJECT || "mailto:alerts@example.com";
const DEFAULT_TITLE = "Palziv alert";
const DEFAULT_BODY = "Open the Palziv portal for details.";
const DEFAULT_URL = "/palzivalerts/employee";
const DEFAULT_ICON = "/assets/palziv-logo-transparent.png?v=20260617c";

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function buildDeviceLabel(input = {}) {
  const browser = cleanText(input.browser, 40);
  const platform = cleanText(input.platform, 40);
  const labelHint = cleanText(input.label, 80);

  if (labelHint) {
    return labelHint;
  }

  if (browser && platform) {
    return `${browser} on ${platform}`;
  }

  if (browser) {
    return browser;
  }

  if (platform) {
    return platform;
  }

  const deviceId = cleanText(input.deviceId, 32);
  return `Push ${deviceId ? deviceId.slice(0, 8) : "device"}`;
}

function normalizeDeviceMetadata(input = {}, channel = "push") {
  const createdAt = cleanText(input.createdAt, 40) || nowIso();
  const updatedAt = cleanText(input.updatedAt, 40) || createdAt;
  const deviceId = cleanText(input.deviceId, 80) || crypto.randomUUID();

  return {
    channel,
    deviceId,
    label: buildDeviceLabel(input),
    employeeId: cleanText(input.employeeId, 80),
    employeeName: cleanText(input.employeeName, 120),
    username: cleanText(input.username, 80),
    authorized: input.authorized !== false,
    browser: cleanText(input.browser, 60),
    platform: cleanText(input.platform, 60),
    userAgent: cleanText(input.userAgent, 240),
    createdAt,
    updatedAt
  };
}

function safeRelativeUrl(value, fallback = DEFAULT_URL) {
  const text = cleanText(value, 200);

  if (!text || !text.startsWith("/")) {
    return fallback;
  }

  return text;
}

function normalizeSubscription(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const source = input.subscription && typeof input.subscription === "object" ? input.subscription : input;
  const endpoint = cleanText(source.endpoint, 2048);
  const keys = source.keys && typeof source.keys === "object" ? source.keys : {};
  const p256dh = cleanText(keys.p256dh, 512);
  const auth = cleanText(keys.auth, 512);

  if (!endpoint || !p256dh || !auth) {
    return null;
  }

  return {
    endpoint,
    expirationTime: Number.isFinite(source.expirationTime) ? source.expirationTime : null,
    keys: {
      p256dh,
      auth
    },
    ...normalizeDeviceMetadata(input, "push")
  };
}

function dedupeSubscriptions(subscriptions) {
  const map = new Map();

  for (const subscription of subscriptions) {
    if (subscription?.endpoint) {
      map.set(subscription.endpoint, subscription);
    }
  }

  return [...map.values()];
}

function hasEmployeeBinding(subscription) {
  return Boolean(cleanText(subscription?.employeeId, 80));
}

function normalizeVapidKeys(input) {
  const publicKey = cleanText(input?.publicKey, 512);
  const privateKey = cleanText(input?.privateKey, 512);

  if (publicKey && privateKey) {
    return {
      publicKey,
      privateKey
    };
  }

  return webpush.generateVAPIDKeys();
}

export function createDefaultNotificationState() {
  return {
    vapid: webpush.generateVAPIDKeys(),
    subscriptions: []
  };
}

export function normalizeNotificationState(input) {
  if (!input || typeof input !== "object") {
    return createDefaultNotificationState();
  }

  const subscriptions = Array.isArray(input.subscriptions)
    ? dedupeSubscriptions(
        input.subscriptions
          .map((subscription) => normalizeSubscription(subscription))
          .filter(Boolean)
      )
    : [];

  return {
    vapid: normalizeVapidKeys(input.vapid),
    subscriptions
  };
}

function normalizeNotificationPath(value, fallback = DEFAULT_URL) {
  return safeRelativeUrl(value, fallback);
}

async function ensureDirectory(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function writeFileAtomic(filePath, data) {
  await ensureDirectory(filePath);
  const tempFile = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

async function readFileSnapshot(filePath) {
  await ensureDirectory(filePath);

  try {
    const raw = await readFile(filePath, "utf8");
    const data = normalizeNotificationState(JSON.parse(raw));
    const normalizedRaw = `${JSON.stringify(data, null, 2)}\n`;

    if (normalizedRaw !== raw) {
      await writeFileAtomic(filePath, data);
    }

    return data;
  } catch {
    const seed = createDefaultNotificationState();
    await writeFileAtomic(filePath, seed);
    return seed;
  }
}

function setVapidDetails(state, subject = DEFAULT_SUBJECT) {
  webpush.setVapidDetails(subject, state.vapid.publicKey, state.vapid.privateKey);
}

function isRecoverableSubscriptionError(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const message = cleanText(error?.message || "", 200).toLowerCase();

  return statusCode === 404 || statusCode === 410 || message.includes("not found") || message.includes("gone");
}

function isSubscriptionAuthorized(subscription) {
  return hasEmployeeBinding(subscription) && subscription?.authorized !== false;
}

export function buildNotificationPayload(notification = {}) {
  const title = cleanText(notification.title, 80) || DEFAULT_TITLE;
  const body = cleanText(notification.body ?? notification.message, 280) || DEFAULT_BODY;
  const priority = cleanText(notification.priority, 20);
  const type = cleanText(notification.type, 30);
  const url = normalizeNotificationPath(notification.url, DEFAULT_URL);
  const tag = cleanText(notification.tag || notification.id || `${type}-${priority}`, 120) || "palziv-alert";
  const requireInteraction = Boolean(notification.requireInteraction) || priority === "Urgent";

  return {
    title,
    body,
    icon: DEFAULT_ICON,
    badge: DEFAULT_ICON,
    tag,
    renotify: requireInteraction,
    requireInteraction,
    data: {
      url,
      postId: cleanText(notification.id, 128),
      type,
      priority,
      createdAt: notification.createdAt || nowIso()
    }
  };
}

export function createNotificationHub({ dataFile, subject = DEFAULT_SUBJECT } = {}) {
  if (!dataFile) {
    throw new Error("Notification data file is required.");
  }

  const backend = "file";
  let initPromise = null;
  let writeQueue = Promise.resolve();
  let state = null;

  async function init() {
    if (!initPromise) {
      initPromise = readFileSnapshot(dataFile).then((snapshot) => {
        state = snapshot;
        setVapidDetails(state, subject);
        return state;
      });
    }

    return initPromise;
  }

  function ensureInitialized() {
    if (!state) {
      throw new Error("Notification hub has not been initialized.");
    }
  }

  function getPublicKey() {
    ensureInitialized();
    return state.vapid.publicKey;
  }

  async function readData() {
    await init();
    return readFileSnapshot(dataFile);
  }

  async function writeData(nextState) {
    await init();

    const next = writeQueue.then(async () => {
      state = normalizeNotificationState(nextState);
      setVapidDetails(state, subject);
      await writeFileAtomic(dataFile, state);
      return state;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function updateData(mutator) {
    await init();

    const next = writeQueue.then(async () => {
      const snapshot = await readFileSnapshot(dataFile);
      const result = await mutator(snapshot);
      state = normalizeNotificationState(snapshot);
      setVapidDetails(state, subject);
      await writeFileAtomic(dataFile, state);
      return result;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function subscribe(subscriptionInput) {
    const subscription = normalizeSubscription(subscriptionInput);

    if (!subscription) {
      throw new Error("Invalid push subscription.");
    }

    return updateData((data) => {
      data.subscriptions = dedupeSubscriptions([
        subscription,
        ...data.subscriptions.filter((entry) => entry.endpoint !== subscription.endpoint)
      ]);

      return {
        subscription,
        totalSubscriptions: data.subscriptions.length
      };
    });
  }

  async function unsubscribe(endpointInput) {
    const endpoint = cleanText(endpointInput, 2048);

    if (!endpoint) {
      throw new Error("Subscription endpoint is required.");
    }

    return updateData((data) => {
      const originalLength = data.subscriptions.length;
      data.subscriptions = data.subscriptions.filter((entry) => entry.endpoint !== endpoint);

      return {
        removed: data.subscriptions.length !== originalLength,
        totalSubscriptions: data.subscriptions.length
      };
    });
  }

  async function broadcast(notificationInput) {
    await init();

    const payload = buildNotificationPayload(notificationInput);
    const body = JSON.stringify(payload);
    const snapshot = await readData();
    const activeSubscriptions = snapshot.subscriptions.filter((subscription) => isSubscriptionAuthorized(subscription));

    if (!activeSubscriptions.length) {
      return {
        total: snapshot.subscriptions.length,
        authorized: 0,
        delivered: 0,
        failed: 0,
        skipped: snapshot.subscriptions.length,
        removed: 0
      };
    }

    const deliveries = await Promise.allSettled(
      activeSubscriptions.map(async (subscription) => {
        await webpush.sendNotification(subscription, body);
        return subscription.endpoint;
      })
    );

    const invalidEndpoints = [];
    let delivered = 0;

    deliveries.forEach((result, index) => {
      if (result.status === "fulfilled") {
        delivered += 1;
        return;
      }

      const subscription = activeSubscriptions[index];
      console.error("[push] delivery failed", {
        employeeId: subscription?.employeeId || "",
        username: subscription?.username || "",
        label: subscription?.label || "",
        endpointHost: (() => {
          try {
            return new URL(String(subscription?.endpoint || "")).host;
          } catch {
            return "";
          }
        })(),
        statusCode: Number(result.reason?.statusCode || result.reason?.status || 0) || null,
        message: cleanText(result.reason?.message || result.reason?.body || "", 240)
      });

      if (isRecoverableSubscriptionError(result.reason)) {
        invalidEndpoints.push(activeSubscriptions[index].endpoint);
      }
    });

    if (invalidEndpoints.length) {
      await updateData((data) => {
        data.subscriptions = data.subscriptions.filter((subscription) => !invalidEndpoints.includes(subscription.endpoint));
        return null;
      });
    }

    return {
      total: snapshot.subscriptions.length,
      authorized: activeSubscriptions.length,
      delivered,
      failed: activeSubscriptions.length - delivered,
      skipped: snapshot.subscriptions.length - activeSubscriptions.length,
      removed: invalidEndpoints.length
    };
  }

  async function close() {
    return undefined;
  }

  return {
    backend,
    init,
    readData,
    writeData,
    updateData,
    subscribe,
    unsubscribe,
    broadcast,
    getPublicKey,
    close
  };
}

