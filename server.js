import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { createAnalyticsStore } from "./analytics.js";
import { createNotificationHub } from "./notifications.js";
import { createBoardStore } from "./storage.js";
import { createSecurityStore } from "./security.js";
import { resolveLiveWeather } from "./weather.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML_TEMPLATE_PATH = path.join(PUBLIC_DIR, "index.html");
const SERVICE_WORKER_TEMPLATE_PATH = path.join(PUBLIC_DIR, "sw.js");
const APP_BASE_PATH = "/palzivalerts";
const CONFIGURED_ASSET_VERSION = String(process.env.ASSET_VERSION || "")
  .replace(/[^a-zA-Z0-9._-]/g, "")
  .slice(0, 40);
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(__dirname, "data", "board.json");
const PUSH_DATA_FILE = process.env.PUSH_DATA_FILE ? path.resolve(process.env.PUSH_DATA_FILE) : path.join(__dirname, "data", "push.json");
const ANALYTICS_DATA_FILE = process.env.ANALYTICS_DATA_FILE ? path.resolve(process.env.ANALYTICS_DATA_FILE) : path.join(__dirname, "data", "analytics.json");
const SECURITY_DATA_FILE = process.env.SECURITY_DATA_FILE ? path.resolve(process.env.SECURITY_DATA_FILE) : path.join(__dirname, "data", "security.json");
const ADMIN_SETUP_TOKEN = String(process.env.ADMIN_SETUP_TOKEN || "");
const ADMIN_RECOVERY_TOKEN = String(process.env.ADMIN_RECOVERY_TOKEN || process.env.ADMIN_SETUP_TOKEN || "");
const ADMIN_DAILY_RECOVERY_SEED = String(process.env.ADMIN_DAILY_RECOVERY_SEED || "");
const HR_RECOVERY_EMAIL = String(process.env.HR_RECOVERY_EMAIL || "");
const RECOVERY_EMAIL_FROM = String(process.env.RECOVERY_EMAIL_FROM || process.env.EMAIL_FROM || "");
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "");
const CONFIGURED_PUBLIC_BASE_URL = parseRequiredPublicBaseUrl(process.env.PUBLIC_BASE_URL);
const TRUST_PROXY_ADDRESSES = parseTrustedProxyAddresses(process.env.TRUST_PROXY_ADDRESSES || "");
const RECOVERY_TIME_ZONE = "America/New_York";
const MAX_BODY_BYTES = 1_000_000;
const EMPLOYEE_SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const DEFAULT_SITE_CONFIG = Object.freeze({
  name: "Palziv",
  nameSuffix: "",
  shortName: "Palziv",
  subtitle: "Updates & Alerts Portal",
  description: "Updates and alerts portal for Palziv with HR-managed company news, weather, and push notifications.",
  themeColor: "#1b2329",
  backgroundColor: "#f4f8fb"
});

function readSiteConfig() {
  const name = cleanText(process.env.SITE_NAME, 80) || DEFAULT_SITE_CONFIG.name;
  const nameSuffix = cleanText(process.env.SITE_NAME_SUFFIX, 16) || DEFAULT_SITE_CONFIG.nameSuffix;
  const shortName = cleanText(process.env.SITE_SHORT_NAME, 24) || DEFAULT_SITE_CONFIG.shortName;
  const subtitle = cleanText(process.env.SITE_SUBTITLE, 120) || DEFAULT_SITE_CONFIG.subtitle;
  const description = cleanText(process.env.SITE_DESCRIPTION, 180) || DEFAULT_SITE_CONFIG.description;
  const themeColor = cleanText(process.env.SITE_THEME_COLOR, 20) || DEFAULT_SITE_CONFIG.themeColor;
  const backgroundColor = cleanText(process.env.SITE_BACKGROUND_COLOR, 20) || DEFAULT_SITE_CONFIG.backgroundColor;

  return {
    name,
    nameSuffix,
    shortName,
    subtitle,
    description,
    themeColor,
    backgroundColor
  };
}

const siteConfig = readSiteConfig();
const indexHtmlTemplate = await readFile(INDEX_HTML_TEMPLATE_PATH, "utf8");
const serviceWorkerTemplate = await readFile(SERVICE_WORKER_TEMPLATE_PATH, "utf8");
const assetVersionSeed = await Promise.all([
  stat(path.join(PUBLIC_DIR, "app.js")),
  stat(path.join(PUBLIC_DIR, "styles.css")),
  stat(INDEX_HTML_TEMPLATE_PATH),
  stat(SERVICE_WORKER_TEMPLATE_PATH)
])
  .then((stats) => Math.round(Math.max(...stats.map((fileStat) => fileStat.mtimeMs))).toString(36))
  .catch(() => "dev");
const ASSET_VERSION = CONFIGURED_ASSET_VERSION || assetVersionSeed;

const allowedTypes = new Set(["News", "Weather", "Shift", "Safety", "HR"]);
const allowedPriorities = new Set(["Normal", "Important", "Urgent"]);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"]
]);

const boardStore = createBoardStore({
  dataFile: DATA_FILE
});
const notificationHub = createNotificationHub({
  dataFile: PUSH_DATA_FILE
});
const analyticsStore = createAnalyticsStore({
  dataFile: ANALYTICS_DATA_FILE
});
const securityStore = createSecurityStore({
  dataFile: SECURITY_DATA_FILE
});

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function timingSafeTextMatch(expectedValue, providedValue) {
  const expectedText = String(expectedValue || "");
  if (!expectedText) {
    return false;
  }

  const expected = Buffer.from(expectedText, "utf8");
  const provided = Buffer.from(String(providedValue || ""), "utf8");
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function recoveryDateStamp(baseDate = new Date(), dayOffset = 0) {
  const shiftedDate = new Date(baseDate.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: RECOVERY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(shiftedDate);
  const lookup = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return `${lookup.year}${lookup.month}${lookup.day}`;
}

function buildDailyAdminRecoveryToken(baseDate = new Date(), dayOffset = 0) {
  if (!ADMIN_DAILY_RECOVERY_SEED) {
    return "";
  }

  const stamp = recoveryDateStamp(baseDate, dayOffset);
  const digest = crypto
    .createHmac("sha256", ADMIN_DAILY_RECOVERY_SEED)
    .update(`palziv-admin-recovery:${stamp}`)
    .digest("hex")
    .toUpperCase()
    .slice(0, 12);
  const blocks = digest.match(/.{1,4}/g) || [digest];
  return `PALZIV-${stamp.slice(2)}-${blocks.join("-")}`;
}

function matchesAdminSetupToken(value) {
  return timingSafeTextMatch(ADMIN_SETUP_TOKEN, value);
}

function matchesAdminRecoveryToken(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return false;
  }

  if (timingSafeTextMatch(ADMIN_RECOVERY_TOKEN, normalizedValue)) {
    return true;
  }

  return [0, -1].some((dayOffset) => timingSafeTextMatch(buildDailyAdminRecoveryToken(new Date(), dayOffset), normalizedValue));
}

function maskEmailAddress(value) {
  const email = cleanText(value, 200);
  const [local, domain] = email.split("@");
  if (!local || !domain) return "";
  const visibleLocal = local.length <= 2 ? `${local[0] || ""}*` : `${local.slice(0, 2)}***`;
  const [domainName, ...domainParts] = domain.split(".");
  const visibleDomain = `${(domainName || "").slice(0, 1)}***`;
  return `${visibleLocal}@${visibleDomain}${domainParts.length ? `.${domainParts.join(".")}` : ""}`;
}

async function sendRecoveryEmail({ to, code, expiresAt } = {}) {
  if (!RESEND_API_KEY || !RECOVERY_EMAIL_FROM || !to) {
    throw createHttpError(503, "Email recovery is not configured.");
  }

  const subject = `${displayBrandName(siteConfig)} HR recovery code`;
  const expires = new Date(expiresAt || Date.now()).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: RECOVERY_TIME_ZONE
  });
  const brandName = displayBrandName(siteConfig);
  const text = [
    `${brandName} HR recovery code`,
    ``,
    `Code: ${code}`,
    `Expires: ${expires} Eastern Time`,
    ``,
    `If you did not request this, ignore this email.`
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RECOVERY_EMAIL_FROM,
      to: [to],
      subject,
      text,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#141a1f"><p><strong>${escapeHtml(brandName)}</strong> HR recovery code</p><p style="font-size:28px;font-weight:700;letter-spacing:0.08em">${escapeHtml(code)}</p><p>Expires: ${escapeHtml(expires)} Eastern Time</p><p>If you did not request this, ignore this email.</p></div>`
    })
  });

  if (!response.ok) {
    throw createHttpError(502, "Could not send the recovery email.");
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[character];
  });
}

function serializeForScript(value) {
  return JSON.stringify(value).replace(/[<>&]/g, (character) => {
    const replacements = {
      "<": "\\u003c",
      ">": "\\u003e",
      "&": "\\u0026"
    };
    return replacements[character] || character;
  });
}

function appPath(...segments) {
  const parts = [APP_BASE_PATH];

  for (const segment of segments) {
    const cleanSegment = String(segment ?? "").replace(/^\/+|\/+$/g, "");

    if (cleanSegment) {
      parts.push(cleanSegment);
    }
  }

  return parts.join("/").replace(/\/+/g, "/") || APP_BASE_PATH;
}

function isSecureRequest(req) {
  return requestProtocol(req) === "https" || CONFIGURED_PUBLIC_BASE_URL.startsWith("https://");
}

function serializeCookie(name, value, options = {}) {
  const attributes = [
    `${name}=${encodeURIComponent(String(value || ""))}`,
    `Path=${options.path || APP_BASE_PATH}`,
    `SameSite=${options.sameSite || "Lax"}`
  ];

  if (typeof options.maxAge === "number") {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }

  if (options.httpOnly !== false) {
    attributes.push("HttpOnly");
  }

  if (options.secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function redirectTo(res, location) {
  res.writeHead(308, {
    Location: location,
    "Cache-Control": "no-store"
  });
  res.end(`Redirecting to ${location}`);
}

function displayBrandName(config = siteConfig) {
  const name = cleanText(config.name, 80) || DEFAULT_SITE_CONFIG.name;
  const suffix = cleanText(config.nameSuffix, 16) || "";
  return suffix ? `${name} ${suffix}` : name;
}

function countBy(items, selector) {
  const counts = {};

  for (const item of items || []) {
    const key = selector(item);

    if (!key) {
      continue;
    }

    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

function sortCountEntries(counts, limit = 10) {
  return Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

function summarizeNotificationDevices(pushData = {}) {
  const pushDevices = Array.isArray(pushData.subscriptions)
    ? pushData.subscriptions.map((subscription) => {
        const hasEmployeeBinding = Boolean(cleanText(subscription.employeeId, 80));
        const authorized = hasEmployeeBinding && subscription.authorized !== false;

        return {
          id: subscription.deviceId || subscription.endpoint,
          endpoint: subscription.endpoint,
          channel: "push",
          label: subscription.employeeName || subscription.label || "Push device",
          detail: [
            subscription.username ? `Account ${subscription.username}` : "",
            [subscription.browser, subscription.platform].filter(Boolean).join(" on ")
          ].filter(Boolean).join(" • ") || "Push subscription",
          createdAt: subscription.createdAt || "",
          updatedAt: subscription.updatedAt || subscription.createdAt || "",
          accessState: !hasEmployeeBinding ? "Unbound" : subscription.authorized === false ? "Revoked" : "Active",
          authorized
        };
      })
    : [];

  return [...pushDevices].sort((a, b) => {
    const accessSort = Number(b.authorized) - Number(a.authorized);

    if (accessSort) {
      return accessSort;
    }

    return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
  });
}

function isPostExpired(post) {
  if (!post?.expiresAt) {
    return false;
  }

  const endOfDay = new Date(`${post.expiresAt}T23:59:59`);
  return endOfDay < new Date();
}

function isExpiringSoon(post, days = 7) {
  if (!post?.expiresAt || isPostExpired(post)) {
    return false;
  }

  const endOfDay = new Date(`${post.expiresAt}T23:59:59`);
  if (Number.isNaN(endOfDay.getTime())) {
    return false;
  }

  const daysRemaining = (endOfDay.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return daysRemaining <= days;
}

function summarizeBoard(boardData = {}) {
  const posts = Array.isArray(boardData.posts)
    ? [...boardData.posts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    : [];
  const activePosts = posts.filter((post) => !isPostExpired(post));
  const weather = boardData.weather || {};
  const latestPost = posts[0] || null;

  return {
    totalPosts: posts.length,
    activePosts: activePosts.length,
    expiredPosts: posts.length - activePosts.length,
    urgentPosts: activePosts.filter((post) => post.priority === "Urgent").length,
    importantPosts: activePosts.filter((post) => post.priority === "Important").length,
    alertPosts: posts.filter((post) => post.notifyEmployees).length,
    expiringSoon: activePosts.filter((post) => isExpiringSoon(post)).length,
    byType: sortCountEntries(countBy(posts, (post) => post.type || "Unknown")),
    byPriority: sortCountEntries(countBy(posts, (post) => post.priority || "Normal")),
    byAudience: sortCountEntries(countBy(posts, (post) => post.audience || "All employees"), 6),
    latestPost: latestPost
      ? {
          id: latestPost.id,
          title: latestPost.title,
          type: latestPost.type,
          priority: latestPost.priority,
          createdAt: latestPost.createdAt,
          expiresAt: latestPost.expiresAt,
          audience: latestPost.audience,
          notifyEmployees: Boolean(latestPost.notifyEmployees)
        }
      : null,
    recentPosts: posts.slice(0, 5).map((post) => ({
      id: post.id,
      title: post.title,
      type: post.type,
      priority: post.priority,
      createdAt: post.createdAt,
      expiresAt: post.expiresAt,
      audience: post.audience,
      notifyEmployees: Boolean(post.notifyEmployees),
      expired: isPostExpired(post)
    })),
    weather: {
      condition: weather.condition || "Weather not configured",
      temperature: weather.temperature || "--",
      level: weather.level || "Clear",
      location: weather.location || "",
      resolvedName: weather.resolvedName || "",
      updatedAt: weather.updatedAt || ""
    }
  };
}

function summarizeTraffic(analyticsData = {}) {
  const totals = analyticsData.totals || {};
  const requests = Math.max(0, Number(totals.requests || 0));
  const durationMs = Math.max(0, Number(totals.durationMs || 0));

  return {
    totals: {
      requests,
      pageViews: Math.max(0, Number(totals.pageViews || 0)),
      apiRequests: Math.max(0, Number(totals.apiRequests || 0)),
      successfulRequests: Math.max(0, Number(totals.successfulRequests || 0)),
      clientErrors: Math.max(0, Number(totals.clientErrors || 0)),
      serverErrors: Math.max(0, Number(totals.serverErrors || 0)),
      averageDurationMs: requests > 0 ? Math.round(durationMs / requests) : 0
    },
    byMethod: sortCountEntries(analyticsData.byMethod || {}),
    byStatus: sortCountEntries(analyticsData.byStatus || {}),
    byRoute: sortCountEntries(analyticsData.byRoute || {}, 12),
    recentRequests: Array.isArray(analyticsData.recentRequests) ? analyticsData.recentRequests.slice(0, 12) : [],
    recentErrors: Array.isArray(analyticsData.recentErrors) ? analyticsData.recentErrors.slice(0, 8) : []
  };
}

function summarizeServerRuntime() {
  const memory = process.memoryUsage();

  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cpuCount: os.cpus().length,
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    port: PORT,
    boardStorage: boardStore.backend,
    pushStorage: notificationHub.backend || "file",
    analyticsStorage: analyticsStore.backend,
    securityStorage: securityStore.backend,
    dataFiles: {
      board: path.basename(DATA_FILE),
      push: path.basename(PUSH_DATA_FILE),
      analytics: path.basename(ANALYTICS_DATA_FILE),
      security: path.basename(SECURITY_DATA_FILE)
    },
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      externalMb: Math.round(memory.external / 1024 / 1024)
    },
    publicBaseUrl: process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, "") : ""
  };
}

function buildWebmasterSummary({ boardData, pushData, analyticsData, securityRuntime, baseUrl }) {
  const board = summarizeBoard(boardData);
  const traffic = summarizeTraffic(analyticsData);
  const pushSubscriptions = Array.isArray(pushData?.subscriptions) ? pushData.subscriptions.length : 0;
  const origin = baseUrl.replace(/\/+$/, "");
  const base = `${origin}${APP_BASE_PATH}`;
  const devices = summarizeNotificationDevices(pushData);
  const activeSubscriptions = devices.filter((device) => device.authorized).length;

  return {
    generatedAt: nowIso(),
    server: summarizeServerRuntime(),
    board: {
      ...board,
      pushSubscriptions
    },
    notifications: {
      pushSubscriptions,
      activeSubscriptions,
      inactiveSubscriptions: Math.max(0, devices.length - activeSubscriptions),
      devices
    },
    security: securityRuntime || { accessModel: "open" },
    traffic,
    urls: {
      base,
      origin,
      launcher: base,
      employee: `${base}/employee`,
      hr: `${base}/hr`,
      webmaster: `${base}/webmaster`,
      adminAlias: `${base}/admin`
    }
  };
}

function renderIndexHtml() {
  return indexHtmlTemplate
    .replaceAll("__SITE_NAME__", escapeHtml(displayBrandName(siteConfig)))
    .replaceAll("__SITE_SHORT_NAME__", escapeHtml(siteConfig.shortName))
    .replaceAll("__SITE_SUBTITLE__", escapeHtml(siteConfig.subtitle))
    .replaceAll("__SITE_DESCRIPTION__", escapeHtml(siteConfig.description))
    .replaceAll("__SITE_THEME_COLOR__", escapeHtml(siteConfig.themeColor))
    .replaceAll("__SITE_BACKGROUND_COLOR__", escapeHtml(siteConfig.backgroundColor))
    .replaceAll("__ASSET_VERSION__", escapeHtml(ASSET_VERSION))
    .replace("<!-- BOARD_CONFIG -->", `<script>window.__BOARD_CONFIG__ = ${serializeForScript({
      ...siteConfig,
      assetVersion: ASSET_VERSION
    })};</script>`);
}

function renderServiceWorker() {
  return serviceWorkerTemplate.replaceAll("__ASSET_VERSION__", ASSET_VERSION);
}

function sendIndexHtml(res) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(renderIndexHtml());
}

function sendServiceWorker(res) {
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(renderServiceWorker());
}

function sendManifest(res) {
  const icon = {
      src: "/assets/palziv-logo-transparent.png?v=20260617c",
    sizes: "1054x1055",
    type: "image/png",
    purpose: "any maskable"
  };

  const manifest = {
    name: displayBrandName(siteConfig),
    short_name: siteConfig.shortName,
    description: siteConfig.description,
    start_url: appPath(),
    scope: `${APP_BASE_PATH}/`,
    display: "standalone",
    background_color: siteConfig.backgroundColor,
    theme_color: siteConfig.themeColor,
    orientation: "portrait-primary",
    shortcuts: [
      {
        name: "Launcher",
        short_name: "Home",
        description: "Open the Palziv Alerts launcher",
        url: appPath(),
        icons: [icon]
      },
      {
        name: "Employee Feed",
        short_name: "Feed",
        description: "Open the employee feed",
        url: appPath("employee"),
        icons: [icon]
      },
      {
        name: "HR Console",
        short_name: "HR",
        description: "Open the HR publishing console",
        url: appPath("hr"),
        icons: [icon]
      },
      {
        name: "Webmaster",
        short_name: "Web",
        description: "Open analytics and site diagnostics",
        url: appPath("webmaster"),
        icons: [icon]
      }
    ],
    icons: [icon]
  };

  res.writeHead(200, {
    "Content-Type": "application/manifest+json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(manifest));
}

function normalizeRemoteAddress(value) {
  const address = cleanText(value, 120).toLowerCase();
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function parseRequiredPublicBaseUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    throw new Error("PUBLIC_BASE_URL is required and must match the deployed public origin.");
  }

  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid absolute URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("PUBLIC_BASE_URL must use http or https.");
  }

  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_BASE_URL must contain only scheme, host, and optional port.");
  }

  return parsed.origin;
}

function isLiteralProxyAddress(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || /^[a-f0-9:]+$/.test(value);
}

function parseTrustedProxyAddresses(value) {
  const entries = String(value || '')
    .split(',')
    .map((entry) => normalizeRemoteAddress(entry))
    .filter(Boolean);

  for (const entry of entries) {
    if (isLoopbackAddress(entry) || !isLiteralProxyAddress(entry)) {
      throw new Error("TRUST_PROXY_ADDRESSES must list only actual reverse proxy IP addresses.");
    }
  }

  return new Set(entries);
}

function isLoopbackAddress(value) {
  const address = normalizeRemoteAddress(value);
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function trustedProxyRequest(req) {
  const address = normalizeRemoteAddress(req.socket?.remoteAddress);
  return TRUST_PROXY_ADDRESSES.has(address) || (TRUST_PROXY_ADDRESSES.has('loopback') && isLoopbackAddress(address));
}

function requestHost(req) {
  const forwardedHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  const headerHost = String(req.headers.host || ('localhost:' + PORT))
    .split(',')[0]
    .trim();

  return trustedProxyRequest(req) && forwardedHost ? forwardedHost : headerHost;
}

function requestProtocol(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  return trustedProxyRequest(req) && forwardedProto ? forwardedProto : (req.socket.encrypted ? 'https' : 'http');
}

function appBaseUrl(req) {
  return CONFIGURED_PUBLIC_BASE_URL;
}

async function sendEmployeeQr(req, res) {
  const employeeUrl = `${appBaseUrl(req)}${appPath("employee")}`;
  const svg = await QRCode.toString(employeeUrl, {
    type: "svg",
    margin: 2,
    width: 320,
    color: {
      dark: "#002855",
      light: "#ffffff"
    }
  });

  res.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "no-store"
  });
  res.end(svg);
}

async function requireHrAccess(req, res) {
  const access = await securityStore.checkHrAccess(req);

  if (!access.authorized) {
    sendJson(res, 401, access);
    return null;
  }

  return access;
}

async function requireWebmasterAccess(req, res) {
  const access = await securityStore.checkWebmasterAccess(req);

  if (!access.authorized) {
    sendJson(res, 401, access);
    return null;
  }

  return access;
}

async function requireEmployeeAccess(req, res) {
  const access = await securityStore.checkEmployeeAccess(req);

  if (!access.authorized) {
    sendJson(res, 401, access);
    return null;
  }

  return access;
}

function normalizedRequestOrigin(value) {
  if (!value) {
    return "";
  }

  try {
    return new URL(String(value)).origin;
  } catch {
    return "";
  }
}

function defaultPortForProtocol(protocol) {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}

function parsedOriginParts(value) {
  try {
    const url = new URL(String(value));
    return {
      protocol: url.protocol,
      hostname: String(url.hostname || "").toLowerCase(),
      port: String(url.port || defaultPortForProtocol(url.protocol))
    };
  } catch {
    return null;
  }
}

function equivalentTrustedOrigin(candidateOrigin, expectedOrigin) {
  if (!candidateOrigin || !expectedOrigin) {
    return false;
  }

  if (candidateOrigin === expectedOrigin) {
    return true;
  }

  const candidate = parsedOriginParts(candidateOrigin);
  const expected = parsedOriginParts(expectedOrigin);

  if (!candidate || !expected) {
    return false;
  }

  if (candidate.protocol !== expected.protocol || candidate.port !== expected.port) {
    return false;
  }

  if (candidate.hostname === expected.hostname) {
    return true;
  }

  const canonicalCandidateHost = candidate.hostname.replace(/^www\./, "");
  const canonicalExpectedHost = expected.hostname.replace(/^www\./, "");

  return canonicalCandidateHost === canonicalExpectedHost;
}

function isSameOriginRequest(req) {
  const expectedOrigin = normalizedRequestOrigin(appBaseUrl(req));
  const requestOrigins = [
    normalizedRequestOrigin(req.headers.origin),
    normalizedRequestOrigin(req.headers.referer),
    normalizedRequestOrigin(req.headers.referrer)
  ].filter(Boolean);

  if (!requestOrigins.length) {
    return true;
  }

  return requestOrigins.some((origin) => equivalentTrustedOrigin(origin, expectedOrigin));
}

function requireSameOrigin(req, res) {
  if (!isSameOriginRequest(req)) {
    sendError(res, 403, "Cross-site requests are not allowed.");
    return false;
  }

  return true;
}

function requestCsrfToken(req) {
  return cleanText(req.headers["x-csrf-token"] || req.headers["X-CSRF-Token"] || "", 200);
}

async function requireBoardReadAccess(req, res) {
  const employeeAccess = await securityStore.checkEmployeeAccess(req);

  if (employeeAccess.authorized) {
    return {
      role: "employee",
      ...employeeAccess
    };
  }

  const hrAccess = await securityStore.checkHrAccess(req);

  if (hrAccess.authorized) {
    return {
      role: "admin",
      ...hrAccess
    };
  }

  sendJson(res, 401, employeeAccess);
  return null;
}

async function requireHrMutationAccess(req, res) {
  if (!requireSameOrigin(req, res)) {
    return null;
  }

  const access = await requireHrAccess(req, res);

  if (!access) {
    return null;
  }

  if (!access.csrfToken || requestCsrfToken(req) !== access.csrfToken) {
    sendError(res, 403, "Invalid CSRF token.");
    return null;
  }

  return access;
}

async function requireWebmasterMutationAccess(req, res) {
  if (!requireSameOrigin(req, res)) {
    return null;
  }

  const access = await requireWebmasterAccess(req, res);

  if (!access) {
    return null;
  }

  if (!access.csrfToken || requestCsrfToken(req) !== access.csrfToken) {
    sendError(res, 403, "Invalid CSRF token.");
    return null;
  }

  return access;
}

async function disableEmployeePushAccess(employeeId) {
  const targetEmployeeId = cleanText(employeeId, 80);

  if (!targetEmployeeId) {
    return { changed: 0 };
  }

  return notificationHub.updateData((data) => {
    let changed = 0;
    const updatedAt = nowIso();
    data.subscriptions = data.subscriptions.map((subscription) => {
      if (subscription.employeeId !== targetEmployeeId) {
        return subscription;
      }

      changed += 1;
      return {
        ...subscription,
        authorized: false,
        updatedAt
      };
    });

    return { changed };
  });
}

function scopedEmployeePushStatus(pushData, employeeId) {
  const devices = summarizeNotificationDevices({
    subscriptions: Array.isArray(pushData?.subscriptions)
      ? pushData.subscriptions.filter((subscription) => subscription.employeeId === employeeId)
      : []
  }).filter((device) => device.channel === "push");
  const authorizedSubscriptions = devices.filter((device) => device.authorized).length;

  return {
    supported: true,
    subscriptions: devices.length,
    authorizedSubscriptions,
    inactiveSubscriptions: Math.max(0, devices.length - authorizedSubscriptions),
    devices
  };
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeRelativePath(value, fallback = appPath("hr")) {
  const text = cleanText(value, 200);

  if (!text || !text.startsWith("/")) {
    return fallback;
  }

  return text;
}

function cleanLongText(value, maxLength) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function parseBooleanish(value) {
  return value === true || value === "true" || value === "on" || value === 1 || value === "1";
}

function isValidExpiry(value) {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function readJsonBody(req) {
  let received = 0;
  const chunks = [];

  for await (const chunk of req) {
    received += chunk.length;

    if (received > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizePost(input) {
  const type = allowedTypes.has(input.type) ? input.type : "News";
  const priority = allowedPriorities.has(input.priority) ? input.priority : "Normal";
  const title = cleanText(input.title, 90);
  const body = cleanLongText(input.body, 700);
  const audience = cleanText(input.audience || "All employees", 80);
  const expiresAt = cleanText(input.expiresAt, 10);
  const notifyEmployees = parseBooleanish(input.notifyEmployees) || priority === "Important" || priority === "Urgent";

  if (!title) throw new Error("Title is required.");
  if (!body) throw new Error("Message is required.");
  if (!isValidExpiry(expiresAt)) throw new Error("Expiration date must use YYYY-MM-DD.");

  return {
    id: crypto.randomUUID(),
    type,
    priority,
    notifyEmployees,
    title,
    body,
    audience,
    author: "HR",
    createdAt: nowIso(),
    expiresAt
  };
}

function sortedPosts(posts) {
  return [...posts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function handleApi(req, res, url) {
  try {
    const cookieNames = securityStore.getAccessCookieNames();
    const adminCookieHeader = serializeCookie(cookieNames.hr, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "Lax",
      secure: isSecureRequest(req)
    });
    const webmasterCookieHeader = serializeCookie(cookieNames.webmaster, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "Lax",
      secure: isSecureRequest(req)
    });
    const employeeCookieHeader = serializeCookie(cookieNames.employee, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "Lax",
      secure: isSecureRequest(req)
    });

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, now: nowIso() });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/api/admin/check" || url.pathname === "/api/hr/check")) {
      const auth = await securityStore.checkHrAccess(req);
      sendJson(res, 200, auth);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/webmaster/check") {
      const auth = await securityStore.checkWebmasterAccess(req);
      sendJson(res, 200, auth);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/security/events") {
      if (!(await requireHrAccess(req, res))) return;

      const result = await securityStore.listSecurityEvents({
        limit: Number(url.searchParams.get('limit') || 100)
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/employee/check") {
      const auth = await securityStore.checkEmployeeAccess(req);
      sendJson(res, 200, auth);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hr/setup") {
      if (!requireSameOrigin(req, res)) return;

      if (!ADMIN_SETUP_TOKEN) {
        throw createHttpError(503, "Admin setup is disabled. Configure ADMIN_SETUP_TOKEN on the server first.");
      }

      const body = await readJsonBody(req);

      if (!matchesAdminSetupToken(body.setupToken)) {
        throw createHttpError(403, "Invalid setup token.");
      }

      const result = await securityStore.setupAdminAccess({
        password: body.password,
        userAgent: req.headers["user-agent"]
      });

      sendJson(res, 201, result, {
        "Set-Cookie": serializeCookie(cookieNames.hr, result.sessionId, {
          path: "/",
          maxAge: EMPLOYEE_SESSION_COOKIE_MAX_AGE,
          httpOnly: true,
          sameSite: "Lax",
          secure: isSecureRequest(req)
        })
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hr/login") {
      if (!requireSameOrigin(req, res)) return;

      const body = await readJsonBody(req);
      const result = await securityStore.authenticateAdmin({
        password: body.password,
        userAgent: req.headers["user-agent"],
        clientIp: req.socket?.remoteAddress
      });

      sendJson(res, 200, result, {
        "Set-Cookie": serializeCookie(cookieNames.hr, result.sessionId, {
          path: "/",
          maxAge: EMPLOYEE_SESSION_COOKIE_MAX_AGE,
          httpOnly: true,
          sameSite: "Lax",
          secure: isSecureRequest(req)
        })
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hr/logout") {
      if (!requireSameOrigin(req, res)) return;

      await securityStore.logoutAdmin(req);
      sendJson(res, 200, { ok: true }, {
        "Set-Cookie": adminCookieHeader
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hr/password") {
      if (!(await requireHrMutationAccess(req, res))) return;

      const body = await readJsonBody(req);
      const result = await securityStore.changeAdminPassword(req, {
        currentPassword: body.currentPassword,
        password: body.password,
        userAgent: req.headers["user-agent"],
        clientIp: req.socket?.remoteAddress
      });

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hr/recovery/request") {
      if (!requireSameOrigin(req, res)) return;

      if (!HR_RECOVERY_EMAIL || !RECOVERY_EMAIL_FROM || !RESEND_API_KEY) {
        throw createHttpError(503, "Email recovery is not configured on the server.");
      }

      const result = await securityStore.issueHrRecoveryCode({
        email: HR_RECOVERY_EMAIL,
        userAgent: req.headers["user-agent"],
        clientIp: req.socket?.remoteAddress
      });

      await sendRecoveryEmail({
        to: HR_RECOVERY_EMAIL,
        code: result.code,
        expiresAt: result.expiresAt
      });

      sendJson(res, 200, {
        ok: true,
        sent: true,
        destination: maskEmailAddress(HR_RECOVERY_EMAIL),
        expiresAt: result.expiresAt
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hr/recover") {
      if (!requireSameOrigin(req, res)) return;

      const body = await readJsonBody(req);
      let result;

      if (cleanText(body.code, 32)) {
        result = await securityStore.recoverAdminAccessByCode({
          code: body.code,
          password: body.password,
          userAgent: req.headers["user-agent"],
          clientIp: req.socket?.remoteAddress
        });
      } else {
        if (!ADMIN_RECOVERY_TOKEN && !ADMIN_DAILY_RECOVERY_SEED) {
          throw createHttpError(503, "HR recovery is disabled. Configure email recovery, ADMIN_RECOVERY_TOKEN, or ADMIN_DAILY_RECOVERY_SEED on the server first.");
        }

        if (!matchesAdminRecoveryToken(body.recoveryToken)) {
          throw createHttpError(403, "Invalid recovery key.");
        }

        result = await securityStore.recoverAdminAccess({
          password: body.password,
          userAgent: req.headers["user-agent"],
          clientIp: req.socket?.remoteAddress
        });
      }

      sendJson(res, 200, result, {
        "Set-Cookie": serializeCookie(cookieNames.hr, result.sessionId, {
          path: "/",
          maxAge: EMPLOYEE_SESSION_COOKIE_MAX_AGE,
          httpOnly: true,
          sameSite: "Lax",
          secure: isSecureRequest(req)
        })
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/webmaster/setup") {
      if (!(await requireHrMutationAccess(req, res))) return;

      const body = await readJsonBody(req);
      const result = await securityStore.setupWebmasterAccess({
        password: body.password,
        userAgent: req.headers["user-agent"]
      });

      sendJson(res, 201, result, {
        "Set-Cookie": serializeCookie(cookieNames.webmaster, result.sessionId, {
          path: "/",
          maxAge: EMPLOYEE_SESSION_COOKIE_MAX_AGE,
          httpOnly: true,
          sameSite: "Lax",
          secure: isSecureRequest(req)
        })
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/webmaster/login") {
      if (!requireSameOrigin(req, res)) return;

      const body = await readJsonBody(req);
      const result = await securityStore.authenticateWebmaster({
        password: body.password,
        userAgent: req.headers["user-agent"],
        clientIp: req.socket?.remoteAddress
      });

      sendJson(res, 200, result, {
        "Set-Cookie": serializeCookie(cookieNames.webmaster, result.sessionId, {
          path: "/",
          maxAge: EMPLOYEE_SESSION_COOKIE_MAX_AGE,
          httpOnly: true,
          sameSite: "Lax",
          secure: isSecureRequest(req)
        })
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/webmaster/logout") {
      if (!requireSameOrigin(req, res)) return;

      await securityStore.logoutWebmaster(req);
      sendJson(res, 200, { ok: true }, {
        "Set-Cookie": webmasterCookieHeader
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/webmaster/password") {
      if (!requireSameOrigin(req, res)) return;
      if (!(await requireWebmasterAccess(req, res))) return;

      const body = await readJsonBody(req);
      const result = await securityStore.changeWebmasterPassword(req, {
        currentPassword: body.currentPassword,
        password: body.password,
        userAgent: req.headers["user-agent"],
        clientIp: req.socket?.remoteAddress
      });

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/webmaster/password/reset") {
      if (!(await requireHrMutationAccess(req, res))) return;

      const body = await readJsonBody(req);
      const result = await securityStore.resetWebmasterPasswordByHr(req, {
        password: body.password,
        userAgent: req.headers["user-agent"],
        clientIp: req.socket?.remoteAddress
      });

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/employee/login") {
      if (!requireSameOrigin(req, res)) return;

      const body = await readJsonBody(req);
      const result = await securityStore.authenticateEmployee({
        username: body.username,
        password: body.password,
        userAgent: req.headers["user-agent"],
        clientIp: req.socket?.remoteAddress
      });

      sendJson(res, 200, result, {
        "Set-Cookie": serializeCookie(cookieNames.employee, result.sessionId, {
          path: "/",
          maxAge: EMPLOYEE_SESSION_COOKIE_MAX_AGE,
          httpOnly: true,
          sameSite: "Lax",
          secure: isSecureRequest(req)
        })
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/employee/logout") {
      if (!requireSameOrigin(req, res)) return;

      await securityStore.logoutEmployee(req);
      sendJson(res, 200, { ok: true }, {
        "Set-Cookie": employeeCookieHeader
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/employees") {
      if (!(await requireHrAccess(req, res))) return;

      const [employees, pushData] = await Promise.all([
        securityStore.listEmployees(),
        notificationHub.readData()
      ]);
      const devicesByEmployee = new Map();

      for (const subscription of Array.isArray(pushData.subscriptions) ? pushData.subscriptions : []) {
        if (!subscription.employeeId) {
          continue;
        }

        const record = devicesByEmployee.get(subscription.employeeId) || { devices: 0, authorizedDevices: 0 };
        record.devices += 1;
        record.authorizedDevices += subscription.authorized === false ? 0 : 1;
        devicesByEmployee.set(subscription.employeeId, record);
      }

      sendJson(res, 200, {
        employees: employees.map((employee) => ({
          ...employee,
          devices: devicesByEmployee.get(employee.id)?.devices || 0,
          authorizedDevices: devicesByEmployee.get(employee.id)?.authorizedDevices || 0
        }))
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/employees") {
      if (!(await requireHrMutationAccess(req, res))) return;

      const body = await readJsonBody(req);
      const result = await securityStore.createEmployeeAccount(body);
      sendJson(res, 201, result);
      return;
    }

    const employeeStatusMatch = url.pathname.match(/^\/api\/employees\/([^/]+)\/status$/);
    if (req.method === "POST" && employeeStatusMatch) {
      if (!(await requireHrMutationAccess(req, res))) return;

      const employeeId = decodeURIComponent(employeeStatusMatch[1]);
      const body = await readJsonBody(req);
      const result = await securityStore.setEmployeeActive(employeeId, body.active !== false);

      if (body.active === false) {
        await disableEmployeePushAccess(employeeId);
      }

      sendJson(res, 200, result);
      return;
    }

    const employeePasswordMatch = url.pathname.match(/^\/api\/employees\/([^/]+)\/password$/);
    if (req.method === "POST" && employeePasswordMatch) {
      if (!(await requireHrMutationAccess(req, res))) return;

      const employeeId = decodeURIComponent(employeePasswordMatch[1]);
      const body = await readJsonBody(req);
      const result = await securityStore.resetEmployeePassword(employeeId, body.password);
      sendJson(res, 200, result);
      return;
    }

    const employeeSessionsMatch = url.pathname.match(/^\/api\/employees\/([^/]+)\/sessions\/revoke$/);
    if (req.method === "POST" && employeeSessionsMatch) {
      if (!(await requireHrMutationAccess(req, res))) return;

      const employeeId = decodeURIComponent(employeeSessionsMatch[1]);
      const result = await securityStore.revokeEmployeeSessions(employeeId);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/posts") {
      if (!(await requireBoardReadAccess(req, res))) return;

      const data = await boardStore.readData();
      sendJson(res, 200, { posts: sortedPosts(data.posts) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/push/config") {
      const boardAccess = await requireBoardReadAccess(req, res);

      if (!boardAccess) {
        return;
      }

      sendJson(res, 200, {
        supported: true,
        publicKey: notificationHub.getPublicKey()
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/push/status") {
      const boardAccess = await requireBoardReadAccess(req, res);

      if (!boardAccess) {
        return;
      }

      const data = await notificationHub.readData();
      if (boardAccess.role === "employee") {
        sendJson(res, 200, scopedEmployeePushStatus(data, boardAccess.employee.id));
        return;
      }

      const devices = summarizeNotificationDevices(data).filter((device) => device.channel === "push");
      const authorizedSubscriptions = devices.filter((device) => device.authorized).length;
      sendJson(res, 200, {
        supported: true,
        subscriptions: data.subscriptions.length,
        authorizedSubscriptions,
        inactiveSubscriptions: Math.max(0, devices.length - authorizedSubscriptions),
        devices
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/webmaster/summary") {
      if (!(await requireWebmasterAccess(req, res))) return;

      const [boardData, pushData, analyticsData, securityRuntime] = await Promise.all([
        boardStore.readData(),
        notificationHub.readData(),
        analyticsStore.readData(),
        securityStore.readData()
      ]);

      sendJson(res, 200, buildWebmasterSummary({
        boardData,
        pushData,
        analyticsData,
        securityRuntime,
        baseUrl: appBaseUrl(req)
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
      if (!requireSameOrigin(req, res)) return;

      const boardAccess = await requireBoardReadAccess(req, res);

      if (!boardAccess) {
        return;
      }

      if (boardAccess.role !== "employee") {
        sendError(res, 403, "Push enrollment is only available from the employee board.");
        return;
      }

      const body = await readJsonBody(req);
      const result = await notificationHub.subscribe({
        ...body,
        employeeId: boardAccess.employee.id,
        employeeName: boardAccess.employee.name,
        username: boardAccess.employee.username,
        authorized: true
      });

      sendJson(res, 201, {
        ok: true,
        ...result
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/push/subscribe-failure") {
      if (!requireSameOrigin(req, res)) return;

      const boardAccess = await requireBoardReadAccess(req, res);

      if (!boardAccess) {
        return;
      }

      if (boardAccess.role !== "employee") {
        sendError(res, 403, "Push enrollment failure logging is only available from the employee board.");
        return;
      }

      const body = await readJsonBody(req);
      const result = await securityStore.recordPushSubscriptionFailure({
        employeeId: boardAccess.employee.id,
        username: boardAccess.employee.username,
        browser: cleanText(body.browser, 60),
        platform: cleanText(body.platform, 60),
        step: cleanText(body.step, 80),
        errorMessage: cleanText(body.errorMessage, 240),
        userAgent: req.headers["user-agent"],
        clientIp: req.socket?.remoteAddress
      });

      sendJson(res, 201, {
        ok: true,
        ...result
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/push/unsubscribe") {
      if (!requireSameOrigin(req, res)) return;

      const boardAccess = await requireBoardReadAccess(req, res);

      if (!boardAccess) {
        return;
      }

      const body = await readJsonBody(req);
      const endpoint = cleanText(body.endpoint, 2048);

      if (!endpoint) {
        throw new Error("Subscription endpoint is required.");
      }

      if (boardAccess.role === "employee") {
        const result = await notificationHub.updateData((data) => {
          const originalLength = data.subscriptions.length;
          data.subscriptions = data.subscriptions.filter((entry) => !(entry.endpoint === endpoint && entry.employeeId === boardAccess.employee.id));
          return {
            removed: data.subscriptions.length !== originalLength,
            totalSubscriptions: data.subscriptions.length
          };
        });

        sendJson(res, 200, {
          ok: true,
          ...result
        });
        return;
      }

      const result = await notificationHub.unsubscribe(endpoint);

      sendJson(res, 200, {
        ok: true,
        ...result
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/push/test") {
      if (!(await requireWebmasterMutationAccess(req, res))) return;

      const body = await readJsonBody(req);
      const testId = `push-test-${Date.now()}`;
      const notification = {
        id: testId,
        title: cleanText(body.title, 80) || "Palziv test push",
        body: cleanText(body.body ?? body.message, 280) || "This is a delivery check for the current device.",
        type: "Test",
        priority: "Normal",
        url: normalizeRelativePath(body.url, appPath("employee")),
        tag: cleanText(body.tag, 120) || testId,
        requireInteraction: true,
        createdAt: nowIso()
      };
      const result = await notificationHub.broadcast(notification);

      sendJson(res, 201, {
        ok: true,
        notification,
        ...result
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/posts") {
      if (!(await requireHrMutationAccess(req, res))) return;

      const body = await readJsonBody(req);
      const post = normalizePost(body);

      await boardStore.updateData((data) => {
        data.posts.unshift(post);
        return post;
      });

      let notification = null;

      if (post.notifyEmployees) {
        try {
          const pushResult = await notificationHub.broadcast(post);

          notification = {
            push: pushResult
          };
        } catch (error) {
          notification = {
            error: error instanceof Error ? error.message : "Push broadcast failed."
          };
          console.error("Push broadcast failed:", error);
        }
      }

      sendJson(res, 201, { post, notification });
      return;
    }

    const deleteMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      if (!(await requireHrMutationAccess(req, res))) return;

      const id = decodeURIComponent(deleteMatch[1]);
      const deleted = await boardStore.updateData((data) => {
        const originalLength = data.posts.length;
        data.posts = data.posts.filter((post) => post.id !== id);
        return data.posts.length !== originalLength;
      });

      if (!deleted) {
        sendError(res, 404, "Post not found.");
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/weather") {
      if (!(await requireBoardReadAccess(req, res))) return;

      const data = await boardStore.readData();
      sendJson(res, 200, { weather: data.weather });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/weather") {
      if (!(await requireHrMutationAccess(req, res))) return;

      const body = await readJsonBody(req);
      const weather = await resolveLiveWeather(body.location);

      await boardStore.updateData((data) => {
        data.weather = weather;
        return weather;
      });

      sendJson(res, 200, { weather });
      return;
    }

    sendError(res, 404, "API route not found.");
  } catch (error) {
    const message = error instanceof SyntaxError ? "Invalid JSON body." : error.message;
    sendError(res, Number(error.statusCode) || 400, message);
  }
}

function getPublicFilePath(urlPathname) {
  const decodedPath = decodeURIComponent(urlPathname);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const requestedPath = path.resolve(PUBLIC_DIR, relativePath);
  const publicRoot = path.resolve(PUBLIC_DIR);
  const pathFromRoot = path.relative(publicRoot, requestedPath);

  if (pathFromRoot.startsWith("..") || path.isAbsolute(pathFromRoot)) {
    return null;
  }

  return requestedPath;
}

async function serveStatic(req, res, url) {
  const staticPath = path.extname(url.pathname) ? url.pathname : "/";
  const requestedPath = getPublicFilePath(staticPath);

  if (!requestedPath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(requestedPath);

    if (!fileStat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const extension = path.extname(requestedPath);
    const contentType = mimeTypes.get(extension) || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600"
    });
    createReadStream(requestedPath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const startedAt = process.hrtime.bigint();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    void analyticsStore.recordRequest({
      at: nowIso(),
      method: req.method || "GET",
      pathname: url.pathname,
      kind: url.pathname.startsWith("/api/") ? "api" : "page",
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs),
      userAgent: String(req.headers["user-agent"] || ""),
      referer: String(req.headers.referer || req.headers.referrer || "")
    }).catch((error) => {
      console.error("Analytics record failed:", error);
    });
  });

  if (req.method === "GET" && url.pathname === "/employee-qr.svg") {
    await sendEmployeeQr(req, res);
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/palzivalerts/" || url.pathname === "/employee" || url.pathname === "/hr" || url.pathname === "/webmaster" || url.pathname === "/admin" || url.pathname === "/palzivalerts/admin")) {
    const redirects = new Map([
      ["/", appPath()],
      ["/index.html", appPath()],
      ["/employee", appPath("employee")],
      ["/hr", appPath("hr")],
      ["/webmaster", appPath("webmaster")],
      ["/admin", appPath("hr")],
      ["/palzivalerts/admin", appPath("hr")]
    ]);
    const nextLocation = redirects.get(url.pathname);

    if (nextLocation && url.pathname !== nextLocation) {
      redirectTo(res, nextLocation);
    } else {
      sendIndexHtml(res);
    }
    return;
  }

  if (req.method === "GET" && (url.pathname === appPath() || url.pathname === appPath("employee") || url.pathname === appPath("hr") || url.pathname === appPath("webmaster"))) {
    sendIndexHtml(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/sw.js") {
    sendServiceWorker(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
    sendManifest(res);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }

  await serveStatic(req, res, url);
});

await boardStore.init();
await notificationHub.init();
await analyticsStore.init();
await securityStore.init();

server.listen(PORT, () => {
  console.log(`${displayBrandName(siteConfig)} running at http://localhost:${PORT} (${boardStore.backend} storage)`);
});

