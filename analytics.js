import {
  isUnsafeRuntimePathError,
  readRuntimeTextFile,
  writeRuntimeJsonFileAtomic
} from "./runtime-files.js";

const DEFAULT_LIMITS = Object.freeze({
  recentRequests: 120,
  recentErrors: 40,
  recentClientEvents: 40
});

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanPath(value, maxLength) {
  const text = String(value ?? "").trim() || "/";
  return text.replace(/\s+/g, " ").slice(0, maxLength);
}

function isValidIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function ensureNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ensureCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const output = {};

  for (const [key, entryValue] of Object.entries(value)) {
    const number = Math.max(0, Math.floor(ensureNumber(entryValue, 0)));

    if (number > 0) {
      output[key] = number;
    }
  }

  return output;
}

function normalizeTotals(value = {}) {
  return {
    requests: Math.max(0, Math.floor(ensureNumber(value.requests, 0))),
    pageViews: Math.max(0, Math.floor(ensureNumber(value.pageViews, 0))),
    apiRequests: Math.max(0, Math.floor(ensureNumber(value.apiRequests, 0))),
    successfulRequests: Math.max(0, Math.floor(ensureNumber(value.successfulRequests, 0))),
    clientEvents: Math.max(0, Math.floor(ensureNumber(value.clientEvents, 0))),
    clientErrors: Math.max(0, Math.floor(ensureNumber(value.clientErrors, 0))),
    serverErrors: Math.max(0, Math.floor(ensureNumber(value.serverErrors, 0))),
    durationMs: Math.max(0, Math.round(ensureNumber(value.durationMs, 0)))
  };
}

function normalizeRequest(entry = {}) {
  const statusCode = Math.max(0, Math.floor(ensureNumber(entry.statusCode, 0)));
  const durationMs = Math.max(0, Math.round(ensureNumber(entry.durationMs, 0)));

  return {
    at: isValidIsoTimestamp(entry.at) ? entry.at : nowIso(),
    method: cleanText(entry.method || "GET", 12).toUpperCase() || "GET",
    pathname: cleanPath(entry.pathname || "/", 160),
    kind: entry.kind === "api" ? "api" : "page",
    statusCode,
    durationMs,
    userAgent: cleanText(entry.userAgent, 180),
    referer: cleanText(entry.referer, 180),
    error: cleanText(entry.error, 180)
  };
}

function normalizeError(entry = {}) {
  return {
    at: isValidIsoTimestamp(entry.at) ? entry.at : nowIso(),
    method: cleanText(entry.method || "GET", 12).toUpperCase() || "GET",
    pathname: cleanPath(entry.pathname || "/", 160),
    statusCode: Math.max(0, Math.floor(ensureNumber(entry.statusCode, 0))),
    durationMs: Math.max(0, Math.round(ensureNumber(entry.durationMs, 0))),
    error: cleanText(entry.error, 180)
  };
}

function normalizeClientEvent(entry = {}) {
  return {
    at: isValidIsoTimestamp(entry.at) ? entry.at : nowIso(),
    type: cleanText(entry.type || "client-event", 60) || "client-event",
    severity: cleanText(entry.severity || "info", 16) || "info",
    route: cleanText(entry.route || "launcher", 40) || "launcher",
    pathname: cleanPath(entry.pathname || "/", 160),
    detail: cleanText(entry.detail, 240),
    message: cleanText(entry.message, 240),
    assetVersion: cleanText(entry.assetVersion, 40),
    userAgent: cleanText(entry.userAgent, 180)
  };
}

function normalizeRequests(value, limit) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, limit).map((entry) => normalizeRequest(entry));
}

function normalizeErrors(value, limit) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, limit).map((entry) => normalizeError(entry));
}

function normalizeClientEvents(value, limit) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, limit).map((entry) => normalizeClientEvent(entry));
}

function defaultAnalyticsSnapshot() {
  const timestamp = nowIso();

  return {
    startedAt: timestamp,
    updatedAt: timestamp,
    totals: normalizeTotals(),
    byMethod: {},
    byStatus: {},
    byRoute: {},
    recentRequests: [],
    recentErrors: [],
    recentClientEvents: []
  };
}

function normalizeAnalyticsSnapshot(data, limits = DEFAULT_LIMITS) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return defaultAnalyticsSnapshot();
  }

  return {
    startedAt: isValidIsoTimestamp(data.startedAt) ? data.startedAt : nowIso(),
    updatedAt: isValidIsoTimestamp(data.updatedAt) ? data.updatedAt : nowIso(),
    totals: normalizeTotals(data.totals),
    byMethod: ensureCountMap(data.byMethod),
    byStatus: ensureCountMap(data.byStatus),
    byRoute: ensureCountMap(data.byRoute),
    recentRequests: normalizeRequests(data.recentRequests, limits.recentRequests),
    recentErrors: normalizeErrors(data.recentErrors, limits.recentErrors),
    recentClientEvents: normalizeClientEvents(data.recentClientEvents, limits.recentClientEvents)
  };
}

async function readSnapshot(filePath, limits) {
  try {
    const raw = await readRuntimeTextFile(filePath);
    const parsed = normalizeAnalyticsSnapshot(JSON.parse(raw), limits);
    const normalizedRaw = `${JSON.stringify(parsed, null, 2)}\n`;

    if (normalizedRaw !== raw) {
      await writeRuntimeJsonFileAtomic(filePath, parsed);
    }

    return parsed;
  } catch (error) {
    if (isUnsafeRuntimePathError(error)) {
      throw error;
    }

    const seed = defaultAnalyticsSnapshot();
    await writeRuntimeJsonFileAtomic(filePath, seed);
    return seed;
  }
}

function incrementCount(map, key) {
  if (!key) {
    return;
  }

  map[key] = Math.max(0, Math.floor(ensureNumber(map[key], 0))) + 1;
}

export function createAnalyticsStore({ dataFile, recentRequestLimit, recentErrorLimit, recentClientEventLimit } = {}) {
  const backend = "file";
  const limits = {
    recentRequests: recentRequestLimit || DEFAULT_LIMITS.recentRequests,
    recentErrors: recentErrorLimit || DEFAULT_LIMITS.recentErrors,
    recentClientEvents: recentClientEventLimit || DEFAULT_LIMITS.recentClientEvents
  };

  let initPromise = null;
  let writeQueue = Promise.resolve();

  async function init() {
    if (!initPromise) {
      initPromise = readSnapshot(dataFile, limits);
    }

    return initPromise;
  }

  async function flushQueue() {
    await writeQueue.catch(() => {});
  }

  async function readData() {
    await init();
    await flushQueue();
    return readSnapshot(dataFile, limits);
  }

  async function writeData(data) {
    await init();

    const next = writeQueue.then(async () => {
      const normalized = normalizeAnalyticsSnapshot(data, limits);
      await writeRuntimeJsonFileAtomic(dataFile, normalized);
      return normalized;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function updateData(mutator) {
    await init();

    const next = writeQueue.then(async () => {
      const data = await readSnapshot(dataFile, limits);
      const result = await mutator(data);
      await writeRuntimeJsonFileAtomic(dataFile, data);
      return result;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function recordRequest(entry = {}) {
    await init();

    const next = writeQueue.then(async () => {
      const data = await readSnapshot(dataFile, limits);
      const request = normalizeRequest(entry);

      data.updatedAt = request.at;
      data.totals.requests += 1;
      data.totals.durationMs += request.durationMs;

      if (request.kind === "api") {
        data.totals.apiRequests += 1;
      } else {
        data.totals.pageViews += 1;
      }

      if (request.statusCode >= 200 && request.statusCode < 400) {
        data.totals.successfulRequests += 1;
      } else if (request.statusCode >= 400 && request.statusCode < 500) {
        data.totals.clientErrors += 1;
      } else if (request.statusCode >= 500) {
        data.totals.serverErrors += 1;
      }

      incrementCount(data.byMethod, request.method);
      incrementCount(data.byStatus, String(request.statusCode));
      incrementCount(data.byRoute, request.pathname);

      data.recentRequests.unshift(request);
      data.recentRequests = data.recentRequests.slice(0, limits.recentRequests);

      if (request.statusCode >= 400 || request.error) {
        data.recentErrors.unshift(normalizeError({
          at: request.at,
          method: request.method,
          pathname: request.pathname,
          statusCode: request.statusCode,
          durationMs: request.durationMs,
          error: request.error || `HTTP ${request.statusCode}`
        }));
        data.recentErrors = data.recentErrors.slice(0, limits.recentErrors);
      }

      await writeRuntimeJsonFileAtomic(dataFile, data);
      return data;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function recordClientEvent(entry = {}) {
    await init();

    const next = writeQueue.then(async () => {
      const data = await readSnapshot(dataFile, limits);
      const clientEvent = normalizeClientEvent(entry);

      data.updatedAt = clientEvent.at;
      data.totals.clientEvents += 1;
      data.recentClientEvents.unshift(clientEvent);
      data.recentClientEvents = data.recentClientEvents.slice(0, limits.recentClientEvents);

      if (clientEvent.severity === "error" || clientEvent.type === "blank-screen") {
        data.totals.clientErrors += 1;
        data.recentErrors.unshift(normalizeError({
          at: clientEvent.at,
          method: "CLIENT",
          pathname: clientEvent.pathname,
          statusCode: 0,
          durationMs: 0,
          error: `${clientEvent.type}: ${clientEvent.detail || clientEvent.message || "Client error"}`
        }));
        data.recentErrors = data.recentErrors.slice(0, limits.recentErrors);
      }

      await writeRuntimeJsonFileAtomic(dataFile, data);
      return data;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function close() {
    await flushQueue();
  }

  return {
    backend,
    init,
    readData,
    writeData,
    updateData,
    recordRequest,
    recordClientEvent,
    close
  };
}
