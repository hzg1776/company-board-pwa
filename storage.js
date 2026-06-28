import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isUnsafeRuntimePathError,
  readRuntimeTextFile,
  writeRuntimeJsonFileAtomic
} from "./runtime-files.js";
import { createDefaultWeather, normalizeStoredWeather } from "./weather.js";

const allowedTypes = new Set(["News", "Weather", "Shift", "Safety", "HR"]);
const allowedPriorities = new Set(["Normal", "Important", "Urgent"]);
const allowedDeliveryTargets = new Set(["feed", "alert", "both"]);
const DEFAULT_BOARD_SEED_FILE = fileURLToPath(new URL("./data/board.seed.json", import.meta.url));

function nowIso() {
  return new Date().toISOString();
}

function parseBooleanish(value) {
  return value === true || value === "true" || value === "on" || value === 1 || value === "1";
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanLongText(value, maxLength) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function isValidIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isValidExpiry(value) {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function createDefaultSeedData() {
  const now = nowIso();

  return {
    posts: [
      {
        id: "seed-weather-1",
        type: "Weather",
        priority: "Important",
        deliveryTarget: "both",
        notifyEmployees: true,
        title: "Rain expected during evening commute",
        body: "Keep walkways clear and use the south entrance if the front lot becomes congested.",
        audience: "All employees",
        author: "HR",
        createdAt: now,
        expiresAt: ""
      },
      {
        id: "seed-news-1",
        type: "News",
        priority: "Normal",
        deliveryTarget: "feed",
        notifyEmployees: false,
        title: "Open enrollment reminder",
        body: "Benefits selections are due Friday. HR is available from 10:00 AM to 3:00 PM for questions.",
        audience: "All employees",
        author: "HR",
        createdAt: now,
        expiresAt: ""
      },
      {
        id: "seed-safety-1",
        type: "Safety",
        priority: "Urgent",
        deliveryTarget: "both",
        notifyEmployees: true,
        title: "Loading dock inspection today",
        body: "Dock 2 is closed from 1:00 PM to 4:00 PM. Use Dock 1 for scheduled deliveries.",
        audience: "Operations",
        author: "HR",
        createdAt: now,
        expiresAt: ""
      }
    ],
    weather: {
      ...createDefaultWeather()
    },
    acknowledgements: []
  };
}

export function createSeedData({ seedFile = DEFAULT_BOARD_SEED_FILE } = {}) {
  if (!seedFile) {
    return createDefaultSeedData();
  }

  try {
    const raw = readFileSync(seedFile, "utf8");
    return normalizeDataShape(JSON.parse(raw));
  } catch {
    return createDefaultSeedData();
  }
}

function normalizeStoredPost(post = {}) {
  const title = cleanText(post.title, 90);
  const body = cleanLongText(post.body, 700);
  const expiresAt = cleanText(post.expiresAt, 10);
  const rawDeliveryTarget = cleanText(post.deliveryTarget, 16).toLowerCase();
  const hasExplicitDeliveryTarget = allowedDeliveryTargets.has(rawDeliveryTarget);
  const legacyNotifyEmployees =
    parseBooleanish(post.notifyEmployees) ||
    post.priority === "Important" ||
    post.priority === "Urgent";
  const deliveryTarget = hasExplicitDeliveryTarget
    ? rawDeliveryTarget
    : (legacyNotifyEmployees ? "both" : "feed");
  const notifyEmployees = deliveryTarget !== "feed";

  return {
    id: cleanText(post.id, 128) || crypto.randomUUID(),
    type: allowedTypes.has(post.type) ? post.type : "News",
    priority: allowedPriorities.has(post.priority) ? post.priority : "Normal",
    deliveryTarget,
    notifyEmployees,
    title: title || "Untitled post",
    body,
    audience: cleanText(post.audience || "All employees", 80),
    author: cleanText(post.author || "HR", 80) || "HR",
    createdAt: isValidIsoDate(post.createdAt) ? post.createdAt : nowIso(),
    expiresAt: isValidExpiry(expiresAt) ? expiresAt : ""
  };
}

function normalizeAcknowledgement(acknowledgement = {}) {
  const postId = cleanText(acknowledgement.postId, 128);
  const employeeId = cleanText(acknowledgement.employeeId, 128);
  const acknowledgedAt = cleanText(acknowledgement.acknowledgedAt, 40);

  if (!postId || !employeeId || !isValidIsoDate(acknowledgedAt)) {
    return null;
  }

  return {
    postId,
    employeeId,
    employeeName: cleanText(acknowledgement.employeeName, 120),
    username: cleanText(acknowledgement.username, 80),
    acknowledgedAt
  };
}

export function normalizeDataShape(data) {
  if (!data || typeof data !== "object") return createDefaultSeedData();

  const normalized = {
    ...data,
    posts: Array.isArray(data.posts) ? data.posts.map((post) => normalizeStoredPost(post)) : [],
    acknowledgements: Array.isArray(data.acknowledgements)
      ? data.acknowledgements.map((acknowledgement) => normalizeAcknowledgement(acknowledgement)).filter(Boolean)
      : [],
    weather: normalizeStoredWeather(data.weather)
  };

  delete normalized.settings;
  return normalized;
}

async function readFileSnapshot(dataFile, seedFile) {
  try {
    const raw = await readRuntimeTextFile(dataFile);
    const data = normalizeDataShape(JSON.parse(raw));
    const normalizedRaw = `${JSON.stringify(data, null, 2)}\n`;

    if (normalizedRaw !== raw) {
      await writeRuntimeJsonFileAtomic(dataFile, data);
    }

    return data;
  } catch (error) {
    if (isUnsafeRuntimePathError(error)) {
      throw error;
    }

    const seed = createSeedData({ seedFile });
    await writeRuntimeJsonFileAtomic(dataFile, seed);
    return seed;
  }
}

export function createBoardStore({ dataFile, seedFile } = {}) {
  const backend = "file";
  let initPromise = null;
  let writeQueue = Promise.resolve();

  async function init() {
    if (!initPromise) {
      initPromise = readFileSnapshot(dataFile, seedFile);
    }

    return initPromise;
  }

  async function readData() {
    await init();
    return readFileSnapshot(dataFile, seedFile);
  }

  async function writeData(data) {
    await init();

    const next = writeQueue.then(async () => {
      const normalized = normalizeDataShape(data);
      await writeRuntimeJsonFileAtomic(dataFile, normalized);
      return normalized;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function updateData(mutator) {
    await init();

    const next = writeQueue.then(async () => {
      const data = await readFileSnapshot(dataFile, seedFile);
      const result = await mutator(data);
      await writeRuntimeJsonFileAtomic(dataFile, data);
      return result;
    });

    writeQueue = next.catch(() => {});
    return next;
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
    close
  };
}
