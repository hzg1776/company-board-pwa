import {
  resolveDeviceSetupAction,
  resolveDeviceSetupSecondaryAction
} from "./device-setup.js";

const DEFAULT_SITE_CONFIG = {
  name: "Communications and Alert Center",
  nameSuffix: "",
  shortName: "Alert Center",
  subtitle: "Updates & Alerts Portal",
  description: "Updates and alerts portal for Communications and Alert Center with HR-managed company news, weather, and push notifications."
};

const SITE_CONFIG = Object.freeze({
  ...DEFAULT_SITE_CONFIG,
  ...(window.__BOARD_CONFIG__ || {})
});

const APP_ASSET_VERSION = String(SITE_CONFIG.assetVersion || "20260615");
const APP_TITLE = String(SITE_CONFIG.name || DEFAULT_SITE_CONFIG.name);
const APP_NAME_SUFFIX = String(SITE_CONFIG.nameSuffix || DEFAULT_SITE_CONFIG.nameSuffix);
const APP_DISPLAY_TITLE = APP_NAME_SUFFIX ? `${APP_TITLE} ${APP_NAME_SUFFIX}` : APP_TITLE;
const APP_BASE_PATH = "/palzivalerts";
const app = document.querySelector("#app");
const DEVICE_PROFILE_STORAGE_KEY = "palziv-employee-device-profile-v3";
const CLIENT_TELEMETRY_ENDPOINT = "/api/client-events";

function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures on restricted browsers.
  }
}

function browserNameFromUserAgent() {
  const ua = navigator.userAgent.toLowerCase();

  if (ua.includes("edgios")) return "Edge";
  if (ua.includes("crios")) return "Chrome";
  if (ua.includes("fxios")) return "Firefox";
  if (ua.includes("edg/")) return "Edge";
  if (ua.includes("chrome/") && !ua.includes("edg/") && !ua.includes("opr/")) return "Chrome";
  if (ua.includes("safari/") && !ua.includes("chrome/")) return "Safari";
  if (ua.includes("firefox/")) return "Firefox";
  if (ua.includes("opr/")) return "Opera";
  return "Browser";
}

function platformNameFromUserAgent() {
  const ua = navigator.userAgent.toLowerCase();

  if (ua.includes("iphone")) return "iPhone";
  if (ua.includes("ipad")) return "iPad";
  if (ua.includes("android")) return "Android";
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("mac")) return "Mac";
  if (ua.includes("linux")) return "Linux";
  return navigator.platform || "Device";
}

function isIosDevice() {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod");
}

function isMobileDevice() {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod") || ua.includes("android");
}

function isInstalledWebApp() {
  return Boolean(
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.navigator.standalone === true
  );
}

function buildSuggestedDeviceLabel() {
  const browser = browserNameFromUserAgent();
  const platform = platformNameFromUserAgent();
  return `${platform} ${browser}`.trim();
}

function loadDeviceProfile() {
  const suggestedLabel = buildSuggestedDeviceLabel();
  const fallback = {
    deviceId: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `device-${Math.random().toString(36).slice(2, 10)}`,
    employeeName: "",
    label: "",
    updatedAt: nowIso()
  };

  const raw = safeStorageGet(DEVICE_PROFILE_STORAGE_KEY);

  if (!raw) {
    safeStorageSet(DEVICE_PROFILE_STORAGE_KEY, JSON.stringify(fallback));
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw);
    const profile = {
      ...fallback,
      deviceId: String(parsed.deviceId || fallback.deviceId),
      employeeName: (() => {
        const explicitName = String(parsed.employeeName || "").trim();
        if (explicitName) return explicitName;

        const legacyLabel = String(parsed.label || "").trim();
        if (legacyLabel && legacyLabel !== suggestedLabel) return legacyLabel;

        return "";
      })(),
      label: (() => {
        const explicitLabel = String(parsed.label || "").trim();
        if (explicitLabel && explicitLabel !== suggestedLabel) return explicitLabel;

        const fallbackName = String(parsed.employeeName || "").trim();
        return fallbackName || "";
      })(),
      updatedAt: String(parsed.updatedAt || fallback.updatedAt)
    };

    safeStorageSet(DEVICE_PROFILE_STORAGE_KEY, JSON.stringify(profile));
    return profile;
  } catch {
    safeStorageSet(DEVICE_PROFILE_STORAGE_KEY, JSON.stringify(fallback));
    return fallback;
  }
}

function saveDeviceProfile(profile) {
  const employeeName = String(profile.employeeName || profile.label || "").trim() || buildSuggestedDeviceLabel();
  const next = {
    deviceId: String(profile.deviceId || "").trim() || (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `device-${Math.random().toString(36).slice(2, 10)}`),
    employeeName,
    label: employeeName,
    updatedAt: nowIso()
  };

  safeStorageSet(DEVICE_PROFILE_STORAGE_KEY, JSON.stringify(next));
  return next;
}

document.title = APP_DISPLAY_TITLE;
let activeAdminTab = "feed";
let activeWebmasterTab = "overview";
let activeItTab = "accounts";
let activeHistoryFilter = "All";
let activePushRosterFilter = "active";
const adminTabs = [
  { id: "feed", label: "Feed", icon: "news" },
  { id: "share", label: "Users", icon: "users" },
  { id: "settings", label: "Settings", icon: "lock" }
];
const webmasterTabs = [
  { id: "overview", label: "Overview", icon: "chart" },
  { id: "traffic", label: "Traffic", icon: "refresh" },
  { id: "system", label: "System", icon: "monitor" },
  { id: "content", label: "Content", icon: "board" },
  { id: "codex", label: "Codex", icon: "clipboard" },
  { id: "settings", label: "Settings", icon: "lock" }
];
const itTabs = [
  { id: "accounts", label: "Admin Accounts", icon: "users" },
  { id: "company", label: "Company Settings", icon: "board" },
  { id: "audit", label: "Audit Log", icon: "clipboard" },
  { id: "emergency", label: "Emergency Access", icon: "alert" }
];
const EMPLOYEE_REFRESH_MS = 60_000;

const state = {
  deviceProfile: loadDeviceProfile(),
  appUpdate: {
    available: false,
    latestVersion: ""
  },
  posts: [],
  weather: null,
  access: {
    employee: {
      loaded: false,
      authorized: false,
      sessionExpiresAt: "",
      employee: null,
      busy: false,
      error: ""
    },
    hr: {
      loaded: false,
      authorized: false,
      setupRequired: false,
      mfaRequired: false,
      mfaMode: "",
      sessionExpiresAt: "",
      csrfToken: "",
      user: null,
      busy: false,
      error: ""
    },
    it: {
      loaded: false,
      authorized: false,
      setupRequired: false,
      mfaRequired: false,
      mfaMode: "",
      sessionExpiresAt: "",
      csrfToken: "",
      user: null,
      busy: false,
      error: ""
    },
    webmaster: {
      loaded: false,
      authorized: false,
      setupRequired: false,
      mfaRequired: false,
      mfaMode: "",
      hrAuthorized: false,
      sessionExpiresAt: "",
      csrfToken: "",
      user: null,
      busy: false,
      error: ""
    }
  },
  adminDirectory: {
    loaded: false,
    adminUsers: []
  },
  webmasterAdminDirectory: {
    loaded: false,
    adminUsers: []
  },
  itAdminDirectory: {
    loaded: false,
    adminUsers: []
  },
  adminInvite: {
    loaded: false,
    token: "",
    details: null,
    busy: false,
    error: ""
  },
  adminMfa: {
    hr: {
      busy: false,
      details: null
    },
    it: {
      busy: false,
      details: null
    },
    webmaster: {
      busy: false,
      details: null
    }
  },
  adminMfaPolicy: {
    loaded: false,
    busy: false,
    policy: {
      enabled: true,
      effectiveEnabled: true,
      environmentEnabled: true,
      updatedAt: "",
      updatedBy: "",
      reason: ""
    }
  },
  employeeDirectory: {
    loaded: false,
    employees: []
  },
  employeeBatchUpload: {
    busy: false,
    content: "",
    created: 0,
    credentials: [],
    format: "auto"
  },
  securityEvents: {
    loaded: false,
    events: []
  },
  webmaster: {
    loaded: false,
    summary: null,
    probes: {},
    browser: {},
    expanded: {}
  },
  push: {
    supported: false,
    permission: "default",
    subscribed: false,
    busy: false,
    ready: false,
    error: ""
  },
  pushStatus: {
    loaded: false,
    supported: true,
    subscriptions: 0,
    authorizedSubscriptions: 0,
    inactiveSubscriptions: 0,
    devices: []
  },
  message: "",
  messageType: "",
  authRecovery: {
    hr: false,
    it: false,
    webmaster: false
  },
  employeeInstallGuideOpen: false,
  loading: true
};
const clientTelemetrySent = new Set();

const icons = {
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  "arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  "arrow-up": '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  bell: '<path d="M10 21h4"/><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  board: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  chart: '<path d="M4 19h16"/><path d="M6 16V10"/><path d="M11 16V6"/><path d="M16 16v-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cloud: '<path d="M17.5 19H8a6 6 0 1 1 5.5-8.42A4.5 4.5 0 1 1 17.5 19Z"/>',
  delete: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
  filter: '<path d="M4 5h16"/><path d="M7 12h10"/><path d="M10 19h4"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  megaphone: '<path d="m3 11 18-5v12L3 13v-2Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  news: '<path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18 5.3L21 8"/><path d="M21 3v5h-5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
  sunrise: '<path d="M3 17h18"/><path d="M5 21h14"/><path d="M12 3v8"/><path d="m8 7 4-4 4 4"/><path d="M6.2 14a6 6 0 0 1 11.6 0"/>',
  sunset: '<path d="M3 17h18"/><path d="M5 21h14"/><path d="M12 11V3"/><path d="m8 7 4 4 4-4"/><path d="M6.2 14a6 6 0 0 1 11.6 0"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  clipboard: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="M9 12h6"/><path d="M9 16h6"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 20h8"/><path d="M12 17v3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.board}</svg>`;
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

function formatDate(value) {
  if (!value) return "Never";
  const text = String(value).trim();
  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const hasTime = text.includes("T") || /^\d{4}-\d{2}-\d{2}\s+\d{2}:/.test(text);

  let date = null;

  if (dateOnlyMatch) {
    date = new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]));
  } else {
    const directDate = new Date(text);

    if (Number.isNaN(directDate.getTime()) && text.includes(" ") && !text.includes("T")) {
      date = new Date(text.replace(" ", "T"));
    } else {
      date = directDate;
    }
  }

  if (Number.isNaN(date.getTime())) {
    const fallbackText = `${text}Z`;
    date = new Date(fallbackText);
  }

  if (Number.isNaN(date.getTime())) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: hasTime ? "numeric" : undefined,
    minute: hasTime ? "2-digit" : undefined
  }).format(date);
}

function formatTime(value) {
  if (!value) return "Not available";
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function safeFilename(value) {
  return String(value || "acknowledgements")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "acknowledgements";
}

function nowIso() {
  return new Date().toISOString();
}

function sendClientTelemetry(payload, options = {}) {
  const onceKey = String(options.onceKey || "").trim();

  if (onceKey && clientTelemetrySent.has(onceKey)) {
    return;
  }

  if (onceKey) {
    clientTelemetrySent.add(onceKey);
  }

  const body = JSON.stringify({
    pathname: window.location.pathname,
    route: currentRoute(),
    assetVersion: APP_ASSET_VERSION,
    ...payload
  });

  try {
    if (typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(CLIENT_TELEMETRY_ENDPOINT, blob);
      return;
    }
  } catch {
    // Fall back to fetch below.
  }

  void fetch(CLIENT_TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body,
    keepalive: true
  }).catch(() => {});
}

function appShellHasVisibleContent() {
  if (!app) {
    return false;
  }

  if (app.textContent && app.textContent.trim()) {
    return true;
  }

  return Boolean(app.querySelector("img, button, input, main, section, article, a, h1, h2, h3, p, form"));
}

function scheduleClientShellCheck(reason = "boot") {
  window.setTimeout(() => {
    if (appShellHasVisibleContent()) {
      sendClientTelemetry({
        type: "boot-visible",
        severity: "info",
        detail: `Client shell rendered after ${reason}.`
      }, { onceKey: `boot-visible:${reason}` });
      return;
    }

    sendClientTelemetry({
      type: "blank-screen",
      severity: "error",
      detail: `App container stayed empty after ${reason}.`
    }, { onceKey: "blank-screen" });
  }, 250);
}

function normalizePathname(pathname = window.location.pathname) {
  const value = String(pathname || "/");
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
}

function appPath(...segments) {
  const parts = [APP_BASE_PATH];

  for (const segment of segments) {
    const rawSegment = String(segment ?? "").replace(/^\/+|\/+$/g, "");
    const cleanSegment = rawSegment === "it" ? "it" : rawSegment;

    if (cleanSegment) {
      parts.push(cleanSegment);
    }
  }

  return parts.join("/").replace(/\/+/g, "/") || APP_BASE_PATH;
}

function currentRoute() {
  const pathname = normalizePathname();
  const hash = window.location.hash || "";

  if (pathname === "/" || pathname === "/index.html" || pathname === APP_BASE_PATH) {
    return "launcher";
  }

  if (pathname === `${APP_BASE_PATH}/webmaster` || pathname === "/webmaster" || hash === "#webmaster") {
    return "webmaster";
  }

  if (pathname === `${APP_BASE_PATH}/it` || pathname === "/it" || hash === "#it") {
    return "it";
  }

  if (pathname === `${APP_BASE_PATH}/hr` || pathname === "/hr" || hash === "#hr") {
    return "hr";
  }

  if (pathname === `${APP_BASE_PATH}/employee` || pathname === "/employee") {
    return "employee";
  }

  if (pathname.startsWith(`${APP_BASE_PATH}/`)) {
    return "launcher";
  }

  return "launcher";
}

function currentInviteToken() {
  return String(new URL(window.location.href).searchParams.get("invite") || "").trim().slice(0, 200);
}

function clearInviteToken(nextRoute = currentRoute()) {
  const nextUrl = new URL(window.location.href);
  nextUrl.pathname = routePath(nextRoute);
  nextUrl.searchParams.delete("invite");
  window.history.replaceState({}, "", nextUrl.toString());
}

function routePath(route) {
  if (route === "it") return appPath("it");
  if (route === "webmaster") return appPath("webmaster");
  if (route === "hr") return appPath("hr");
  if (route === "employee") return appPath("employee");
  return appPath();
}

function buildDocumentTitle({
  appTitle = APP_DISPLAY_TITLE,
  route = "launcher",
  employeeAuthorized = false,
  hrAuthorized = false,
  webmasterAuthorized = false,
  itAuthorized = false,
  activeAdminTab: hrTab = "feed",
  activeWebmasterTab: webmasterTab = "overview",
  activeItTab: itTab = "accounts"
} = {}) {
  const title = String(appTitle || "").trim() || "Portal";
  const hrTitles = {
    feed: "HR Feed",
    share: "HR Users",
    settings: "HR Settings"
  };
  const webmasterTitles = {
    overview: "Systems Overview",
    traffic: "Systems Traffic",
    system: "System Diagnostics",
    content: "Systems Content",
    codex: "Systems Codex",
    settings: "Systems Settings"
  };
  const itTitles = {
    accounts: "IT Admin Accounts",
    company: "IT Company Settings",
    audit: "IT Audit Log",
    emergency: "IT Emergency Access"
  };
  let pageTitle = "";

  if (route === "employee") {
    pageTitle = employeeAuthorized ? "Employee Feed" : "Employee Login";
  } else if (route === "hr") {
    pageTitle = hrAuthorized ? (hrTitles[hrTab] || hrTitles.feed) : "HR Login";
  } else if (route === "webmaster") {
    pageTitle = webmasterAuthorized ? (webmasterTitles[webmasterTab] || webmasterTitles.overview) : "Systems Login";
  } else if (route === "it") {
    pageTitle = itAuthorized ? (itTitles[itTab] || itTitles.accounts) : "IT Login";
  }

  return pageTitle ? `${pageTitle} - ${title}` : title;
}

function formatDurationMs(value) {
  const duration = Math.max(0, Number(value || 0));

  if (duration >= 1000) {
    return `${(duration / 1000).toFixed(duration >= 10_000 ? 0 : 1)}s`;
  }

  return `${Math.round(duration)}ms`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${Math.round(bytes)} B`;
}

function formatRelativeTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";

  const diffMs = Date.now() - date.getTime();
  const direction = diffMs >= 0 ? "ago" : "from now";
  const absMs = Math.abs(diffMs);

  if (absMs < 60_000) {
    const seconds = Math.max(1, Math.round(absMs / 1000));
    return `${seconds}s ${direction}`;
  }

  if (absMs < 3_600_000) {
    const minutes = Math.max(1, Math.round(absMs / 60_000));
    return `${minutes}m ${direction}`;
  }

  if (absMs < 86_400_000) {
    const hours = Math.max(1, Math.round(absMs / 3_600_000));
    return `${hours}h ${direction}`;
  }

  const days = Math.max(1, Math.round(absMs / 86_400_000));
  return `${days}d ${direction}`;
}

function collectBrowserDiagnostics() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  const memory = performance.memory || null;
  const navigationEntry = performance.getEntriesByType("navigation")[0] || null;

  return {
    route: currentRoute(),
    url: window.location.href,
    origin: window.location.origin,
    pathname: window.location.pathname,
    hash: window.location.hash || "",
    referrer: document.referrer || "",
    secureContext: window.isSecureContext,
    online: navigator.onLine,
    userAgent: navigator.userAgent,
    platform: navigator.platform || "",
    language: navigator.language || "",
    languages: navigator.languages || [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      pixelRatio: window.devicePixelRatio || 1
    },
    connection: connection
      ? {
          effectiveType: connection.effectiveType || "",
          downlink: connection.downlink || 0,
          rtt: connection.rtt || 0,
          saveData: Boolean(connection.saveData)
        }
      : null,
    deviceMemory: navigator.deviceMemory || null,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    serviceWorker: {
      supported: "serviceWorker" in navigator,
      controlled: Boolean(navigator.serviceWorker?.controller)
    },
    pushSupport: supportsPushNotifications(),
    performance: navigationEntry
      ? {
          domContentLoadedMs: Math.round(navigationEntry.domContentLoadedEventEnd || 0),
          loadMs: Math.round(navigationEntry.loadEventEnd || 0),
          transferSize: navigationEntry.transferSize || 0,
          encodedBodySize: navigationEntry.encodedBodySize || 0
        }
      : null,
    memory: memory
      ? {
          jsHeapSizeLimit: memory.jsHeapSizeLimit || 0,
          totalJSHeapSize: memory.totalJSHeapSize || 0,
          usedJSHeapSize: memory.usedJSHeapSize || 0
        }
      : null
  };
}

async function timedRequestJson(pathname, options = {}) {
  const startedAt = performance.now();
  const body = await requestJson(pathname, options);
  return {
    body,
    ms: Math.max(0, Math.round(performance.now() - startedAt))
  };
}

async function safeTimedRequestJson(pathname, fallback, options = {}) {
  try {
    return await timedRequestJson(pathname, options);
  } catch {
    return {
      body: fallback,
      ms: 0
    };
  }
}

async function copyText(text) {
  if (!text) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.className = "clipboard-fallback-input";
    document.body.appendChild(textarea);
    textarea.select();

    let copied = false;

    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      textarea.remove();
    }

    return copied;
  }
}

function renderKeyValueGrid(entries) {
  return `
    <div class="kv-grid">
      ${entries
        .map(
          ([label, value, note = ""]) => `
            <div class="kv-item">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
              ${note ? `<small>${escapeHtml(note)}</small>` : ""}
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderRecentRequest(request) {
  const statusCode = Number(request.statusCode || 0);
  const statusClass = statusCode >= 500 ? "danger" : statusCode >= 400 ? "warning" : "success";

  return `
    <article class="request-row">
      <div class="request-row-main">
        <strong>${escapeHtml(request.pathname || "/")}</strong>
        <span>${escapeHtml(request.method || "GET")} · ${escapeHtml(String(statusCode || "0"))} · ${escapeHtml(formatDurationMs(request.durationMs))}</span>
      </div>
      <div class="request-row-meta">
        <span class="request-status ${statusClass}">${escapeHtml(String(statusCode || "0"))}</span>
        <span>${escapeHtml((request.kind || "page").toUpperCase())} · ${escapeHtml(formatRelativeTime(request.at))}</span>
      </div>
      ${request.referer || request.userAgent ? `<p class="request-detail">${escapeHtml(request.referer || request.userAgent)}</p>` : ""}
      ${request.error ? `<p class="request-error">${escapeHtml(request.error)}</p>` : ""}
    </article>
  `;
}

function renderCountList(entries, emptyLabel = "None") {
  if (!entries?.length) {
    return `<div class="empty-state compact">${escapeHtml(emptyLabel)}</div>`;
  }

  return `
    <div class="count-list">
      ${entries
        .map(
          (entry) => `
            <div class="count-pill">
              <span>${escapeHtml(entry.label)}</span>
              <strong>${escapeHtml(String(entry.value))}</strong>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function buildWebmasterSnapshot() {
  const summary = state.webmaster.summary || {};
  const board = summary.board || {};
  const notifications = summary.notifications || {};
  const traffic = summary.traffic || {};
  const browser = state.webmaster.browser || collectBrowserDiagnostics();
  const weather = state.weather || defaultWeather();
  const pushSubscriptions = state.pushStatus.loaded
    ? Number(state.pushStatus.subscriptions || 0)
    : Number(notifications.pushSubscriptions || 0);
  const activeSubscriptions = state.pushStatus.loaded
    ? Number(state.pushStatus.authorizedSubscriptions || 0)
    : Number(notifications.activeSubscriptions || 0);
  const inactiveSubscriptions = state.pushStatus.loaded
    ? Number(state.pushStatus.inactiveSubscriptions || 0)
    : Number(notifications.inactiveSubscriptions || 0);
  const pushDevices = state.pushStatus.loaded
    ? (Array.isArray(state.pushStatus.devices) ? state.pushStatus.devices : [])
    : Array.isArray(notifications.devices)
      ? notifications.devices
      : [];

  return {
    generatedAt: summary.generatedAt || nowIso(),
    route: currentRoute(),
    urls: summary.urls || {},
    server: summary.server || {},
    board: {
      ...board,
      weather
    },
    notifications: {
      ...notifications,
      pushSubscriptions,
      activeSubscriptions,
      inactiveSubscriptions,
      devices: pushDevices
    },
    security: summary.security || { accessModel: "open" },
    traffic,
    browser,
    push: {
      supported: state.push.supported,
      permission: state.push.permission,
      subscribed: state.push.subscribed,
      subscriptions: pushSubscriptions,
      activeSubscriptions,
      inactiveSubscriptions,
      devices: pushDevices
    },
    probes: state.webmaster.probes || {},
    note: "Copy this brief into Codex and ask it to inspect the highlighted issues first."
  };
}

function buildCodexBrief(snapshot = buildWebmasterSnapshot()) {
  const board = snapshot.board || {};
  const traffic = snapshot.traffic || {};
  const browser = snapshot.browser || {};
  const server = snapshot.server || {};
  const urls = snapshot.urls || {};
  const origin = urls.origin || window.location.origin;
  const launcherUrl = urls.base || `${origin}${APP_BASE_PATH}`;
  const issues = [];

  if ((traffic.totals?.serverErrors || 0) > 0) {
    issues.push("Investigate server errors and recent failing routes first.");
  }

  if ((board.expiredPosts || 0) > 0) {
    issues.push("Review expired updates and decide whether they should be archived or refreshed.");
  }

  if (!board.latestPost) {
    issues.push("The board has no employee updates. Verify whether this is intentional.");
  }

  if (!browser.secureContext) {
    issues.push("The page is not running in a secure context; push and install behavior may be limited.");
  }

  if (issues.length === 0) {
    issues.push("No obvious runtime issue surfaced in the latest snapshot. Focus on the most recent traffic and content changes.");
  }

  return `# ${APP_DISPLAY_TITLE} Systems Brief
Generated: ${snapshot.generatedAt}
Route: ${snapshot.route}
Base URL: ${launcherUrl}

## Health Snapshot
- Requests: ${traffic.totals?.requests || 0}
- API requests: ${traffic.totals?.apiRequests || 0}
- Page views: ${traffic.totals?.pageViews || 0}
- Server errors: ${traffic.totals?.serverErrors || 0}
- Average response: ${traffic.totals?.averageDurationMs || 0} ms
- Active updates: ${board.activePosts || 0}
- Urgent updates: ${board.urgentPosts || 0}
- Expiring soon: ${board.expiringSoon || 0}
- Push subscriptions: ${board.pushSubscriptions || 0}

## Recent Trouble Spots
${traffic.recentErrors?.length ? traffic.recentErrors
    .slice(0, 5)
    .map((item) => `- ${item.method} ${item.pathname} returned ${item.statusCode} (${item.error || "no error text"})`)
    .join("\n") : "- No recent server errors were recorded."}

## Browser Snapshot
- Route: ${browser.route || "unknown"}
- Viewport: ${browser.viewport ? `${browser.viewport.width} x ${browser.viewport.height}` : "unknown"}
- Secure context: ${browser.secureContext ? "yes" : "no"}
- Service worker: ${browser.serviceWorker?.supported ? "supported" : "unsupported"}
- Connection: ${browser.connection ? `${browser.connection.effectiveType || "unknown"} · ${browser.connection.downlink || 0} Mbps` : "unavailable"}

## Suggested Next Fixes
${issues.map((issue) => `- ${issue}`).join("\n")}

## Useful Links
- Launcher: ${launcherUrl}
- Employee feed: ${urls.employee || `${origin}${appPath("employee")}`}
- HR console: ${urls.hr || `${origin}${appPath("hr")}`}
- Systems console: ${urls.webmaster || `${origin}${appPath("webmaster")}`}
- IT console: ${urls.it || `${origin}${appPath("it")}`}

## Raw Notes
Copying this into Codex should give it enough context to trace the site health and likely failure points quickly.
`;
}

  function brandBlock(title = "", className = "") {
    const brandClasses = ["brand", className].filter(Boolean).join(" ");
    return `
      <div class="${brandClasses}">
        <div class="brand-lockup">
          <div class="brand-logo-disc">
            <img class="brand-lockup-logo" src="/assets/palziv-logo-transparent.png?v=20260625b" alt="${escapeHtml(APP_TITLE)}" loading="eager" decoding="async">
          </div>
          ${title ? `<p>${escapeHtml(title)}</p>` : ""}
        </div>
      </div>
    `;
  }

function renderAuthFrame({
  title,
  error = "",
  content,
  className = "",
  contentClassName = ""
}) {
  const cardClasses = ["auth-gate-card", "panel-card", "entry-surface", className].filter(Boolean).join(" ");
  const contentClasses = ["auth-frame-content", contentClassName].filter(Boolean).join(" ");

  return `
    <main class="auth-shell">
      <section class="${cardClasses}">
        ${brandBlock("", "entry-brand")}
        <div class="panel-title auth-frame-title">
          <div>
            <h2>${escapeHtml(title)}</h2>
          </div>
        </div>
        ${error ? `<div class="employee-banner">${escapeHtml(error)}</div>` : ""}
        <div class="${contentClasses}">
          ${content}
        </div>
      </section>
    </main>
  `;
}

function renderAdminAuthFrame({ route, title, error = "", content, footer = "" }) {
  return `
    <main class="admin-auth-shell">
      <section class="admin-auth-card panel-card entry-surface" data-admin-auth-surface="${escapeHtml(route)}">
        <header class="admin-auth-header">
          <div class="admin-auth-brand entry-brand">
            <div class="admin-auth-brand-disc">
              <img class="admin-auth-brand-logo" src="/assets/palziv-logo-transparent.png?v=20260625b" alt="${escapeHtml(APP_TITLE)}" loading="eager" decoding="async">
            </div>
            <div class="admin-auth-brand-copy">
              <h1>${escapeHtml(title)}</h1>
            </div>
          </div>
        </header>
        ${error ? `<div class="employee-banner">${escapeHtml(error)}</div>` : ""}
        <div class="admin-auth-body">
          ${content}
        </div>
        ${footer ? `<footer class="admin-auth-footer">${footer}</footer>` : ""}
      </section>
    </main>
  `;
}

function renderTabBar(tabs, activeTab, group, label) {
  return `
    <nav class="tab-bar" aria-label="${escapeHtml(label)}">
      ${tabs
        .map(
          (tab) => `
            <button
              class="tab-button ${tab.id === activeTab ? "active" : ""}"
              type="button"
              data-tab="${escapeHtml(tab.id)}"
              data-tab-group="${escapeHtml(group)}"
              aria-pressed="${tab.id === activeTab}"
            >
              ${icon(tab.icon)}
              <span>${escapeHtml(tab.label)}</span>
            </button>
          `
        )
        .join("")}
    </nav>
  `;
}

function renderStatCard(value, label) {
  return `
    <article class="stat-card">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </article>
  `;
}

function renderHrSummaryStatCard({ value, label, tab, filter = "" }) {
  const actionLabel =
    tab === "share"
      ? "Open Employee Accounts."
      : filter === "Urgent"
        ? "Open Urgent Employee Feed."
        : "Open Employee Feed.";

  return `
    <button
      class="stat-card hr-stat-button"
      type="button"
      data-hr-summary-tab="${escapeHtml(tab)}"
      data-hr-summary-filter="${escapeHtml(filter)}"
      aria-label="${escapeHtml(`${label}. ${actionLabel}`)}"
    >
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function renderWebmasterDrilldownStatCard({ value, label, note = "", tab, cardIds = [] }) {
  return `
    <button
      class="stat-card webmaster-stat-button"
      type="button"
      data-webmaster-drilldown-tab="${escapeHtml(tab)}"
      data-webmaster-drilldown-cards="${escapeHtml(cardIds.join(","))}"
      aria-label="${escapeHtml(`${label}. ${note ? `${note}. ` : ""}Open detailed systems data.`)}"
    >
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function isWebmasterCardExpanded(id, defaultOpen = false) {
  const expanded = state.webmaster.expanded || {};
  return typeof expanded[id] === "boolean" ? expanded[id] : defaultOpen;
}

function setWebmasterCardsExpanded(cardIds = [], open = true) {
  const nextExpanded = {
    ...(state.webmaster.expanded || {})
  };

  cardIds.forEach((cardId) => {
    if (cardId) {
      nextExpanded[cardId] = open;
    }
  });

  state.webmaster.expanded = nextExpanded;
}

function renderWebmasterSummaryMetrics(metrics = []) {
  const visibleMetrics = Array.isArray(metrics)
    ? metrics.filter(
      (metric) =>
        metric &&
        metric.label &&
        metric.value !== undefined &&
        metric.value !== null &&
        String(metric.value).trim() !== ""
    )
    : [];

  if (!visibleMetrics.length) {
    return "";
  }

  return `
    <div class="webmaster-expand-metrics">
      ${visibleMetrics
        .map(
          (metric) => `
            <div class="webmaster-expand-metric">
              <span>${escapeHtml(metric.label)}</span>
              <strong>${escapeHtml(String(metric.value))}</strong>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderWebmasterExpandableCard({
  id,
  eyebrow,
  title,
  badge = "",
  iconName = "chart",
  summaryMetrics = [],
  body = "",
  defaultOpen = false,
  className = ""
}) {
  const classes = ["panel-card", "webmaster-expandable", className].filter(Boolean).join(" ");

  return `
    <details
      class="${escapeHtml(classes)}"
      data-webmaster-expand-id="${escapeHtml(id)}"
      ${isWebmasterCardExpanded(id, defaultOpen) ? "open" : ""}
    >
      <summary class="webmaster-expand-summary">
        <div class="webmaster-expand-summary-head">
          <div class="webmaster-expand-summary-copy">
            <p class="eyebrow">${icon(iconName)} ${escapeHtml(eyebrow)}</p>
            <h3>${escapeHtml(title)}</h3>
          </div>
          <div class="webmaster-expand-summary-meta">
            ${badge ? `<span class="sync-pill">${escapeHtml(badge)}</span>` : ""}
            <span class="webmaster-expand-caret" aria-hidden="true"></span>
          </div>
        </div>
        ${renderWebmasterSummaryMetrics(summaryMetrics)}
      </summary>
      <div class="webmaster-expand-body">
        ${body}
      </div>
    </details>
  `;
}

function renderFilterSelect({ name, value, options, label }) {
  return `
    <label class="field inline">
      <span>${escapeHtml(label)}</span>
      <select name="${escapeHtml(name)}" data-${escapeHtml(name)}-select>
        ${options
          .map(
            (option) => `
              <option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>
                ${escapeHtml(option)}
              </option>
            `
          )
          .join("")}
      </select>
    </label>
  `;
}

function isStateChangingMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

function csrfTokenForPath(pathname) {
  const route = new URL(String(pathname || "/"), window.location.origin).pathname;

  if (
    route === "/api/it/logout" ||
    route === "/api/it/password" ||
    route === "/api/it/mfa-policy" ||
    route === "/api/it/admin-users" ||
    route.startsWith("/api/it/admin-users/")
  ) {
    return String(state.access.it?.csrfToken || "");
  }

  if (
    route === "/api/push/test" ||
    route === "/api/webmaster/logout" ||
    route === "/api/webmaster/password" ||
    route === "/api/hr/password/reset" ||
    route === "/api/webmaster/admin-users" ||
    route.startsWith("/api/webmaster/admin-users/")
  ) {
    return String(state.access.webmaster?.csrfToken || "");
  }

  if (
    route === "/api/hr/logout" ||
    route === "/api/hr/password" ||
    route === "/api/webmaster/setup" ||
    route === "/api/admin-users" ||
    route.startsWith("/api/admin-users/") ||
    route === "/api/employees" ||
    route.startsWith("/api/employees/") ||
    route === "/api/posts" ||
    route.startsWith("/api/posts/") ||
    route === "/api/weather"
  ) {
    return String(state.access.hr?.csrfToken || "");
  }

  return "";
}

function normalizeAdminScope(scope = "hr") {
  return scope === "it" ? "it" : scope === "webmaster" ? "webmaster" : "hr";
}

function defaultAdminMfaPolicy() {
  return {
    enabled: true,
    effectiveEnabled: true,
    environmentEnabled: true,
    updatedAt: "",
    updatedBy: "",
    reason: ""
  };
}

function normalizeAdminMfaPolicy(policy = {}) {
  return {
    ...defaultAdminMfaPolicy(),
    enabled: policy.enabled !== false,
    effectiveEnabled: policy.effectiveEnabled !== false,
    environmentEnabled: policy.environmentEnabled !== false,
    updatedAt: String(policy.updatedAt || ""),
    updatedBy: String(policy.updatedBy || ""),
    reason: String(policy.reason || "")
  };
}

function adminApiBase(scope = "hr") {
  const normalizedScope = normalizeAdminScope(scope);
  if (normalizedScope === "it") return "/api/it/admin-users";
  if (normalizedScope === "webmaster") return "/api/webmaster/admin-users";
  return "/api/admin-users";
}

function readAdminDirectory(scope = "hr") {
  const normalizedScope = normalizeAdminScope(scope);
  if (normalizedScope === "it") return state.itAdminDirectory;
  if (normalizedScope === "webmaster") return state.webmasterAdminDirectory;
  return state.adminDirectory;
}

function writeAdminDirectory(scope = "hr", nextDirectory) {
  const normalizedScope = normalizeAdminScope(scope);
  if (normalizedScope === "it") {
    state.itAdminDirectory = nextDirectory;
  } else if (normalizedScope === "webmaster") {
    state.webmasterAdminDirectory = nextDirectory;
  } else {
    state.adminDirectory = nextDirectory;
  }
}

async function refreshAdminManagementScope(scope = "hr") {
  const normalizedScope = normalizeAdminScope(scope);
  if (normalizedScope === "it") {
    await refreshItData();
  } else if (normalizedScope === "webmaster") {
    await refreshWebmasterData();
  } else {
    await refreshAdminData();
  }
}

async function requestJson(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    ...(options.headers || {})
  };

  if (options.body !== undefined && !("Content-Type" in headers) && !("content-type" in headers)) {
    headers["Content-Type"] = "application/json";
  }

  if (isStateChangingMethod(method)) {
    const csrfToken = csrfTokenForPath(path);

    if (csrfToken && !("X-CSRF-Token" in headers) && !("x-csrf-token" in headers)) {
      headers["X-CSRF-Token"] = csrfToken;
    }
  }

  const response = await fetch(path, { cache: "no-store", ...options, method, headers });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || "Request failed.");
  }

  return body;
}

function parseAssetVersionFromHtml(html) {
  const match = String(html || "").match(/assetVersion":"([^"]+)"/);
  return match ? String(match[1] || "").trim() : "";
}

async function fetchLiveAssetVersion() {
  const checkUrl = new URL(routePath("launcher"), window.location.origin);
  checkUrl.searchParams.set("asset-check", String(Date.now()));

  const response = await fetch(checkUrl.toString(), {
    method: "GET",
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache"
    }
  });

  const html = await response.text();
  return parseAssetVersionFromHtml(html);
}

async function checkForAppUpdate() {
  try {
    const liveVersion = await fetchLiveAssetVersion();
    const hasUpdate = Boolean(liveVersion && liveVersion !== APP_ASSET_VERSION);

    if (
      state.appUpdate.available !== hasUpdate ||
      String(state.appUpdate.latestVersion || "") !== String(liveVersion || "")
    ) {
      state.appUpdate = {
        available: hasUpdate,
        latestVersion: liveVersion || ""
      };
      render();
    }
  } catch {
    // Ignore background version check failures.
  }
}

async function reloadForAppUpdate() {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.update().catch(() => {})));
    }

    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => String(key || "").startsWith("palziv-portal-v"))
          .map((key) => caches.delete(key).catch(() => false))
      );
    }
  } catch {
    // Ignore update cleanup failures and fall through to reload.
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("v", String(Date.now()));
  window.location.replace(nextUrl.toString());
}

function renderAppUpdateBanner() {
  if (!state.appUpdate.available) {
    return "";
  }

  return `
    <div class="admin-banner warning version-banner">
      <div class="version-banner-copy">
        <strong>New portal update available</strong>
        <span>This tab or installed app is running an older build. Reload now to pick up the latest employee and admin changes.</span>
      </div>
      <button class="ghost-button version-banner-button" type="button" data-reload-app>${icon("refresh")} Reload now</button>
    </div>
  `;
}

function supportsPushNotifications() {
  return (
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }

  return outputArray;
}

async function loadBoard() {
  const [postsResult, weatherResult] = await Promise.allSettled([
    requestJson("/api/posts"),
    requestJson("/api/weather")
  ]);

  if (postsResult.status === "fulfilled") {
    state.posts = postsResult.value.posts || [];
  }

  if (weatherResult.status === "fulfilled") {
    state.weather = weatherResult.value.weather || defaultWeather();
  } else if (!state.weather) {
    state.weather = defaultWeather();
  }

  if (postsResult.status === "rejected") {
    throw (postsResult.reason instanceof Error ? postsResult.reason : new Error("Could not load employee updates."));
  }
}

async function loadEmployeeAccessStatus() {
  const probe = await safeTimedRequestJson("/api/employee/check", {
    authorized: false,
    sessionExpiresAt: "",
    employee: null
  });

  state.access.employee = {
    ...state.access.employee,
    loaded: true,
    authorized: Boolean(probe.body.authorized),
    sessionExpiresAt: String(probe.body.sessionExpiresAt || ""),
    employee: probe.body.employee || null,
    error: ""
  };

  return state.access.employee;
}

async function loadEmployeeDirectory() {
  try {
    const result = await requestJson("/api/employees");
    state.employeeDirectory = {
      loaded: true,
      employees: Array.isArray(result.employees) ? result.employees : []
    };
  } catch {
    state.employeeDirectory = {
      loaded: true,
      employees: []
    };
  }

  return state.employeeDirectory;
}

async function loadAdminDirectory(scope = "hr") {
  try {
    const result = await requestJson(adminApiBase(scope));
    writeAdminDirectory(scope, {
      loaded: true,
      adminUsers: Array.isArray(result.adminUsers) ? result.adminUsers : []
    });
  } catch {
    writeAdminDirectory(scope, {
      loaded: true,
      adminUsers: []
    });
  }

  return readAdminDirectory(scope);
}

async function loadSecurityEvents() {
  try {
    const result = await requestJson("/api/security/events");
    state.securityEvents = {
      loaded: true,
      events: Array.isArray(result.events) ? result.events : []
    };
  } catch {
    state.securityEvents = {
      loaded: true,
      events: []
    };
  }

  return state.securityEvents;
}

async function refreshAdminData() {
  const access = await loadHrAccessStatus();

  if (!access.authorized) {
    writeAdminDirectory("hr", {
      loaded: false,
      adminUsers: []
    });
    state.employeeDirectory = {
      loaded: false,
      employees: []
    };
    state.securityEvents = {
      loaded: false,
      events: []
    };
    return {
      locked: true
    };
  }

  const [_, pushStatus, employeeDirectory, securityEvents] = await Promise.all([
    loadBoard(),
    loadPushStatus(),
    loadAdminDirectory("hr"),
    loadEmployeeDirectory(),
    loadSecurityEvents()
  ]);

  return {
    pushStatus,
    adminDirectory: state.adminDirectory,
    employeeDirectory,
    securityEvents
  };
}

async function refreshWebmasterData() {
  const [_, access] = await Promise.all([
    loadHrAccessStatus(),
    loadWebmasterAccessStatus()
  ]);

  if (!access.authorized) {
    writeAdminDirectory("webmaster", {
      loaded: false,
      adminUsers: []
    });
    return {
      locked: true
    };
  }

  const [summaryProbe, postsProbe, weatherProbe, pushProbe, healthProbe, webmasterAdminDirectory] = await Promise.all([
    safeTimedRequestJson("/api/webmaster/summary", null),
    safeTimedRequestJson("/api/posts", { posts: [] }),
    safeTimedRequestJson("/api/weather", { weather: defaultWeather() }),
    safeTimedRequestJson("/api/push/status", { supported: false, subscriptions: 0 }),
    safeTimedRequestJson("/api/health", { ok: false, now: nowIso() }),
    loadAdminDirectory("webmaster")
  ]);

  if (!summaryProbe.body) {
    const refreshedAccess = await loadWebmasterAccessStatus();

    if (!refreshedAccess.authorized) {
      return {
        locked: true
      };
    }
  }

  state.posts = postsProbe.body.posts || [];
  state.weather = weatherProbe.body.weather || defaultWeather();
  state.pushStatus = {
    loaded: true,
    supported: Boolean(pushProbe.body.supported),
    subscriptions: Number(pushProbe.body.subscriptions || 0),
    authorizedSubscriptions: Number(pushProbe.body.authorizedSubscriptions || 0),
    inactiveSubscriptions: Number(pushProbe.body.inactiveSubscriptions || 0),
    devices: Array.isArray(pushProbe.body.devices) ? pushProbe.body.devices : []
  };
  state.webmaster = {
    ...state.webmaster,
    loaded: true,
    summary: summaryProbe.body || null,
    probes: {
      summary: summaryProbe.ms,
      posts: postsProbe.ms,
      weather: weatherProbe.ms,
      pushStatus: pushProbe.ms,
      health: healthProbe.ms
    },
    browser: collectBrowserDiagnostics(),
    health: healthProbe.body || {},
    expanded: state.webmaster.expanded || {}
  };

  await syncPushState();
  state.webmasterAdminDirectory = webmasterAdminDirectory;
  return state.webmaster;
}

async function loadAdminMfaPolicy() {
  const probe = await safeTimedRequestJson("/api/it/mfa-policy", {
    policy: defaultAdminMfaPolicy()
  });

  state.adminMfaPolicy = {
    ...state.adminMfaPolicy,
    loaded: true,
    busy: false,
    policy: normalizeAdminMfaPolicy(probe.body.policy)
  };

  return state.adminMfaPolicy;
}

async function refreshItData() {
  const access = await loadItAccessStatus();

  if (!access.authorized) {
    writeAdminDirectory("it", {
      loaded: false,
      adminUsers: []
    });
    state.adminMfaPolicy = {
      ...state.adminMfaPolicy,
      loaded: false,
      busy: false
    };
    state.securityEvents = {
      loaded: false,
      events: []
    };
    return {
      locked: true
    };
  }

  const [itAdminDirectory, securityEvents, adminMfaPolicy] = await Promise.all([
    loadAdminDirectory("it"),
    loadSecurityEvents(),
    loadAdminMfaPolicy()
  ]);

  return {
    itAdminDirectory,
    securityEvents,
    adminMfaPolicy
  };
}

async function loadItAccessStatus() {
  const probe = await safeTimedRequestJson("/api/it/check", {
    authorized: false,
    setupRequired: false,
    mfaRequired: false,
    mfaMode: "",
    sessionExpiresAt: "",
    csrfToken: "",
    user: null
  });

  state.access.it = {
    ...state.access.it,
    loaded: true,
    authorized: Boolean(probe.body.authorized),
    setupRequired: Boolean(probe.body.setupRequired),
    mfaRequired: Boolean(probe.body.mfaRequired),
    mfaMode: String(probe.body.mfaMode || ""),
    sessionExpiresAt: String(probe.body.sessionExpiresAt || ""),
    csrfToken: String(probe.body.csrfToken || ""),
    user: probe.body.user || null,
    error: ""
  };

  return state.access.it;
}

async function loadHrAccessStatus() {
  const probe = await safeTimedRequestJson("/api/hr/check", {
    authorized: false,
    setupRequired: false,
    mfaRequired: false,
    mfaMode: "",
    sessionExpiresAt: "",
    csrfToken: "",
    user: null
  });

  state.access.hr = {
    ...state.access.hr,
    loaded: true,
    authorized: Boolean(probe.body.authorized),
    setupRequired: Boolean(probe.body.setupRequired),
    mfaRequired: Boolean(probe.body.mfaRequired),
    mfaMode: String(probe.body.mfaMode || ""),
    sessionExpiresAt: String(probe.body.sessionExpiresAt || ""),
    csrfToken: String(probe.body.csrfToken || ""),
    user: probe.body.user || null,
    error: ""
  };

  return state.access.hr;
}

async function loadWebmasterAccessStatus() {
  const probe = await safeTimedRequestJson("/api/webmaster/check", {
    authorized: false,
    setupRequired: false,
    mfaRequired: false,
    mfaMode: "",
    hrAuthorized: false,
    sessionExpiresAt: "",
    csrfToken: "",
    user: null
  });

  state.access.webmaster = {
    ...state.access.webmaster,
    loaded: true,
    authorized: Boolean(probe.body.authorized),
    setupRequired: Boolean(probe.body.setupRequired),
    mfaRequired: Boolean(probe.body.mfaRequired),
    mfaMode: String(probe.body.mfaMode || ""),
    hrAuthorized: Boolean(probe.body.hrAuthorized),
    sessionExpiresAt: String(probe.body.sessionExpiresAt || ""),
    csrfToken: String(probe.body.csrfToken || ""),
    user: probe.body.user || null,
    error: ""
  };

  return state.access.webmaster;
}

function resetAdminInviteState() {
  state.adminInvite = {
    loaded: false,
    token: "",
    details: null,
    busy: false,
    error: ""
  };
}

function readAdminMfaState(route = "hr") {
  const normalizedRoute = route === "it" ? "it" : route === "webmaster" ? "webmaster" : "hr";
  return state.adminMfa[normalizedRoute] || { busy: false, details: null };
}

function writeAdminMfaState(route = "hr", nextState = {}) {
  const normalizedRoute = route === "it" ? "it" : route === "webmaster" ? "webmaster" : "hr";
  state.adminMfa[normalizedRoute] = {
    ...readAdminMfaState(normalizedRoute),
    ...nextState
  };
  return state.adminMfa[normalizedRoute];
}

function clearAdminMfaState(route = "hr") {
  writeAdminMfaState(route, {
    busy: false,
    details: null
  });
}

async function loadAdminInvitePreview(route) {
  const inviteToken = currentInviteToken();

  if (!inviteToken || (route !== "hr" && route !== "webmaster" && route !== "it")) {
    resetAdminInviteState();
    return state.adminInvite;
  }

  if (state.adminInvite.token === inviteToken && state.adminInvite.loaded) {
    return state.adminInvite;
  }

  state.adminInvite = {
    loaded: false,
    token: inviteToken,
    details: null,
    busy: false,
    error: ""
  };

  try {
    const result = await requestJson(`/api/admin-invites/preview?token=${encodeURIComponent(inviteToken)}`);
    state.adminInvite = {
      loaded: true,
      token: inviteToken,
      details: result,
      busy: false,
      error: ""
    };
  } catch (error) {
    state.adminInvite = {
      loaded: true,
      token: inviteToken,
      details: null,
      busy: false,
      error: error.message || "Could not load the invitation."
    };
  }

  return state.adminInvite;
}

function defaultWeather() {
  return {
    location: "",
    resolvedName: "",
    condition: "Weather not configured",
    temperature: "--",
    highTemperature: "--",
    lowTemperature: "--",
    sunrise: "",
    sunset: "",
    source: "",
    impact: "Enter a location in HR to fetch live weather.",
    level: "Clear",
    updatedAt: ""
  };
}

const weatherTemperatureTones = Object.freeze([
  { minimum: 80, className: "weather-temperature-hot" },
  { minimum: 70, className: "weather-temperature-warm" },
  { minimum: 56, className: "weather-temperature-mild" },
  { minimum: 33, className: "weather-temperature-cool" },
  { minimum: -Infinity, className: "weather-temperature-cold" }
]);

function getWeatherTemperatureToneClass(value) {
  const match = String(value || "").match(/-?\d+(?:\.\d+)?/);
  const temperature = match ? Number.parseFloat(match[0]) : Number.NaN;

  if (!Number.isFinite(temperature)) {
    return "weather-temperature-neutral";
  }

  return weatherTemperatureTones.find((tone) => temperature >= tone.minimum)?.className || "weather-temperature-neutral";
}

const COMPACT_WEATHER_LOCATION_PARTS = Object.freeze({
  "alabama": "AL",
  "alaska": "AK",
  "arizona": "AZ",
  "arkansas": "AR",
  "california": "CA",
  "colorado": "CO",
  "connecticut": "CT",
  "delaware": "DE",
  "district of columbia": "DC",
  "florida": "FL",
  "georgia": "GA",
  "hawaii": "HI",
  "idaho": "ID",
  "illinois": "IL",
  "indiana": "IN",
  "iowa": "IA",
  "kansas": "KS",
  "kentucky": "KY",
  "louisiana": "LA",
  "maine": "ME",
  "maryland": "MD",
  "massachusetts": "MA",
  "michigan": "MI",
  "minnesota": "MN",
  "mississippi": "MS",
  "missouri": "MO",
  "montana": "MT",
  "nebraska": "NE",
  "nevada": "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  "ohio": "OH",
  "oklahoma": "OK",
  "oregon": "OR",
  "pennsylvania": "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  "tennessee": "TN",
  "texas": "TX",
  "utah": "UT",
  "vermont": "VT",
  "virginia": "VA",
  "washington": "WA",
  "west virginia": "WV",
  "wisconsin": "WI",
  "wyoming": "WY",
  "united states": "US",
  "united states of america": "USA",
  "us": "US",
  "usa": "USA",
  "united kingdom": "UK",
  "uk": "UK"
});

function formatCompactWeatherLocation(location) {
  const text = String(location || "").trim();

  if (!text) {
    return "No location configured";
  }

  const compactParts = text
    .split(",")
    .map((part, index) => {
      const cleanPart = part.trim();

      if (!cleanPart || index === 0) {
        return cleanPart;
      }

      const normalized = cleanPart
        .replace(/\./g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const mapped = COMPACT_WEATHER_LOCATION_PARTS[normalized];

      if (mapped) {
        return mapped;
      }

      const words = cleanPart
        .replace(/[()]/g, "")
        .split(/[\s-]+/)
        .filter((word) => word && !/^(and|of|the)$/i.test(word));

      if (words.length > 1) {
        return words.map((word) => word[0].toUpperCase()).join("");
      }

      return /^[a-z]{2,4}$/i.test(cleanPart) ? cleanPart.toUpperCase() : cleanPart;
    })
    .filter(Boolean);

  return compactParts.join(", ") || text;
}

function renderAdminSignoutFooter() {
  return `
    <footer class="admin-signout-floor">
      <button class="ghost-button" type="button" data-admin-logout>${icon("lock")} Sign Out</button>
    </footer>
  `;
}

  function formatPushError(error, fallback) {
    const message = String(error?.message || "").trim();
    const lower = message.toLowerCase();
    const userAgent = String(navigator.userAgent || "").toLowerCase();
    const androidBrowser = userAgent.includes("android");
    const samsungBrowser = userAgent.includes("samsungbrowser");
    const chromeBrowser = userAgent.includes("chrome") && !samsungBrowser && !userAgent.includes("edg");
    const pushServiceFailure = lower.includes("push service error") || lower.includes("registration failed");

    if (error?.name === "NotAllowedError" || lower.includes("permission denied") || lower.includes("permission is blocked")) {
      return "This browser blocked push registration. Allow notifications for this site and try again.";
    }

    if (lower.includes("not granted") || lower.includes("permission was not granted")) {
      return "Allow notifications for this site before subscribing this device.";
    }

    if (androidBrowser && pushServiceFailure) {
      return chromeBrowser
        ? "Push registration failed on this device. Make sure Google Play Services is enabled, then try Subscribe again in Chrome."
        : "Push registration failed on this device. Open the portal in Chrome, make sure Google Play Services is enabled, then try Subscribe again.";
    }

    if (lower.includes("pushmanager") || lower.includes("push manager") || lower.includes("service worker")) {
      return "This browser cannot finish push setup on this page.";
    }

  return message || fallback;
}

function currentPushDeviceRecord() {
  const endpoint = String(state.push.endpoint || "").trim();

  if (!endpoint) {
    return null;
  }

  const devices = Array.isArray(state.pushStatus.devices) ? state.pushStatus.devices : [];
  return devices.find((device) => String(device.endpoint || "").trim() === endpoint) || null;
}

function buildCurrentPushDeviceState() {
  const supported = supportsPushNotifications();
  const permission = state.push.permission;
  const subscribed = Boolean(state.push.subscribed);
  const device = currentPushDeviceRecord();
  const accessState = String(device?.accessState || "").trim();
  const active = Boolean(device?.authorized);
  const permissionLabel = !supported
    ? "Unavailable"
    : permission === "granted"
      ? "Allowed"
      : permission === "denied"
        ? "Blocked"
        : "Prompt required";
  let badge = "Not subscribed";
  let title = "This device is not enrolled";
  let detail = "Urgent alerts will skip this browser until you subscribe it here.";
  let hint = "HR test alerts only reach devices marked Active.";
  let tone = "warning";

  if (!supported) {
    badge = isIosDevice() ? "Install required" : "Unavailable";
    title = isIosDevice() ? "This iPhone still needs the installed web app" : "This browser cannot receive push alerts";
    detail = isIosDevice()
      ? "Open this site in Safari, add it to the Home Screen, then reopen the installed app before subscribing."
      : "Open the portal in a push-capable browser to receive urgent alerts on this device.";
    hint = "Without browser push support, HR test alerts will never reach this device.";
    tone = "warning";
  } else if (permission === "denied") {
    badge = "Blocked";
    title = "Notifications are turned off for this site";
    detail = "This browser denied notification access, so the server cannot deliver urgent alerts here.";
    hint = "Re-enable notifications in browser settings, then refresh push setup from this device.";
    tone = "warning";
  } else if (!subscribed) {
    badge = "Not subscribed";
    title = "This device still needs to subscribe";
    detail = "Push is available here, but this browser has not been enrolled for alerts yet.";
    hint = "Use the subscribe button below. HR test alerts will skip this device until it is Active.";
    tone = "warning";
  } else if (!device) {
    badge = "Needs refresh";
    title = "Push is on, but the portal has not confirmed this device";
    detail = "This browser already has a push subscription, but the server does not yet recognize it as an active delivery target.";
    hint = "Tap Refresh push setup so this signed-in employee session can register the device properly.";
    tone = "warning";
  } else if (active) {
    badge = "Active";
    title = "This device should receive urgent alerts";
    detail = "The browser subscription and the portal roster agree: this device is active for HR test alerts.";
    hint = "If a future test still does not appear, check system notification settings on this device.";
    tone = "success";
  } else if (accessState === "Revoked") {
    badge = "Revoked";
    title = "This device was removed from delivery";
    detail = "A subscription still exists in the browser, but the server marked it as revoked and will skip it.";
    hint = "Tap Refresh push setup to re-enroll this device for urgent alerts.";
    tone = "warning";
  } else {
    badge = accessState || "Needs refresh";
    title = "This device is subscribed but not active";
    detail = "The browser is enrolled, but the server will still skip this device until its registration is refreshed from the current employee session.";
    hint = "Tap Refresh push setup. HR test alerts only reach devices marked Active.";
    tone = "warning";
  }

  const serverLabel = active ? "Active" : accessState || (subscribed ? "Not confirmed" : "Off");
  const lastUpdatedLabel = device?.updatedAt
    ? `Last confirmed ${formatDate(device.updatedAt)}`
    : active
      ? "No confirmation time recorded"
      : "No server confirmation recorded yet";

  return {
    supported,
    permission,
    permissionLabel,
    subscribed,
    device,
    accessState,
    active,
    badge,
    title,
    detail,
    hint,
    tone,
    serverLabel,
    lastUpdatedLabel
  };
}

function buildEmployeeSetupState() {
  const signedInEmployeeName = String(state.access.employee.employee?.name || "").trim();
  const currentPush = buildCurrentPushDeviceState();
  const pushSupported = currentPush.supported;
  const pushSubscribed = currentPush.subscribed;
  const pushPermission = currentPush.permission;
  const pushReady = currentPush.active;
  const installRequired = isMobileDevice();
  const installed = !installRequired || isInstalledWebApp();
  const notificationGranted = pushPermission === "granted";
  let nextStep = {
    title: "Subscribe this device",
    detail: "Use this signed-in employee account to enroll the current device for notifications.",
    action: "push"
  };

  if (installRequired && !installed) {
    nextStep = {
      title: "Install this site on your phone",
      detail: isIosDevice()
        ? `Use Safari Share -> Add to Home Screen, then reopen the installed ${APP_TITLE} app before subscribing.`
        : "Add this site to your Home Screen or install the app from the browser menu, then reopen it to finish setup.",
      action: "profile"
    };
  } else if (!pushSupported) {
    nextStep = isIosDevice()
      ? {
          title: "Install this site to Home Screen",
          detail: "On iPhone, web push only works from the installed web app. Add this site to your Home Screen, reopen the installed app, then subscribe.",
          action: "push"
        }
      : {
          title: "No push support",
          detail: "This browser cannot use web push. Open the portal in a push-capable browser to enable alerts.",
          action: "push"
        };
  } else if (pushPermission === "denied") {
      nextStep = {
        title: "Enable notifications for this site",
        detail: "Notification access is turned off here. Turn it back on, then tap subscribe.",
        action: "push"
      };
  } else if (!pushSubscribed) {
      nextStep = {
      title: "Subscribe This Browser",
      detail: "This browser can receive web push. Tap subscribe to finish setup.",
      action: "push"
    };
  } else if (!currentPush.device) {
    nextStep = {
      title: "Refresh push setup",
      detail: "This browser asked for push access, but the portal has not confirmed this device yet. Refresh setup so tests can reach it.",
      action: "push"
    };
  } else if (!pushReady) {
    nextStep = {
      title: currentPush.accessState === "Revoked" ? "Re-enroll this device" : "Refresh push setup",
      detail: currentPush.accessState === "Revoked"
        ? "This device was removed from alert delivery. Refresh setup to enroll it again."
        : "This browser is subscribed, but the server will still skip it until you refresh setup from this session.",
      action: "push"
    };
  } else if (pushReady) {
    nextStep = {
      title: "This device is ready",
      detail: "Push is on and this device is active for urgent alerts.",
      action: "profile"
    };
  }

  const primaryAction = nextStep.action === "push"
    ? {
        id: "push",
        label: "Subscribe",
        icon: "bell"
      }
    : {
        id: "push",
        label: "Subscribe",
        icon: "clipboard"
      };

  const checklist = [
    {
      title: "Install On Phone",
      value: installRequired ? (installed ? "Installed" : "Needed") : "Not needed",
      detail: installRequired
        ? `Open the installed ${APP_TITLE} app from your Home Screen before you finish alert setup.`
        : "Phone installation is only required on mobile devices.",
      complete: installed
    },
    {
      title: "Notifications",
      value: !pushSupported
        ? "Unavailable"
        : notificationGranted
          ? "Allowed"
          : pushPermission === "denied"
            ? "Blocked"
            : "Not allowed",
      detail: pushSupported
        ? "This browser must allow notifications before urgent alerts can appear."
        : "Notifications will become available once this device runs in a supported installed app.",
      complete: notificationGranted
    },
    {
      title: "Device status",
      value: pushSupported
        ? (pushReady ? "Active" : pushPermission === "denied" ? "Blocked" : pushSubscribed ? currentPush.serverLabel : "Available")
        : "Unavailable",
      detail: pushReady
        ? "This device is eligible for HR test alerts."
        : pushSupported
          ? "Subscribe this browser and keep it Active so urgent alerts can reach this device."
          : "This browser cannot use web push.",
      complete: pushReady
    }
  ];

  return {
    employeeName: signedInEmployeeName,
    installRequired,
    installed,
    pushSupported,
    pushSubscribed,
    pushPermission,
    busy: Boolean(state.push.busy),
    ready: installed && notificationGranted && pushReady,
    currentPush,
    nextStep,
    primaryAction,
    checklist
  };
}

async function loadPushStatus() {
  try {
    const result = await requestJson("/api/push/status");
    state.pushStatus = {
      loaded: true,
      supported: Boolean(result.supported),
      subscriptions: Number(result.subscriptions || 0),
      authorizedSubscriptions: Number(result.authorizedSubscriptions || 0),
      inactiveSubscriptions: Number(result.inactiveSubscriptions || 0),
      devices: Array.isArray(result.devices) ? result.devices : []
    };
  } catch {
    state.pushStatus = {
      loaded: true,
      supported: false,
      subscriptions: 0,
      authorizedSubscriptions: 0,
      inactiveSubscriptions: 0,
      devices: []
    };
  }

  return state.pushStatus;
}

async function syncPushState() {
  const supported = supportsPushNotifications();
  state.push.supported = supported;
  state.push.permission = supported && "Notification" in window ? Notification.permission : "unsupported";
  state.push.ready = false;
  state.push.error = "";
  state.push.endpoint = "";

  if (!supported) {
    state.push.subscribed = false;
    return state.push;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    state.push.subscribed = Boolean(subscription);
    state.push.endpoint = subscription?.endpoint || "";
    state.push.ready = true;
  } catch (error) {
    state.push.subscribed = false;
    state.push.endpoint = "";
    state.push.error = error instanceof Error ? error.message : "Could not read notification state.";
  }

  if (!state.loading) {
    render();
  }

  return state.push;
}

async function enablePushAlerts(profile = state.deviceProfile) {
  const browser = browserNameFromUserAgent();
  const platform = platformNameFromUserAgent();
  let failureStep = "unknown";

  async function reportPushSubscribeFailure(error, step) {
    const errorMessage = error instanceof Error ? error.message : String(error || "Unknown error");

    try {
      await requestJson("/api/push/subscribe-failure", {
        method: "POST",
        body: JSON.stringify({
          browser,
          platform,
          step,
          errorMessage
        })
      });
    } catch {
      // Ignore logging failures so the original subscribe failure remains visible.
    }
  }

  if (!supportsPushNotifications()) {
    const error = new Error("This browser does not support push alerts.");
    await reportPushSubscribeFailure(error, "unsupported-browser");
    throw error;
  }

  if (Notification.permission === "denied") {
    const error = new Error("Notification access is turned off for this site.");
    await reportPushSubscribeFailure(error, "permission-blocked");
    throw error;
  }

  state.push.busy = true;
  render();
  let pushError = null;

  try {
    failureStep = "request-permission";
    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      throw new Error("Notification permission was not granted.");
    }

    failureStep = "load-push-config";
    const { publicKey } = await requestJson("/api/push/config");
    failureStep = "service-worker-ready";
    const registration = await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    let createdSubscription = false;

    if (!subscription) {
      failureStep = "browser-subscribe";
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      createdSubscription = true;
    }

    try {
      failureStep = "server-enroll";
      await requestJson("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify({
          subscription: typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription,
          deviceId: profile.deviceId,
          label: state.access.employee.employee?.name || profile.label,
          browser,
          platform,
          userAgent: navigator.userAgent,
          createdAt: profile.updatedAt || nowIso(),
          updatedAt: nowIso()
        })
      })
    } catch (error) {
      if (createdSubscription && subscription && typeof subscription.unsubscribe === "function") {
        try {
          await subscription.unsubscribe();
        } catch {
          // Ignore cleanup failures after a rejected enrollment attempt.
        }
      }

      throw error;
    }

    state.push.permission = permission;
    state.push.subscribed = true;
    state.push.ready = true;
    state.push.error = "";
    setMessage("Subscribed this device to push alerts.", "success");
  } catch (error) {
    pushError = error instanceof Error ? error : new Error("Could not subscribe this device.");
    await reportPushSubscribeFailure(pushError, failureStep);
    state.push.error = formatPushError(pushError, "Could not subscribe this device.");
    throw pushError;
  } finally {
    state.push.busy = false;
    await loadPushStatus();
    await syncPushState();
    if (pushError) {
      state.push.error = formatPushError(pushError, "Could not subscribe this device.");
    }
  }
}

async function disablePushAlerts() {
  if (!supportsPushNotifications()) {
    throw new Error("This browser does not support push alerts.");
  }

  state.push.busy = true;
  render();
  let pushError = null;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      await subscription.unsubscribe();
      await requestJson("/api/push/unsubscribe", {
        method: "POST",
        body: JSON.stringify({
          endpoint: subscription.endpoint
        })
      });
    }

    state.push.subscribed = false;
    state.push.error = "";
    setMessage("Turned off push alerts on this device.", "success");
  } catch (error) {
    pushError = error instanceof Error ? error : new Error("Could not turn off alerts.");
    state.push.error = formatPushError(pushError, "Could not turn off alerts.");
    throw pushError;
  } finally {
    state.push.busy = false;
    await loadPushStatus();
    await syncPushState();
    if (pushError) {
      state.push.error = formatPushError(pushError, "Could not turn off alerts.");
    }
  }
}

async function sendTestPush() {
  state.push.busy = true;
  render();
  let pushError = null;

  try {
    const result = await requestJson("/api/push/test", {
      method: "POST",
      body: JSON.stringify({})
    });

    await loadPushStatus();

    const total = Number(result.total || 0);
    const authorized = Number(result.authorized || 0);
    const delivered = Number(result.delivered || 0);
    const removed = Number(result.removed || 0);
    const skipped = Number(result.skipped || 0);

    if (total <= 0) {
      setMessage("No devices are enrolled for push yet. Subscribe at least one phone or browser first.", "warning");
    } else if (authorized <= 0) {
      setMessage(`Found ${total} enrolled device${total === 1 ? "" : "s"}, but none are Active yet. Employees need to reopen the portal and refresh alerts on their device.`, "warning");
    } else if (delivered <= 0) {
      setMessage(`Found ${authorized} Active device${authorized === 1 ? "" : "s"}, but none confirmed delivery. Reopen the portal on the target device and refresh push setup there.`, "warning");
    } else if (skipped > 0 && removed > 0) {
      setMessage(
        `Test push reached ${delivered}/${authorized} Active device${authorized === 1 ? "" : "s"}; ${skipped} device${skipped === 1 ? "" : "s"} still need attention and ${removed} stale subscription${removed === 1 ? "" : "s"} were removed.`,
        "success"
      );
    } else if (skipped > 0) {
      setMessage(
        `Test push reached ${delivered}/${authorized} Active device${authorized === 1 ? "" : "s"}; ${skipped} enrolled device${skipped === 1 ? "" : "s"} still need refresh.`,
        "success"
      );
    } else if (removed > 0) {
      setMessage(
        `Test push reached ${delivered}/${authorized} Active device${authorized === 1 ? "" : "s"}; ${removed} stale subscription${removed === 1 ? "" : "s"} were removed.`,
        "success"
      );
    } else {
      setMessage(`Test push reached ${delivered}/${authorized} Active device${authorized === 1 ? "" : "s"}.`, "success");
    }

    state.push.error = "";
  } catch (error) {
    pushError = error instanceof Error ? error : new Error("Could not send a test push.");
    state.push.error = formatPushError(pushError, "Could not send a test push.");
    throw pushError;
  } finally {
    state.push.busy = false;
    if (pushError) {
      state.push.error = formatPushError(pushError, "Could not send a test push.");
    }
    render();
    clearMessageSoon();
  }
}

async function unsubscribeDevice(endpoint) {
  const cleanEndpoint = String(endpoint || "").trim();

  if (!cleanEndpoint) {
    throw new Error("Subscription endpoint is required.");
  }

  await requestJson("/api/push/unsubscribe", {
    method: "POST",
    body: JSON.stringify({
      endpoint: cleanEndpoint
    })
  });

  await loadPushStatus();
  await syncPushState();
}

function renderTestPushControl() {
  if (state.push.busy) {
    return `<span class="status-chip muted">${icon("refresh")} Sending test...</span>`;
  }

  return `<button class="ghost-button" type="button" data-send-test-push>${icon("send")} Send Test Push</button>`;
}

function compactDeviceChecklistTitle(title) {
  return {
    "Install on phone": "Install",
    "Install On Phone": "App",
    Notifications: "Notify",
    "Device status": "Status"
  }[title] || title;
}

function renderDeviceChecklistItem(item, compact = false) {
  const title = compact ? compactDeviceChecklistTitle(item.title) : item.title;

  return `
    <article class="device-setup-step ${compact ? "compact" : ""} ${item.complete ? "complete" : "missing"}">
      <div class="device-setup-step-head">
        <strong>${escapeHtml(title)}</strong>
        <span class="status-chip ${item.complete ? "muted" : "warning"}">${item.complete ? icon("check") : icon("alert")} ${escapeHtml(item.value)}</span>
      </div>
    </article>
  `;
}

function installGuideSteps() {
  if (isIosDevice()) {
    return [
      "Open this page in Safari.",
      "Tap the Share button.",
      "Tap Add to Home Screen.",
      `Open the ${APP_TITLE} app from your Home Screen.`,
      "Return to Account and finish setup."
    ];
  }

  if (navigator.userAgent.toLowerCase().includes("android")) {
    return [
      "Open this page in Chrome.",
      "Tap the three dots.",
      "Tap Install app or Add to Home screen.",
      `Open the ${APP_TITLE} app from your Home Screen.`,
      "Return to Account and finish setup."
    ];
  }

  return [
    "Open this page on your phone.",
    "Use the browser menu or Share button.",
    "Tap Install app or Add to Home Screen.",
    `Open the ${APP_TITLE} app from your Home Screen.`,
    "Return to Account and finish setup."
  ];
}

function renderInstallGuideToggle() {
  return `
    <details class="employee-install-guide"${state.employeeInstallGuideOpen ? " open" : ""} data-employee-install-guide>
      <summary class="ghost-button employee-install-guide-toggle">Install On Phone</summary>
      <div class="employee-install-guide-body">
        <ol class="employee-install-guide-list">
          ${installGuideSteps().map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
        </ol>
      </div>
    </details>
  `;
}

function renderEmployeeSubscriptionBanner(setup) {
  if (setup.ready) return "";

  return `
    <section class="employee-subscription-banner warning" aria-label="Subscribe to alerts">
      ${renderEmployeeSetupWizard()}
    </section>
  `;
}

function renderEmployeeSetupWizard() {
  const setup = buildEmployeeSetupState();
  const busy = setup.busy;
  const currentDevice = setup.currentPush.device;
  const secondaryAction = resolveDeviceSetupSecondaryAction({
    hasCurrentDevice: Boolean(currentDevice?.endpoint)
  });
  const formMarkup = `
    <form class="device-setup-form" data-device-setup-form>
      <div class="device-setup-actions">
        <button class="button employee-subscribe-button" type="submit" data-device-action="${escapeHtml(setup.primaryAction.id)}" aria-label="${escapeHtml(setup.primaryAction.label)}" ${busy ? "disabled aria-disabled=\"true\"" : ""}>
          ${icon(setup.primaryAction.icon)} Sign up for alerts
        </button>
        ${secondaryAction === "disable-alerts" ? `
          <button class="ghost-button" type="button" data-disable-alerts ${busy ? "disabled aria-disabled=\"true\"" : ""}>
            ${icon("delete")} Unenroll
          </button>
        ` : ""}
      </div>
    </form>
  `;

  return `
    <section class="tool-panel panel-card employee-setup-panel employee-setup-embedded employee-setup-embedded-minimal">
      ${formMarkup}
      ${state.push.error ? `<p class="panel-copy employee-alert-error">${escapeHtml(state.push.error)}</p>` : ""}
    </section>
  `;
}

function renderNotificationDeviceRoster(devices = [], emptyLabel = "No devices enrolled yet.") {
  if (!Array.isArray(devices) || !devices.length) {
    return `<div class="empty-state compact">${escapeHtml(emptyLabel)}</div>`;
  }

  return `
    <div class="device-roster">
      ${devices
        .map(
          (device) => `
            <article class="device-row ${device.authorized ? "active" : "inactive"}">
              <div class="device-row-head">
                <div>
                  <strong>${escapeHtml(device.label || "Device")}</strong>
                  <span>Web push</span>
                </div>
                <span class="sync-pill ${device.authorized ? "device-access-active" : "device-access-inactive"}">${escapeHtml(device.accessState || "Open")}</span>
              </div>
              <p>${escapeHtml(device.detail || "Unknown device")}</p>
              <div class="device-row-footer">
                <small>${escapeHtml(device.updatedAt ? `Updated ${formatDate(device.updatedAt)}` : "No update time recorded")}</small>
                <form class="device-row-actions" data-unsubscribe-device-form>
                  <input type="hidden" name="endpoint" value="${escapeHtml(device.endpoint || "")}">
                  <button class="ghost-button" type="submit" data-unsubscribe-device title="Remove this device from alerts">
                    ${icon("delete")} Unsubscribe
                  </button>
                </form>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderWebmasterPushActions() {
  return `
    <div class="employee-alert-actions admin-alert-actions">
      ${renderTestPushControl()}
    </div>
  `;
}

function isExpired(post) {
  if (!post.expiresAt) return false;
  const endOfDay = new Date(`${post.expiresAt}T23:59:59`);
  return endOfDay < new Date();
}

function priorityClass(priority) {
  return String(priority || "Normal").toLowerCase();
}

function typeIcon(type) {
  return {
    "HR": "users",
    HR: "users",
    News: "news",
    Weather: "cloud",
    Safety: "shield",
    Shift: "board"
  }[type] || "bell";
}

function visiblePosts() {
  return state.posts
    .filter((post) => !isExpired(post))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderNotice(post) {
  const safePriority = priorityClass(post.priority);
  const acknowledgementSummary = post.acknowledgementSummary || null;
  const acknowledged = Number(acknowledgementSummary?.acknowledged || 0);
  const totalEmployees = Number(acknowledgementSummary?.totalEmployees || 0);
  const pending = Number(acknowledgementSummary?.pending || Math.max(0, totalEmployees - acknowledged));
  const acknowledgementList = Array.isArray(post.acknowledgements) ? post.acknowledgements : [];

  return `
    <article class="notice-card priority-${safePriority}">
      <div class="notice-meta">
        <span class="notice-type">${icon(typeIcon(post.type))}${escapeHtml(post.type)}</span>
        <span class="priority-pill ${safePriority}">${escapeHtml(post.priority)}</span>
        ${post.requiresAcknowledgement ? `<span class="sync-pill acknowledgement-pill">${icon("check")} Read ${acknowledged}/${totalEmployees}</span>` : ""}
        <span class="notice-date">${escapeHtml(formatDate(post.createdAt))}</span>
      </div>
      <h2>${escapeHtml(post.title)}</h2>
      <p>${escapeHtml(post.body)}</p>
      <div class="notice-footer">
        <span>${escapeHtml(post.audience || "All employees")}</span>
        <span>Expires: ${escapeHtml(formatDate(post.expiresAt))}</span>
        ${post.requiresAcknowledgement ? `<span>${escapeHtml(`${pending} pending acknowledgement${pending === 1 ? "" : "s"}`)}</span>` : ""}
      </div>
      ${post.requiresAcknowledgement ? `
        <div class="acknowledgement-roster">
          ${
            acknowledgementList.length
              ? acknowledgementList.slice(0, 8).map((entry) => `<span>${escapeHtml(entry.employeeName || entry.username || "Employee")} · ${escapeHtml(formatDate(entry.acknowledgedAt))}</span>`).join("")
              : "<span>No acknowledgements yet.</span>"
          }
        </div>
      ` : ""}
    </article>
  `;
}

function renderFeedItem(post) {
  const safePriority = priorityClass(post.priority);
  const feedType = String(post.type || "Update");
  const feedTime = formatDate(post.createdAt);
  const feedTitle = String(post.title || "Update");
  const feedBody = String(post.body || "");
  const feedPriority = String(post.priority || "Normal");
  const createdAt = String(post.createdAt || "");

  return `
    <article class="feed-item priority-${safePriority}">
      <div class="feed-main">
        <div class="feed-head">
          <div class="feed-head-meta">
            <span class="feed-type">${escapeHtml(feedType)}</span>
            ${feedPriority !== "Normal" ? `<span class="priority-pill ${safePriority}">${escapeHtml(feedPriority)}</span>` : ""}
          </div>
          <div class="feed-head-side">
            <time class="feed-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(feedTime)}</time>
          </div>
        </div>
        <h2 class="feed-title">${escapeHtml(feedTitle)}</h2>
        <p class="feed-body">${escapeHtml(feedBody)}</p>
      </div>
    </article>
  `;
}

function renderManagedFeedItem(post) {
  const safePriority = priorityClass(post.priority);
  const feedType = String(post.type || "Update");
  const feedTime = formatDate(post.createdAt);
  const feedTitle = String(post.title || "Update");
  const feedBody = String(post.body || "");
  const feedPriority = String(post.priority || "Normal");
  const createdAt = String(post.createdAt || "");
  const audience = String(post.audience || "All employees");

  return `
    <article class="feed-item managed-feed-item priority-${safePriority}" data-managed-post-id="${escapeHtml(post.id)}">
      <div class="feed-main">
        <div class="feed-head">
          <div class="feed-head-meta">
            <span class="feed-type">${escapeHtml(feedType)}</span>
            ${feedPriority !== "Normal" ? `<span class="priority-pill ${safePriority}">${escapeHtml(feedPriority)}</span>` : ""}
          </div>
          <div class="feed-head-side">
            <time class="feed-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(feedTime)}</time>
          </div>
        </div>
        <h2 class="feed-title">${escapeHtml(feedTitle)}</h2>
        <p class="feed-body">${escapeHtml(feedBody)}</p>
        <div class="notice-footer">
          <span>${escapeHtml(audience)}</span>
          <span>${post.expiresAt ? `Expires ${escapeHtml(formatDate(post.expiresAt))}` : "No expiration set"}</span>
        </div>
      </div>
      <form class="post-controls" data-delete-post-form>
        <input type="hidden" name="id" value="${escapeHtml(post.id)}">
        <button class="ghost-button" type="submit" data-delete-post="${escapeHtml(post.id)}" title="Take down announcement">
          ${icon("delete")} Take down
        </button>
      </form>
    </article>
  `;
}

function formatWeatherFreshness(updatedAt) {
  const updatedMs = Date.parse(String(updatedAt || ""));

  if (!Number.isFinite(updatedMs)) {
    return "not refreshed";
  }

  const elapsedMs = Math.max(0, Date.now() - updatedMs);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (elapsedMs < minuteMs) {
    return "just now";
  }

  if (elapsedMs < hourMs) {
    const minutes = Math.max(1, Math.round(elapsedMs / minuteMs));
    return `${minutes} min ago`;
  }

  if (elapsedMs < dayMs) {
    const hours = Math.max(1, Math.round(elapsedMs / hourMs));
    return `${hours} hr ago`;
  }

  return `${formatDate(updatedAt)} at ${formatTime(updatedAt)}`;
}

function renderEmployeeWeatherCard() {
  const weather = state.weather || defaultWeather();
  const condition = String(weather.condition || "Weather not configured");
  const temperature = String(weather.temperature || "--");
  const temperatureToneClass = getWeatherTemperatureToneClass(temperature);
  const highTemperature = String(weather.highTemperature || "--");
  const lowTemperature = String(weather.lowTemperature || "--");
  const location = formatCompactWeatherLocation(weather.resolvedName || weather.location);
  const hasWeatherUpdate = Number.isFinite(Date.parse(String(weather.updatedAt || "")));
  const updatedLabel = formatWeatherFreshness(weather.updatedAt);
  const updatedAriaLabel = hasWeatherUpdate ? `Updated ${updatedLabel}` : "Not refreshed";

  return `
    <section class="employee-weather-card employee-weather-card-two-line" aria-label="Current weather">
      <div class="employee-weather-line employee-weather-line-primary">
        <span class="employee-weather-current">
          <strong class="employee-weather-temperature ${temperatureToneClass}">${escapeHtml(temperature)}</strong>
          <span class="employee-weather-condition">${escapeHtml(condition)}</span>
        </span>
        <span class="employee-weather-range">
          <span class="employee-weather-range-item employee-weather-range-high" aria-label="High temperature"><span class="employee-weather-range-label" aria-hidden="true">▲</span> ${escapeHtml(highTemperature)}</span>
          <span class="employee-weather-range-item employee-weather-range-low" aria-label="Low temperature"><span class="employee-weather-range-label" aria-hidden="true">▼</span> ${escapeHtml(lowTemperature)}</span>
        </span>
      </div>
      <div class="employee-weather-line employee-weather-line-secondary">
        <span class="employee-weather-location">${escapeHtml(location)}</span>
        <span class="employee-weather-updated" aria-label="${escapeHtml(updatedAriaLabel)}">
          <span class="employee-weather-updated-symbol" aria-hidden="true">${icon("clock")}</span>
          <span>${escapeHtml(updatedLabel)}</span>
        </span>
      </div>
    </section>
  `;
}

function renderAccessPinPanel() {
  const snapshot = buildWebmasterSnapshot();
  const notifications = snapshot.notifications || {};
  const devices = state.pushStatus.loaded
    ? Number(state.pushStatus.subscriptions || 0)
    : Number(notifications.pushSubscriptions || 0);
  const activeDevices = state.pushStatus.loaded
    ? Number(state.pushStatus.authorizedSubscriptions || 0)
    : Number(notifications.activeSubscriptions || 0);

  return renderWebmasterExpandableCard({
    id: "overview-enrollment",
    eyebrow: "Enrollment",
    title: "Open device enrollment",
    description: "Employees can subscribe supported browsers directly and receive urgent updates on that device.",
    badge: "Open",
    iconName: "check",
    summaryMetrics: [
      { label: "Subscribed", value: String(devices) },
      { label: "Active", value: String(activeDevices) },
      { label: "Push", value: state.pushStatus.supported ? "Ready" : "Off" }
    ],
    body: `
      <div class="push-metrics">
        <div class="push-metric">
          <strong>${escapeHtml(String(devices))}</strong>
          <span>Subscribed devices</span>
        </div>
        <div class="push-metric">
          <strong>${escapeHtml(state.pushStatus.supported ? "Ready" : "Off")}</strong>
          <span>Device status</span>
        </div>
      </div>

      ${renderWebmasterPushActions()}
    `
  });
}

function loginAutocompleteSection(route = "employee") {
  const normalizedRoute = route === "it" ? "it" : route === "webmaster" ? "webmaster" : route === "hr" ? "hr" : "employee";
  return `section-${normalizedRoute}`;
}

function renderEmployeeAuthGate() {
  const authError = state.access.employee.error || state.message;
  const employeeAutocompleteSection = loginAutocompleteSection("employee");

  return renderAuthFrame({
    title: "Employee sign in",
    error: authError,
    content: `
      <form class="auth-form" data-employee-login-form>
        <label class="field">
          <span>Username</span>
          <input name="username" maxlength="80" required autocomplete="${escapeHtml(employeeAutocompleteSection)} username" aria-label="Username">
        </label>
        <label class="field">
          <span>Password</span>
          <input name="password" type="password" minlength="10" required autocomplete="${escapeHtml(employeeAutocompleteSection)} current-password">
        </label>
        <div class="auth-form-actions">
          <button class="button" type="submit">Sign In</button>
        </div>
      </form>
    `
  });
}

function renderAdminInviteGate(route) {
  const details = state.adminInvite.details || {};
  const adminUser = details.adminUser || {};
  const roles = Array.isArray(adminUser.roles) ? adminUser.roles.map((role) => adminRoleLabel(role)).join(", ") : "Admin";
  const inviteError = state.adminInvite.error || state.message;

  if (!state.adminInvite.loaded && currentInviteToken()) {
    return renderAuthFrame({
      title: "Loading invitation",
      error: "",
      content: '<div class="auth-form"></div>'
    });
  }

  if (!state.adminInvite.details) {
    return renderAuthFrame({
      title: "Invitation unavailable",
      error: inviteError || "That invitation link is no longer valid.",
      content: `
        <div class="auth-form">
          <div class="auth-form-actions">
            <button class="button" type="button" data-route="launcher">Launcher</button>
            <button class="ghost-button" type="button" data-route="${escapeHtml(route)}">Back to Sign In</button>
          </div>
        </div>
      `
    });
  }

  return renderAuthFrame({
    title: "Accept invitation",
    error: inviteError,
    content: `
      <div class="auth-form auth-recovery-stack">
        <div class="invite-summary">
          <div class="invite-summary-row"><strong>${escapeHtml(adminUser.displayName || adminUser.username || "Admin")}</strong></div>
          <div class="invite-summary-row">${escapeHtml(`@${adminUser.username || ""} · ${roles}`)}</div>
          <div class="invite-summary-row">${escapeHtml(adminUser.inviteExpiresAt ? `Expires ${formatDate(adminUser.inviteExpiresAt)}` : "")}</div>
        </div>
        <form class="auth-form" data-accept-admin-invite-form>
          <label class="field">
            <span>Create password</span>
            <input name="password" type="password" minlength="10" required autocomplete="new-password">
          </label>
          <label class="field">
            <span>Confirm password</span>
            <input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password">
          </label>
          <div class="auth-form-actions">
            <button class="button" type="submit"${state.adminInvite.busy ? " disabled" : ""}>${escapeHtml(state.adminInvite.busy ? "Saving..." : "Accept Invite")}</button>
            <button class="ghost-button" type="button" data-route="launcher">Launcher</button>
          </div>
        </form>
      </div>
    `
  });
}

function renderAdminMfaPanel(route = "hr", { compact = false } = {}) {
  const normalizedRoute = route === "it" ? "it" : route === "webmaster" ? "webmaster" : "hr";
  const access = state.access[normalizedRoute] || state.access.hr;
  const mfa = access.user?.mfa || {};
  if (mfa.available === false) {
    return "";
  }
  const setup = readAdminMfaState(normalizedRoute);
  const roleLabel = normalizedRoute === "it" ? "IT" : normalizedRoute === "webmaster" ? "System Ops" : "HR";
  const needsVerify = access.mfaRequired && access.mfaMode === "verify";
  const needsSetup = access.mfaRequired && access.mfaMode === "setup";
  const showEnrollment = Boolean(setup.details);
  return `
    <section class="panel-card settings-credential-card">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("shield")} Multi-factor authentication</p>
          <h3>${escapeHtml(roleLabel)} Google Authenticator</h3>
        </div>
        <span class="admin-table-chip ${mfa.status === "enabled" ? "is-positive" : mfa.status === "grace" ? "is-info" : "is-muted"}">${escapeHtml(mfa.status === "enabled" ? "Enabled" : mfa.status === "grace" ? "Grace" : "Required")}</span>
      </div>
      ${showEnrollment ? `
        <div class="auth-recovery-stack">
          <div class="invite-summary">
            <div class="invite-summary-row">${setup.details.qrCodeDataUrl ? `<img class="authenticator-qr-code" src="${escapeHtml(setup.details.qrCodeDataUrl)}" alt="Authenticator QR code">` : ""}</div>
            <div class="invite-summary-row">${escapeHtml(setup.details.manualEntryKey || "")}</div>
          </div>
          <form class="auth-form" data-admin-mfa-verify-form data-admin-route="${escapeHtml(normalizedRoute)}">
            <label class="field">
              <span>6-digit code</span>
              <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code">
            </label>
            <button class="button" type="submit"${setup.busy ? " disabled" : ""}>${escapeHtml(setup.busy ? "Verifying..." : "Verify Authenticator")}</button>
          </form>
        </div>
      ` : needsVerify ? `
        <form class="auth-form" data-admin-mfa-verify-form data-admin-route="${escapeHtml(normalizedRoute)}">
          <label class="field">
            <span>6-digit code</span>
            <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code">
          </label>
          <button class="button" type="submit"${setup.busy ? " disabled" : ""}>${escapeHtml(setup.busy ? "Verifying..." : "Verify Code")}</button>
        </form>
      ` : mfa.status === "enabled" && !needsSetup ? `

      ` : `
        <form class="auth-form" data-admin-mfa-enroll-form data-admin-route="${escapeHtml(normalizedRoute)}">
          <button class="button" type="submit"${setup.busy ? " disabled" : ""}>${escapeHtml(setup.busy ? "Preparing..." : compact ? "Set Up Google Authenticator" : "Generate Google Authenticator QR")}</button>
        </form>
      `}
    </section>
  `;
}

function renderAdminAuthGate(route) {
  const normalizedRoute = route === "it" ? "it" : route === "webmaster" ? "webmaster" : "hr";
  const access = state.access[normalizedRoute] || state.access.hr;
  const sectionTitle = normalizedRoute === "it" ? "IT" : normalizedRoute === "webmaster" ? "System Ops" : "HR";
  const adminAutocompleteSection = loginAutocompleteSection(normalizedRoute);
  const inviteToken = currentInviteToken();
  const authError = access.error || state.message;
  const canSetup = normalizedRoute === "it" || normalizedRoute === "hr" ? access.setupRequired : (access.setupRequired && access.hrAuthorized);
  const adminPasswordAutocomplete = canSetup ? "new-password" : "current-password";
  const setupBlocked = normalizedRoute === "webmaster" && access.setupRequired && !access.hrAuthorized;
  const recoveryMode = normalizedRoute === "hr"
    ? state.authRecovery.hr
    : normalizedRoute === "webmaster"
      ? state.authRecovery.webmaster
      : false;

  if (inviteToken) {
    return renderAdminInviteGate(normalizedRoute);
  }

  const heading = access.mfaRequired
    ? access.mfaMode === "verify"
      ? `${sectionTitle} authenticator check`
      : `Set up ${sectionTitle} Google Authenticator`
    : recoveryMode
    ? `Reset ${sectionTitle} access`
    : setupBlocked
      ? `${sectionTitle} not ready`
      : canSetup
        ? `Create first ${sectionTitle} admin`
        : `${sectionTitle} sign in`;

  return renderAdminAuthFrame({
    route: normalizedRoute,
    title: heading,
    error: authError,
    content: access.mfaRequired
      ? renderAdminMfaPanel(normalizedRoute, { compact: true })
      : recoveryMode
      ? normalizedRoute === "hr"
        ? `
          <form class="auth-form admin-auth-form" data-hr-master-recovery-form>
            <label class="field">
              <span>Recovery key</span>
              <input name="recoveryToken" type="password" required autocomplete="one-time-code">
            </label>
            <label class="field">
              <span>New password</span>
              <input name="password" type="password" minlength="10" required autocomplete="new-password">
            </label>
            <label class="field">
              <span>Confirm new password</span>
              <input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password">
            </label>
            <button class="button admin-auth-submit" type="submit">Recover With Recovery Key</button>
          </form>
        `
        : `
          <div class="admin-auth-primary-actions">
          <button class="button admin-auth-submit" type="button" data-route="webmaster">Back to Systems Sign In</button>
          </div>
        `
      : setupBlocked
      ? `
        <div class="admin-auth-primary-actions">
          <button class="button admin-auth-submit" type="button" data-route="hr">Open HR</button>
        </div>
      `
      : `
        <form class="auth-form admin-auth-form" data-admin-auth-form data-admin-auth-mode="${escapeHtml(canSetup ? "setup" : "login")}" data-admin-route="${escapeHtml(normalizedRoute)}">
          ${(normalizedRoute === "it" || normalizedRoute === "hr") && canSetup ? `
          <label class="field">
            <span>Deployment setup secret</span>
            <input name="setupToken" type="password" required autocomplete="one-time-code">
          </label>
          ` : ""}
          <label class="field">
            <span>${escapeHtml(canSetup ? "Create username" : "Username")}</span>
            <input name="username" maxlength="80" required autocomplete="${escapeHtml(adminAutocompleteSection)} username" aria-label="${escapeHtml(canSetup ? "Create username" : "Username")}">
          </label>
          <label class="field">
            <span>${escapeHtml(canSetup ? "Create password" : "Password")}</span>
            <input name="password" type="password" minlength="10" required autocomplete="${escapeHtml(adminAutocompleteSection)} ${escapeHtml(adminPasswordAutocomplete)}">
          </label>
          <button class="button admin-auth-submit" type="submit">${escapeHtml(canSetup ? "Save Credentials" : "Sign In")}</button>
        </form>
      `,
    footer: access.mfaRequired
      ? `
        <div class="admin-auth-footer-actions">
          <button class="auth-inline-action" type="button" data-route="launcher">Back to Launcher</button>
        </div>
      `
      : recoveryMode
      ? `
        <div class="admin-auth-footer-actions">
          <button class="auth-inline-action" type="button" data-close-auth-recovery="${escapeHtml(normalizedRoute)}">Back to Sign In</button>
          <button class="auth-inline-action" type="button" data-route="launcher">Back to Launcher</button>
        </div>
      `
      : setupBlocked
      ? `
        <div class="admin-auth-footer-actions">
          <button class="auth-inline-action" type="button" data-route="launcher">Back to Launcher</button>
        </div>
      `
      : canSetup
      ? `
        <div class="admin-auth-footer-actions">
          <button class="auth-inline-action" type="button" data-route="launcher">Back to Launcher</button>
        </div>
      `
      : `
        <div class="admin-auth-footer-actions">
          ${normalizedRoute === "it" ? "" : `<button class="auth-inline-action" type="button" data-open-auth-recovery="${escapeHtml(normalizedRoute)}">Forgot Password?</button>`}
          <button class="auth-inline-action" type="button" data-route="launcher">Back to Launcher</button>
        </div>
      `
  });
}

function renderEmployeeDirectoryRow(employee) {
  return `
    <tr>
      <td>
        <div class="admin-table-primary">${escapeHtml(employee.name || employee.username)}</div>
      </td>
      <td>
        <div class="admin-table-primary">@${escapeHtml(employee.username)}</div>
        <div class="admin-table-secondary">${escapeHtml(employee.passwordResetRequired ? "Password reset required" : "Password ready")}</div>
      </td>
      <td>
        <span class="admin-table-chip ${employee.active ? "is-positive" : "is-muted"}">${escapeHtml(employee.active ? "Active" : "Disabled")}</span>
        <div class="admin-table-secondary">${escapeHtml(employee.hrAdmin ? "HR access enabled" : "Employee access only")}</div>
      </td>
      <td>
        <div class="admin-table-primary">${escapeHtml(String(employee.activeSessions || 0))}</div>
        <div class="admin-table-secondary">${escapeHtml(employee.lastLoginAt ? `Last Login ${formatDate(employee.lastLoginAt)}` : "No Login Yet")}</div>
      </td>
      <td>
        <div class="admin-table-primary">${escapeHtml(String(employee.authorizedDevices || 0))}</div>
        <div class="admin-table-secondary">${escapeHtml(`${employee.devices || 0} Total Enrolled`)}</div>
        <form class="employee-device-inline-form" data-unenroll-employee-devices-form>
          <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}">
          <button class="ghost-button" type="submit"${employee.devices ? "" : " disabled"}>
            ${icon("delete")} Unenroll
          </button>
        </form>
      </td>
      <td>
        <form class="admin-table-inline-form employee-password-inline-form" data-reset-employee-password-form>
          <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}">
          <input name="password" type="password" minlength="10" required autocomplete="new-password">
          <button class="ghost-button" type="submit">${icon("lock")} Reset</button>
        </form>
      </td>
      <td>
        <div class="admin-table-actions">
          <form data-employee-access-form>
            <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}">
            <input type="hidden" name="active" value="${employee.active ? "false" : "true"}">
            <button class="ghost-button" type="submit">${employee.active ? `${icon("alert")} Disable Access` : `${icon("check")} Enable Access`}</button>
          </form>
          <form data-revoke-employee-sessions-form>
            <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}">
            <button class="ghost-button" type="submit">${icon("refresh")} Sign Out Sessions</button>
          </form>
          <form data-add-employee-hr-group-form>
            <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}">
            <button class="ghost-button" type="submit"${employee.hrAdmin || !employee.active ? " disabled" : ""}>${icon("users")} Add to HR</button>
          </form>
          <form data-delete-employee-form>
            <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}">
            <input type="hidden" name="employeeName" value="${escapeHtml(employee.name || employee.username)}">
            <button class="ghost-button danger" type="submit">${icon("delete")} Delete Account</button>
          </form>
        </div>
      </td>
    </tr>
  `;
}

function adminRoleLabel(role) {
  return role === "it" ? "IT" : role === "webmaster" ? "System Ops" : "HR";
}

function renderAdminRoleChips(roles = []) {
  return roles.length
    ? roles.map((role) => `<span class="admin-table-chip is-info">${escapeHtml(adminRoleLabel(role))}</span>`).join("")
    : '<span class="admin-table-chip is-muted">No role</span>';
}

function adminInviteStatusText(adminUser) {
  if (adminUser.credentialsConfigured) {
    return adminUser.lastLoginAt ? `Last Login ${formatDate(adminUser.lastLoginAt)}` : "No Login Yet";
  }

  return "Credentials Not Configured";
}

function renderAdminRoleCell(adminUser, scope = "hr") {
  const roles = Array.isArray(adminUser.roles) ? adminUser.roles : [];
  const isCurrentUser = Boolean(adminUser.currentUser);
  const normalizedScope = normalizeAdminScope(scope);
  const selectedRole = roles[0] || "";

  if (normalizedScope === "it") {
    return `
      <div class="admin-role-cell">
        <div class="admin-role-chip-row">${renderAdminRoleChips(roles)}</div>
        <form class="admin-role-editor" data-update-admin-roles-form data-admin-scope="it">
          <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
          <label class="admin-role-checkbox">
            <input type="radio" name="roles" value="it" ${selectedRole === "it" ? "checked" : ""}>
            IT
          </label>
          <label class="admin-role-checkbox">
            <input type="radio" name="roles" value="hr" ${selectedRole === "hr" ? "checked" : ""}>
            HR
          </label>
          <label class="admin-role-checkbox">
            <input type="radio" name="roles" value="webmaster" ${selectedRole === "webmaster" ? "checked" : ""}>
            System Ops
          </label>
          <button class="ghost-button" type="submit">${icon("check")} Save Roles</button>
        </form>
        <div class="admin-table-secondary">
          ${escapeHtml(
            isCurrentUser
              ? "Current account must keep IT access while this session is active."
              : "IT assigns exactly one privileged role per named account."
          )}
        </div>
      </div>
    `;
  }

  if (normalizedScope !== "webmaster") {
    return `
      <div class="admin-role-cell">
        <div class="admin-role-chip-row">${renderAdminRoleChips(roles)}</div>
        <div class="admin-table-secondary">System Ops and IT roles stay outside the HR console.</div>
      </div>
    `;
  }

  return `
    <div class="admin-role-cell">
      <div class="admin-role-chip-row">${renderAdminRoleChips(roles)}</div>
      <div class="admin-table-secondary">
        ${escapeHtml(
          isCurrentUser
            ? "Current account must keep System Ops access while this session is active."
            : "System Ops accounts stay single-purpose and cannot be reclassified here."
        )}
      </div>
    </div>
  `;
}

function renderAdminDirectoryRow(adminUser, scope = "hr") {
  const isCurrentUser = Boolean(adminUser.currentUser);
  const identitySummary = [adminUser.username ? `@${adminUser.username}` : ""]
    .filter(Boolean)
    .join(" · ");
  const statusSummary = isCurrentUser
    ? `Current account${adminUser.lastLoginAt ? ` · Last Login ${formatDate(adminUser.lastLoginAt)}` : ""}`
    : adminInviteStatusText(adminUser);
  const scopeValue = normalizeAdminScope(scope);

  return `
    <tr>
      <td>
        <div class="admin-table-primary">${escapeHtml(adminUser.displayName || adminUser.username || "Unknown admin")}</div>
        <div class="admin-table-secondary">${escapeHtml(identitySummary)}</div>
        <div class="admin-table-secondary">${escapeHtml(statusSummary)}</div>
        <form class="admin-identity-form" data-update-admin-profile-form data-admin-scope="${escapeHtml(scopeValue)}">
          <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
          <div class="admin-identity-grid">
            <label class="field">
              <span>Display name</span>
              <input name="displayName" maxlength="120" required value="${escapeHtml(adminUser.displayName || "")}">
            </label>
          </div>
          <button class="ghost-button" type="submit">${icon("check")} Save Identity</button>
        </form>
        ${scopeValue !== "webmaster" ? `
        <form class="admin-delete-account-form" data-delete-admin-form data-admin-scope="${escapeHtml(scopeValue)}">
          <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
          <input type="hidden" name="adminName" value="${escapeHtml(adminUser.displayName || adminUser.username)}">
          <button class="ghost-button danger" type="submit"${isCurrentUser ? " disabled" : ""}>
            ${icon("delete")} Delete Account
          </button>
        </form>
        ` : ""}
      </td>
      <td>${renderAdminRoleCell(adminUser, scope)}</td>
      <td>
        <span class="admin-table-chip ${adminUser.active === false ? "is-muted" : "is-positive"}">
          ${escapeHtml(adminUser.active === false ? "Disabled" : "Active")}
        </span>
      </td>
      <td>
        <div class="admin-table-primary">${escapeHtml(String(adminUser.activeSessions || 0))}</div>
        <div class="admin-table-secondary">${escapeHtml(adminUser.activeSessions === 1 ? "Live session" : "Live sessions")}</div>
      </td>
      <td>
        <div class="admin-access-cell">
          <span class="admin-table-chip ${adminUser.credentialsConfigured ? "is-positive" : adminUser.inviteState === "expired" ? "is-muted" : "is-info"}">
            ${escapeHtml(
              adminUser.credentialsConfigured
                ? "Configured"
                : "Needs Password"
            )}
          </span>
          <form class="admin-table-inline-form admin-password-inline-form" data-reset-admin-password-form data-admin-scope="${escapeHtml(scopeValue)}">
            <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
            <input name="password" type="password" minlength="10" required autocomplete="new-password"${isCurrentUser ? " disabled" : ""}>
            <button class="ghost-button" type="submit"${isCurrentUser ? " disabled" : ""}>${icon("lock")} Reset</button>
          </form>
        </div>
      </td>
      <td>
        <div class="admin-table-actions">
          <form data-admin-access-form data-admin-scope="${escapeHtml(scopeValue)}">
            <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
            <input type="hidden" name="active" value="${adminUser.active ? "false" : "true"}">
            <button class="ghost-button" type="submit"${isCurrentUser ? " disabled" : ""}>
              ${adminUser.active ? `${icon("alert")} Disable Access` : `${icon("check")} Enable Access`}
            </button>
          </form>
          <form data-revoke-admin-sessions-form data-admin-scope="${escapeHtml(scopeValue)}">
            <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
            <button class="ghost-button" type="submit"${isCurrentUser ? " disabled" : ""}>${icon("refresh")} Sign Out Sessions</button>
          </form>
        </div>
      </td>
    </tr>
  `;
}

function renderAdminDirectoryTable(adminUsers, scope = "hr") {
  if (!adminUsers.length) {
    const emptyText = normalizeAdminScope(scope) === "it"
      ? "No Admin Accounts Yet."
      : normalizeAdminScope(scope) === "webmaster"
        ? "No System Ops Admin Accounts Yet."
        : "No HR Admin Accounts Yet.";
    return `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
  }

  return `
    <div class="admin-table-wrap">
      <table class="admin-table admin-table-admins">
        <thead>
          <tr>
            <th>Identity</th>
            <th>Roles</th>
            <th>Status</th>
            <th>Sessions</th>
            <th>Access</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${adminUsers.map((adminUser) => renderAdminDirectoryRow(adminUser, scope)).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAdminAccountsPanel(scope = "hr") {
  const normalizedScope = normalizeAdminScope(scope);
  const adminUsers = Array.isArray(readAdminDirectory(normalizedScope).adminUsers) ? readAdminDirectory(normalizedScope).adminUsers : [];
  const title = normalizedScope === "it" ? "Admin Accounts" : normalizedScope === "webmaster" ? "System Ops Admin Accounts" : "HR Admin Accounts";
  const countLabel = normalizedScope === "it" ? "Admin" : normalizedScope === "webmaster" ? "System Ops Admin" : "HR Admin";
  const roleControl = normalizedScope === "it"
    ? `
        <div class="field">
          <span>Role</span>
          <div class="admin-role-chip-row">
            <label class="admin-role-checkbox">
              <input name="roles" type="radio" value="it">
              IT
            </label>
            <label class="admin-role-checkbox">
              <input name="roles" type="radio" value="hr" checked>
              HR
            </label>
            <label class="admin-role-checkbox">
              <input name="roles" type="radio" value="webmaster">
              System Ops
            </label>
          </div>
        </div>
      `
    : normalizedScope === "webmaster"
    ? `
        <input name="roles" type="hidden" value="webmaster">
        <div class="field">
          <span>Role</span>
          <div class="admin-role-chip-row">${renderAdminRoleChips(["webmaster"])}</div>
        </div>
      `
    : `
        <input name="roles" type="hidden" value="hr">
        <div class="field">
          <span>Role</span>
          <div class="admin-role-chip-row">${renderAdminRoleChips(["hr"])}</div>
        </div>
      `;

  return `
    <section class="panel-card employee-access-card">
      <div class="employee-access-head">
        <div>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <span class="sync-pill">${escapeHtml(`${adminUsers.length} ${countLabel}${adminUsers.length === 1 ? "" : "s"}`)}</span>
      </div>

      <form class="employee-create-form admin-create-grid" data-create-admin-form data-admin-scope="${escapeHtml(normalizedScope)}">
        <label class="field">
          <span>Display name</span>
          <input name="displayName" maxlength="120" required>
        </label>
        <label class="field">
          <span>Username</span>
          <input name="username" maxlength="80" required>
        </label>
        <label class="field">
          <span>Temporary password</span>
          <input name="password" type="password" minlength="10" autocomplete="new-password">
        </label>
        ${roleControl}
        <div class="admin-create-actions">
          <button class="button employee-create-submit" type="submit" data-admin-create-action="password">${icon("lock")} Create Account</button>
        </div>
      </form>

      ${renderAdminDirectoryTable(adminUsers, normalizedScope)}
    </section>
  `;
}

function renderEmployeeDirectoryTable(employees) {
  if (!employees.length) {
    return '<div class="empty-state">No Employee Accounts Yet.</div>';
  }

  return `
    <div class="admin-table-wrap">
      <table class="admin-table admin-table-employees">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Username</th>
            <th>Status</th>
            <th>Sessions</th>
            <th>Devices</th>
            <th>Reset Password</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${employees.map((employee) => renderEmployeeDirectoryRow(employee)).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderEmployeeDirectoryPanel() {
  const employees = Array.isArray(state.employeeDirectory.employees) ? state.employeeDirectory.employees : [];

  return `
    <section class="panel-card employee-access-card">
      <div class="employee-access-head">
        <div>
          <h3>Employee Accounts</h3>
        </div>
        <span class="sync-pill">${escapeHtml(`${employees.length} Account${employees.length === 1 ? "" : "s"}`)}</span>
      </div>

      ${renderEmployeeDirectoryTable(employees)}
    </section>
  `;
}

function renderEmployeeCreatePanel() {
  return `
    <section class="panel-card employee-access-card">
      <details class="settings-collapse">
        <summary class="ghost-button settings-collapse-toggle">${icon("users")} Create User</summary>
        <form class="employee-create-form employee-create-grid" data-create-employee-form>
          <label class="field">
            <span>Name</span>
            <input name="name" maxlength="120" required>
          </label>
          <label class="field">
            <span>Username</span>
            <input name="username" maxlength="80" required>
          </label>
          <label class="field field-span-2">
            <span>Temporary password</span>
            <input name="password" type="password" minlength="10" required>
          </label>
          <label class="checkbox-row field-span-2">
            <input name="passwordResetRequired" type="checkbox" checked>
            <span>Require password reset on first use</span>
          </label>
          <button class="button employee-create-submit" type="submit">${icon("users")} Create Account</button>
        </form>
      </details>
    </section>
  `;
}

function employeeBatchCredentialRows() {
  return Array.isArray(state.employeeBatchUpload?.credentials) ? state.employeeBatchUpload.credentials : [];
}

function renderEmployeeBatchCredentialsPanel() {
  const credentials = employeeBatchCredentialRows();
  const created = Number(state.employeeBatchUpload?.created || credentials.length || 0);

  if (!credentials.length) {
    return "";
  }

  return `
    <div class="employee-batch-result" role="status" aria-live="polite">
      <div class="employee-access-head">
        <div>
          <h4>${escapeHtml(`${created} Imported`)}</h4>
        </div>
        <div class="employee-batch-actions">
          <button class="ghost-button" type="button" data-copy-employee-batch-credentials>${icon("clipboard")} Copy Credentials</button>
          <button class="ghost-button" type="button" data-clear-employee-batch-results>Clear</button>
        </div>
      </div>
      <div class="admin-table-wrap employee-batch-table-wrap">
        <table class="admin-table admin-table-employees">
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Temporary Password</th>
            </tr>
          </thead>
          <tbody>
            ${credentials
              .map(
                (credential) => `
                  <tr>
                    <td>${escapeHtml(credential.name || "")}</td>
                    <td>${escapeHtml(credential.username || "")}</td>
                    <td><code class="employee-batch-password">${escapeHtml(credential.temporaryPassword || "")}</code></td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderEmployeeBatchUploadPanel() {
  const batch = state.employeeBatchUpload || {};
  const busy = Boolean(batch.busy);
  const format = String(batch.format || "auto");
  const content = String(batch.content || "");
  const shouldOpen = busy || Boolean(content) || employeeBatchCredentialRows().length > 0;

  return `
    <section class="panel-card employee-access-card employee-batch-card">
      <details class="settings-collapse" ${shouldOpen ? "open" : ""}>
        <summary class="ghost-button settings-collapse-toggle">${icon("clipboard")} Batch Upload</summary>
        <form class="employee-batch-form" data-employee-batch-form>
          <div class="employee-batch-grid">
            <label class="field">
              <span>Format</span>
              <select name="format">
                <option value="auto" ${format === "auto" ? "selected" : ""}>Auto</option>
                <option value="json" ${format === "json" ? "selected" : ""}>JSON</option>
                <option value="yaml" ${format === "yaml" ? "selected" : ""}>YAML</option>
              </select>
            </label>
            <label class="field">
              <span>File</span>
              <input name="file" type="file" accept=".json,.yaml,.yml,application/json,text/yaml,text/x-yaml" data-employee-batch-file>
            </label>
            <label class="field field-span-2">
              <span>Employees</span>
              <textarea class="employee-batch-textarea" name="content" rows="11" required spellcheck="false">${escapeHtml(content)}</textarea>
            </label>
          </div>
          <div class="employee-batch-actions">
            <button class="button employee-create-submit" type="submit" ${busy ? "disabled" : ""}>${icon("users")} Import Employees</button>
          </div>
        </form>
        ${renderEmployeeBatchCredentialsPanel()}
      </details>
    </section>
  `;
}

function renderEmployee() {
  const notices = visiblePosts();
  const setup = buildEmployeeSetupState();

  return `
    <main class="page-shell employee-shell">
        <section class="employee-brand-banner" aria-label="${escapeHtml(APP_TITLE)} brand banner">
          <div class="employee-brand-banner-head">
            <div class="employee-brand-identity">
              <img class="employee-brand-banner-logo" src="/assets/palziv-logo-transparent.png?v=20260625b" alt="${escapeHtml(APP_TITLE)}" loading="eager" decoding="async">
              <div class="employee-brand-banner-copy">
                <p class="employee-brand-banner-kicker">Announcements &amp; Alerts</p>
              </div>
              ${renderEmployeeWeatherCard()}
            </div>
          </div>
        </section>

      ${renderAppUpdateBanner()}
      ${state.message ? `<div class="employee-banner ${escapeHtml(state.messageType)}">${escapeHtml(state.message)}</div>` : ""}
      ${renderEmployeeSubscriptionBanner(setup)}

      <section class="feed-shell feed-shell-quiet feed-shell-bare" aria-label="Latest updates feed">
        <div class="feed-list feed-list-quiet">
          ${
            notices.length
              ? notices.map((post) => renderFeedItem(post)).join("")
              : `<div class="empty-state">No updates are live right now.</div>`
          }
        </div>
      </section>

      <section class="employee-signout-floor" aria-label="Sign out">
        <button class="ghost-button employee-signout-button employee-footer-signout" type="button" data-employee-logout>Sign Out</button>
      </section>

    </main>
  `;
}

function renderLauncherCard(route, title) {
  return `
    <a class="launch-card" href="${escapeHtml(routePath(route))}" data-route="${escapeHtml(route)}">
      <strong class="launch-card-label">${escapeHtml(title)}</strong>
    </a>
  `;
}

function renderLauncherAdminCard(route, title) {
  return `
    <a class="launch-card" href="${escapeHtml(routePath(route))}" data-route="${escapeHtml(route)}">
      <strong class="launch-card-label">${escapeHtml(title)}</strong>
    </a>
  `;
}

function renderLauncher() {
  return `
    <main class="page-shell launcher-shell">
      ${renderAppUpdateBanner()}
        <section class="launcher-stage">
        <div class="launcher-panel entry-surface">
          <div class="launcher-brand entry-brand" aria-label="${escapeHtml(APP_TITLE)}">
            <div class="launcher-brand-disc">
              <img class="launcher-brand-logo" src="/assets/palziv-logo-transparent.png?v=20260625b" alt="${escapeHtml(APP_TITLE)}" loading="eager" decoding="async">
            </div>
          </div>

          <div class="panel-title panel-title-wide launcher-title-block">
            <div>
              <h2>${escapeHtml(APP_DISPLAY_TITLE)}</h2>
            </div>
          </div>
          <div class="launcher-grid launcher-grid-logins">
            ${renderLauncherCard("employee", "Employee Login")}
            ${renderLauncherAdminCard("hr", "HR Login")}
            ${renderLauncherAdminCard("webmaster", "Systems and Analytics Login")}
            ${renderLauncherAdminCard("it", "IT Login")}
          </div>
        </div>
      </section>
    </main>
  `;
}

function hrFeedPosts() {
  const notices = visiblePosts();

  if (activeHistoryFilter === "Urgent") {
    return notices.filter((post) => post.priority === "Urgent");
  }

  return notices;
}

function renderHrFeedPanel() {
  const notices = hrFeedPosts();

  return `
    <section class="panel-stack">
      <section class="admin-workspace hr-feed-workspace" aria-label="HR feed control center">
        <section class="tool-panel composer-panel panel-card" aria-label="Publish update">
          <div class="panel-title panel-title-wide">
            <div>
              <p class="eyebrow">${icon("megaphone")} Publish update</p>
              <h3>New announcement</h3>
            </div>
          </div>
          <form data-post-form>
            <div class="composer-grid">
              <label class="field field-span-2">
                <span>Title</span>
                <input name="title" maxlength="90" required>
              </label>
              <label class="field field-span-2">
                <span>Message</span>
                <textarea name="body" maxlength="700" required></textarea>
              </label>
              <label class="field">
                <span>Category</span>
                <select name="type">
                  <option>News</option>
                  <option>Weather</option>
                  <option>Shift</option>
                  <option>Safety</option>
                  <option value="HR">HR</option>
                </select>
              </label>
              <label class="field">
                <span>Priority</span>
                <select name="priority">
                  <option>Normal</option>
                  <option>Important</option>
                  <option>Urgent</option>
                </select>
              </label>
              <label class="field">
                <span>Audience</span>
                <select name="audience">
                  <option>All Employees</option>
                  <option>Operations</option>
                  <option>Office Staff</option>
                  <option>Warehouse</option>
                  <option>Leadership</option>
                  <option value="HR">HR</option>
                </select>
              </label>
              <label class="field">
                <span>Retention</span>
                <select name="alertRetention">
                  <option value="24h">24 Hours</option>
                  <option value="168h">7 Days</option>
                  <option value="720h" selected>30 Days</option>
                  <option value="manual">Manual Only</option>
                </select>
              </label>
            </div>
            <div class="form-actions">
              <button class="button" type="submit">${icon("send")} Publish update</button>
            </div>
          </form>
        </section>

        <section class="feed-shell feed-shell-quiet feed-shell-bare hr-feed-preview" aria-label="Live managed employee feed">
          <div class="panel-title panel-title-wide">
            <div>
              <p class="eyebrow">${icon("board")} Stream</p>
              <h3>Live employee updates</h3>
            </div>
            ${activeHistoryFilter === "Urgent" ? `<span class="sync-pill">Urgent only</span>` : ""}
          </div>
          <div class="feed-list feed-list-quiet">
            ${
              notices.length
                ? notices.map((post) => renderManagedFeedItem(post)).join("")
                : `<div class="empty-state">No updates are live right now.</div>`
            }
          </div>
        </section>
      </section>
    </section>
  `;
}

function renderSecurityEventCard(event) {
  const eventType = String(event.type || "event").replace(/_/g, " ");
  const outcome = String(event.outcome || "logged");
  const sourceIp = event.sourceIp || "unknown";
  const accountKey = event.accountKey || "n/a";
  const detail = event.detail || "No detail";

  return `
    <article class="panel-card">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("alert")} ${escapeHtml(eventType)}</p>
          <h3>${escapeHtml(outcome)}</h3>
          <p>${escapeHtml(formatDate(event.createdAt || nowIso()))}</p>
        </div>
        <span class="sync-pill">${escapeHtml(event.actor || "system")}</span>
      </div>
      <div class="status-display">
        <span>Account</span>
        <strong>${escapeHtml(accountKey)}</strong>
        <small>${escapeHtml(detail)}</small>
      </div>
      <p class="panel-copy">Source IP: ${escapeHtml(sourceIp)}${event.userAgent ? ` | Agent: ${escapeHtml(event.userAgent)}` : ""}</p>
    </article>
  `;
}

function renderAdminSecurityPanel() {
  const events = Array.isArray(state.securityEvents.events) ? state.securityEvents.events : [];
  const failedCount = events.filter((event) => String(event.type || "").endsWith("_failed")).length;
  const throttledCount = events.filter((event) => String(event.type || "").endsWith("_throttled")).length;

  return `
    <section class="panel-stack">
      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("lock")} Auth pressure</p>
            <h3>Current snapshot</h3>
          </div>
        </div>
        <div class="hero-strip hero-strip-hr" aria-label="Security summary">
          ${renderStatCard(String(events.length), "Recent events", "Newest 100 persisted events")}
          ${renderStatCard(String(failedCount), "Failed sign-ins", "Invalid credentials and denied attempts")}
          ${renderStatCard(String(throttledCount), "Throttled", "Backoff and temporary lockouts")}
          ${renderStatCard(events[0]?.createdAt ? formatDate(events[0].createdAt) : "None", "Latest event", "Most recent auth signal")}
        </div>
      </section>

      <section class="panel-stack">
        ${events.length ? events.map((event) => renderSecurityEventCard(event)).join("") : '<div class="empty-state">No recent security events.</div>'}
      </section>
    </section>
  `;
}

function renderPrivilegedPasswordPanel(route) {
  const role = route === "webmaster" ? "Systems" : "HR";
  const collapsible = route === "hr";
  const formMarkup = `
      <form class="auth-form" data-privileged-password-form data-role-route="${escapeHtml(route)}">
        <div class="composer-grid">
          <label class="field">
            <span>Current Password</span>
            <input name="currentPassword" type="password" minlength="10" required autocomplete="current-password">
          </label>
          <label class="field">
            <span>New Password</span>
            <input name="password" type="password" minlength="10" required autocomplete="new-password">
          </label>
          <label class="field field-span-2">
            <span>Confirm New Password</span>
            <input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password">
          </label>
        </div>
        <div class="auth-form-actions">
          <button class="ghost-button" type="submit">${icon("lock")} Save New Password</button>
        </div>
      </form>
  `;

  return `
    <section class="panel-card settings-credential-card" data-privileged-password-panel>
      ${collapsible
        ? `<details class="settings-collapse">
            <summary class="ghost-button settings-collapse-toggle">${icon("lock")} Change Password</summary>
            ${formMarkup}
          </details>`
        : `
          <div class="panel-title panel-title-wide">
            <div>
              <p class="eyebrow">${icon("lock")} ${escapeHtml(role)} Credentials</p>
              <h3>Change ${escapeHtml(role)} Password</h3>
            </div>
          </div>
          ${formMarkup}`}
    </section>
  `;
}

function renderWeatherSettingsPanel() {
  const weather = state.weather || defaultWeather();
  const locationValue = weather.location || weather.resolvedName || "";
  const hasWeatherUpdate = Number.isFinite(Date.parse(String(weather.updatedAt || "")));
  const updatedLabel = formatWeatherFreshness(weather.updatedAt);
  const updatedAriaLabel = hasWeatherUpdate ? `Updated ${updatedLabel}` : "Not refreshed";
  const conditionLabel = weather.condition || "Weather not configured";
  const temperatureLabel = weather.temperature || "--";
  const temperatureToneClass = getWeatherTemperatureToneClass(temperatureLabel);
  const highTemperature = weather.highTemperature || "--";
  const lowTemperature = weather.lowTemperature || "--";
  const locationLabel = formatCompactWeatherLocation(weather.resolvedName || weather.location);

  return `
    <section class="panel-card weather-card settings-weather-card">
      <div class="settings-weather-status" aria-label="Weather status">
        <div class="settings-weather-line settings-weather-line-primary">
          <span class="settings-weather-current">
            <strong class="settings-weather-temperature ${temperatureToneClass}">${escapeHtml(temperatureLabel)}</strong>
            <span class="settings-weather-condition">${escapeHtml(conditionLabel)}</span>
          </span>
          <span class="settings-weather-range">
            <span class="settings-weather-range-item settings-weather-range-high" aria-label="High temperature"><span class="settings-weather-range-label" aria-hidden="true">▲</span> ${escapeHtml(highTemperature)}</span>
            <span class="settings-weather-range-item settings-weather-range-low" aria-label="Low temperature"><span class="settings-weather-range-label" aria-hidden="true">▼</span> ${escapeHtml(lowTemperature)}</span>
          </span>
        </div>
        <div class="settings-weather-line settings-weather-line-secondary">
          <span>${escapeHtml(locationLabel)}</span>
          <span class="settings-weather-updated" aria-label="${escapeHtml(updatedAriaLabel)}">
            <span class="settings-weather-updated-symbol" aria-hidden="true">${icon("clock")}</span>
            ${escapeHtml(updatedLabel)}
          </span>
        </div>
      </div>
      <form class="settings-weather-form" data-weather-form>
        <label class="field settings-weather-location-field">
          <input name="location" maxlength="120" required value="${escapeHtml(locationValue)}" aria-label="Weather location">
        </label>
        <button class="ghost-button" type="submit">${icon("refresh")} Refresh</button>
      </form>
    </section>
  `;
}

function renderWebmasterHrResetPanel() {
  return `
    <section class="panel-card settings-credential-card">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("users")} HR recovery</p>
          <h3>Reset the HR password</h3>
        </div>
      </div>
      <form class="auth-form" data-webmaster-reset-hr-password-form>
        <div class="composer-grid">
          <label class="field">
            <span>New HR password</span>
            <input name="password" type="password" minlength="10" required autocomplete="new-password">
          </label>
          <label class="field">
            <span>Confirm new HR password</span>
            <input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password">
          </label>
        </div>
        <div class="auth-form-actions">
          <button class="ghost-button" type="submit">Reset HR password</button>
        </div>
      </form>
    </section>
  `;
}

function renderAdminSettingsPanel() {
  return `
    <section class="panel-stack settings-shell">
      ${renderWeatherSettingsPanel()}
      ${state.access.hr.user?.mfa?.available ? renderAdminMfaPanel("hr") : ""}
      ${renderPrivilegedPasswordPanel("hr")}
      ${renderAdminAccountsPanel("hr")}
    </section>
  `;
}

function renderWebmasterSettingsPanel() {
  return `
    <section class="panel-stack settings-shell">
      ${renderPrivilegedPasswordPanel("webmaster")}
      ${state.access.webmaster.user?.mfa?.available ? renderAdminMfaPanel("webmaster") : ""}
      ${renderAdminAccountsPanel("webmaster")}
      ${renderWebmasterHrResetPanel()}
    </section>
  `;
}

function renderAdminAccessPanel() {
  return `
    <section class="panel-stack">
      ${renderEmployeeDirectoryPanel()}
      ${renderEmployeeBatchUploadPanel()}
      ${renderEmployeeCreatePanel()}
    </section>
  `;
}

function renderWebmasterOverviewPanel() {
  const snapshot = buildWebmasterSnapshot();
  const board = snapshot.board || {};
  const notifications = snapshot.notifications || {};
  const urls = snapshot.urls || {};
  const server = snapshot.server || {};
  const probes = state.webmaster.probes || {};

  return `
    <section class="panel-stack">
      ${renderWebmasterExpandableCard({
        id: "overview-site-snapshot",
        eyebrow: "Site snapshot",
        title: "Routes, access, and latest update",
        description: "Open the live portal routes, latest update, push enrollment, and health timing in one place.",
        badge: "Live",
        iconName: "chart",
        summaryMetrics: [
          { label: "Generated", value: formatDate(snapshot.generatedAt) },
          { label: "Push subs", value: String(notifications.pushSubscriptions || 0) },
          { label: "Health", value: formatDurationMs(probes.health || 0) }
        ],
        body: renderKeyValueGrid([
          ["Generated", formatDate(snapshot.generatedAt), "Snapshot time"],
          ["Launcher URL", urls.base || `${window.location.origin}${appPath()}`, "Canonical entry point"],
          ["HR route", urls.hr || `${window.location.origin}${routePath("hr")}`, "HR console"],
          ["Employee route", urls.employee || `${window.location.origin}${routePath("employee")}`, "Signed-in feed and device enrollment"],
          ["Latest Update", board.latestPost ? board.latestPost.title : "None", board.latestPost ? formatDate(board.latestPost.createdAt) : "No Posts Yet"],
          ["Push subs", String(notifications.pushSubscriptions || 0), "Web push enrollments"],
          ["Admin access", "Separated roles", "Distinct HR and Systems sessions"],
          ["Enrollment", "Employee-authenticated", "Employees must sign in before subscribing"],
          ["Health ping", formatDurationMs(probes.health || 0), "API round-trip"]
        ])
      })}

      ${renderWebmasterExpandableCard({
        id: "overview-host-snapshot",
        eyebrow: "Host snapshot",
        title: "Runtime and probe timings",
        description: "Check the active Node runtime, item counts, and how long each Systems probe took.",
        badge: "Tracked",
        iconName: "monitor",
        summaryMetrics: [
          { label: "Node", value: server.nodeVersion || "Unknown" },
          { label: "Board items", value: String(board.totalPosts || 0) },
          { label: "Summary fetch", value: formatDurationMs(probes.summary || 0) }
        ],
        body: renderKeyValueGrid([
          ["Node", server.nodeVersion || "Unknown", `Uptime ${server.uptimeSeconds || 0}s`],
          ["Board items", String(board.totalPosts || 0), "Updates tracked"],
          ["Summary fetch", formatDurationMs(probes.summary || 0), "Systems endpoint"],
          ["Posts fetch", formatDurationMs(probes.posts || 0), "Feed data"],
          ["Weather fetch", formatDurationMs(probes.weather || 0), "Weather payload"],
          ["Push status", formatDurationMs(probes.pushStatus || 0), "Notification status"]
        ])
      })}

      ${renderWebmasterExpandableCard({
        id: "overview-delivery-roster",
        eyebrow: "Delivery roster",
        title: "Subscribed devices",
        description: "Active devices stay on top. Remove stale devices from the roster or turn alerts off on that browser.",
        badge: "Devices",
        iconName: "users",
        summaryMetrics: [
          { label: "Active", value: String(notifications.activeSubscriptions || 0) },
          { label: "Inactive", value: String(notifications.inactiveSubscriptions || 0) },
          { label: "Total", value: String(notifications.pushSubscriptions || 0) }
        ],
        body: renderNotificationDeviceRoster(notifications.devices || [], "No push devices have subscribed yet.")
      })}

      ${renderAccessPinPanel()}
    </section>
  `;
}

function renderWebmasterTrafficPanel() {
  const snapshot = buildWebmasterSnapshot();
  const traffic = snapshot.traffic || {};
  const successRate = traffic.totals?.requests
    ? `${Math.round(((traffic.totals.successfulRequests || 0) / traffic.totals.requests) * 100)}%`
    : "0%";
  const topRoute = traffic.byRoute?.[0]?.label || "None";

  return `
    <section class="panel-stack">
      ${renderWebmasterExpandableCard({
        id: "traffic-summary",
        eyebrow: "Traffic summary",
        title: "Requests, response time, and route mix",
        description: "Open the full request totals plus method, status, and route breakdowns.",
        badge: "Tracked",
        iconName: "refresh",
        summaryMetrics: [
          { label: "Requests", value: String(traffic.totals?.requests || 0) },
          { label: "Errors", value: String(traffic.totals?.serverErrors || 0) },
          { label: "Avg response", value: formatDurationMs(traffic.totals?.averageDurationMs || 0) },
          { label: "Success", value: successRate }
        ],
        body: `
          ${renderKeyValueGrid([
            ["Requests", String(traffic.totals?.requests || 0), "All tracked requests"],
            ["Page views", String(traffic.totals?.pageViews || 0), "Employee, HR, and Systems views"],
            ["API calls", String(traffic.totals?.apiRequests || 0), "Backend requests"],
            ["Success rate", successRate, "2xx and 3xx responses"],
            ["Server errors", String(traffic.totals?.serverErrors || 0), "5xx responses"],
            ["Average response", formatDurationMs(traffic.totals?.averageDurationMs || 0), "Across tracked requests"]
          ])}

          <div class="analytics-grid">
            <div class="panel-stack">
              <h3>Methods</h3>
              ${renderCountList(traffic.byMethod || [], "No methods yet")}
            </div>
            <div class="panel-stack">
              <h3>Status codes</h3>
              ${renderCountList(traffic.byStatus || [], "No statuses yet")}
            </div>
            <div class="panel-stack">
              <h3>Top routes</h3>
              ${renderCountList(traffic.byRoute || [], "No routes yet")}
            </div>
          </div>
        `
      })}

      ${renderWebmasterExpandableCard({
        id: "traffic-requests",
        eyebrow: "Recent requests",
        title: "Latest activity and failures",
        description: "Expand to inspect the newest requests first, plus any recent failing routes.",
        badge: "Live",
        iconName: "news",
        summaryMetrics: [
          { label: "Recent", value: String(traffic.recentRequests?.length || 0) },
          { label: "Errors", value: String(traffic.recentErrors?.length || 0) },
          { label: "Top route", value: topRoute }
        ],
        body: `
          <div class="request-list">
            ${traffic.recentRequests?.length ? traffic.recentRequests.map((request) => renderRecentRequest(request)).join("") : '<div class="empty-state compact">No requests recorded yet.</div>'}
          </div>
          ${traffic.recentErrors?.length ? `
            <div class="panel-title panel-title-wide request-errors-head">
              <div>
                <p class="eyebrow">${icon("alert")} Recent errors</p>
                <h3>Failing routes</h3>
              </div>
            </div>
            <div class="request-list">
              ${traffic.recentErrors.map((request) => renderRecentRequest(request)).join("")}
            </div>
          ` : ""}
        `
      })}
    </section>
  `;
}

function renderWebmasterSystemPanel() {
  const snapshot = buildWebmasterSnapshot();
  const server = snapshot.server || {};
  const browser = snapshot.browser || {};
  const probes = state.webmaster.probes || {};
  const loadMetric = browser.performance?.loadMs ? `${browser.performance.loadMs} ms` : "Unknown";

  return `
    <section class="panel-stack">
      ${renderWebmasterExpandableCard({
        id: "system-runtime",
        eyebrow: "Runtime diagnostics",
        title: "Server and browser environment",
        description: "Expand to inspect the current host runtime plus the browser context being used for this session.",
        badge: browser.online ? "Online" : "Offline",
        iconName: "monitor",
        summaryMetrics: [
          { label: "Node", value: server.nodeVersion || "Unknown" },
          { label: "Port", value: String(server.port || "?") },
          { label: "Push", value: browser.pushSupport ? "Supported" : "Unsupported" }
        ],
        body: `
          <div class="analytics-grid">
            <div class="panel-stack">
              <h3>Server</h3>
              ${renderKeyValueGrid([
                ["Node", server.nodeVersion || "Unknown", `PID ${server.pid || "?"}`],
                ["Platform", `${server.platform || "Unknown"} · ${server.arch || "Unknown"}`, `CPU ${server.cpuCount || 0}`],
                ["Uptime", `${server.uptimeSeconds || 0}s`, `Port ${server.port || "?"}`],
                ["Memory", `${formatBytes((server.memory?.rssMb || 0) * 1024 * 1024)}`, `Heap ${server.memory?.heapUsedMb || 0} MB used`],
                ["Storage", `${server.boardStorage || "file"} / ${server.pushStorage || "file"}`, "Board / push stores"],
                ["Analytics file", server.dataFiles?.analytics || "analytics.json", "Request history"]
              ])}
            </div>
            <div class="panel-stack">
              <h3>Browser</h3>
              ${renderKeyValueGrid([
                ["Route", browser.route || "Unknown", browser.secureContext ? "Secure context" : "Not secure"],
                ["Viewport", browser.viewport ? `${browser.viewport.width} x ${browser.viewport.height}` : "Unknown", `Pixel ratio ${browser.screen?.pixelRatio || 1}`],
                ["Screen", browser.screen ? `${browser.screen.width} x ${browser.screen.height}` : "Unknown", `${browser.online ? "Online" : "Offline"} · ${browser.language || "Unknown"}`],
                ["Connection", browser.connection ? `${browser.connection.effectiveType || "Unknown"} · ${browser.connection.downlink || 0} Mbps` : "Unavailable", browser.connection?.saveData ? "Data saver on" : "Data saver off"],
                ["Service worker", browser.serviceWorker?.supported ? "Supported" : "Unsupported", browser.serviceWorker?.controlled ? "Controlled" : "Not controlled"],
                ["Push support", browser.pushSupport ? "Supported" : "Unsupported", browser.timezone || "Timezone unknown"]
              ])}
            </div>
          </div>
        `
      })}

      ${renderWebmasterExpandableCard({
        id: "system-performance",
        eyebrow: "Performance",
        title: "Probe timings and browser performance",
        description: "Open the probe timings and page load metrics to pinpoint where latency is coming from.",
        badge: "Timing",
        iconName: "refresh",
        summaryMetrics: [
          { label: "Summary", value: formatDurationMs(probes.summary || 0) },
          { label: "Health", value: formatDurationMs(probes.health || 0) },
          { label: "Load", value: loadMetric }
        ],
        body: `
          <div class="analytics-grid">
            <div class="panel-stack">
              <h3>Probe timings</h3>
              ${renderCountList([
                { label: "Summary", value: formatDurationMs(probes.summary || 0) },
                { label: "Posts", value: formatDurationMs(probes.posts || 0) },
                { label: "Weather", value: formatDurationMs(probes.weather || 0) },
                { label: "Push", value: formatDurationMs(probes.pushStatus || 0) },
                { label: "Health", value: formatDurationMs(probes.health || 0) }
              ], "No probes yet")}
            </div>
            <div class="panel-stack">
              <h3>Performance</h3>
              ${renderKeyValueGrid([
                ["Load", loadMetric, "Navigation timing"],
                ["DOMContentLoaded", browser.performance?.domContentLoadedMs ? `${browser.performance.domContentLoadedMs} ms` : "Unknown", "Document ready time"],
                ["Transfer", browser.performance ? formatBytes(browser.performance.transferSize || 0) : "Unknown", "Transferred payload"],
                ["Encoded body", browser.performance ? formatBytes(browser.performance.encodedBodySize || 0) : "Unknown", "Uncompressed size"],
                ["Heap used", browser.memory ? formatBytes(browser.memory.usedJSHeapSize || 0) : "Unknown", "Browser JS heap"],
                ["Heap limit", browser.memory ? formatBytes(browser.memory.jsHeapSizeLimit || 0) : "Unknown", "Browser cap"]
              ])}
            </div>
          </div>
        `
      })}
    </section>
  `;
}

function renderWebmasterContentPanel() {
  const snapshot = buildWebmasterSnapshot();
  const board = snapshot.board || {};
  const latestPost = board.recentPosts?.[0] || board.latestPost || null;

  return `
    <section class="panel-stack">
      ${renderWebmasterExpandableCard({
        id: "content-inventory",
        eyebrow: "Inventory",
        title: "Live post counts and breakdowns",
        description: "Open the full content totals plus the type, priority, and audience mix.",
        badge: "Live",
        iconName: "board",
        summaryMetrics: [
          { label: "Active", value: String(board.activePosts || 0) },
          { label: "Urgent", value: String(board.urgentPosts || 0) },
          { label: "Expiring", value: String(board.expiringSoon || 0) },
          { label: "Notified", value: String(board.alertPosts || 0) }
        ],
        body: `
          ${renderKeyValueGrid([
            ["Total posts", String(board.totalPosts || 0), "All saved updates"],
            ["Active posts", String(board.activePosts || 0), "Not expired"],
            ["Urgent posts", String(board.urgentPosts || 0), "Require immediate attention"],
            ["Important posts", String(board.importantPosts || 0), "Visible to staff"],
            ["Notifications", String(board.alertPosts || 0), "Sent to subscribed devices"],
            ["Expiring soon", String(board.expiringSoon || 0), "Next 7 days"]
          ])}

          <div class="analytics-grid">
            <div class="panel-stack">
              <h3>By type</h3>
              ${renderCountList(board.byType || [], "No posts yet")}
            </div>
            <div class="panel-stack">
              <h3>By priority</h3>
              ${renderCountList(board.byPriority || [], "No posts yet")}
            </div>
            <div class="panel-stack">
              <h3>By audience</h3>
              ${renderCountList(board.byAudience || [], "No posts yet")}
            </div>
          </div>
        `
      })}

      ${renderWebmasterExpandableCard({
        id: "content-recent",
        eyebrow: "Latest posts",
        title: "Most recent activity",
        description: "Expand to inspect the newest employee updates in the same order employees see them.",
        badge: "Recent",
        iconName: "news",
        summaryMetrics: [
          { label: "Count", value: String(board.recentPosts?.length || 0) },
          { label: "Latest", value: latestPost ? formatDate(latestPost.createdAt) : "None" },
          { label: "Type", value: latestPost?.type || "None" }
        ],
        body: `
          <div class="post-list compact">
            ${board.recentPosts?.length ? board.recentPosts.map((post) => renderNotice(post)).join("") : '<div class="empty-state compact">No updates yet.</div>'}
          </div>
        `
      })}
    </section>
  `;
}

function renderWebmasterCodexPanel() {
  const snapshot = buildWebmasterSnapshot();
  const brief = buildCodexBrief(snapshot);
  const raw = JSON.stringify(snapshot, null, 2);

  return `
    <section class="panel-stack">
      ${renderWebmasterExpandableCard({
        id: "codex-brief",
        eyebrow: "Codex transfer",
        title: "Copy the incident brief and raw snapshot",
        description: "Expand this container to copy the ready-made brief or inspect the underlying JSON snapshot.",
        badge: "Clipboard",
        iconName: "clipboard",
        summaryMetrics: [
          { label: "Generated", value: formatDate(snapshot.generatedAt) },
          { label: "Active posts", value: String(snapshot.board?.activePosts || 0) },
          { label: "Server errors", value: String(snapshot.traffic?.totals?.serverErrors || 0) }
        ],
        className: "codex-panel",
        body: `
          <div class="action-row">
            <button class="ghost-button" type="button" data-copy-webmaster-brief>${icon("clipboard")} Copy brief</button>
            <button class="ghost-button" type="button" data-copy-webmaster-json>${icon("chart")} Copy JSON</button>
          </div>
          <label class="field full">
            <span>Codex brief</span>
            <textarea readonly rows="18" data-webmaster-brief>${escapeHtml(brief)}</textarea>
          </label>
          <label class="field full">
            <span>Raw JSON snapshot</span>
            <textarea readonly rows="18" data-webmaster-json>${escapeHtml(raw)}</textarea>
          </label>
        `
      })}
    </section>
  `;
}

function renderWebmaster() {
  const snapshot = buildWebmasterSnapshot();
  const board = snapshot.board || {};
  const traffic = snapshot.traffic || {};
  const probes = state.webmaster.probes || {};

  return `
    <main class="page-shell webmaster-shell">
      <header class="page-head">
        ${brandBlock("Systems Command Center")}
        <div class="page-actions">
          <button class="ghost-button" type="button" data-route="launcher">${icon("home")} Launcher</button>
          <button class="ghost-button" type="button" data-route="employee">${icon("news")} Employee Feed</button>
          <button class="ghost-button" type="button" data-route="hr">${icon("users")} HR Console</button>
          <button class="ghost-button" type="button" data-copy-webmaster-brief>${icon("clipboard")} Copy brief</button>
          <button class="ghost-button" type="button" data-refresh>${icon("refresh")} Refresh</button>
        </div>
      </header>

      ${renderAppUpdateBanner()}
      <section class="hero-strip hero-strip-webmaster" aria-label="Systems summary">
        ${renderWebmasterDrilldownStatCard({
          value: String(traffic.totals?.requests || 0),
          label: "Requests",
          note: `${traffic.totals?.apiRequests || 0} API calls`,
          tab: "traffic",
          cardIds: ["traffic-summary", "traffic-requests"]
        })}
        ${renderWebmasterDrilldownStatCard({
          value: String(traffic.totals?.serverErrors || 0),
          label: "Server errors",
          note: `${traffic.totals?.clientErrors || 0} client errors`,
          tab: "traffic",
          cardIds: ["traffic-summary", "traffic-requests"]
        })}
        ${renderWebmasterDrilldownStatCard({
          value: String(board.activePosts || 0),
          label: "Active updates",
          note: `${board.expiringSoon || 0} expiring soon`,
          tab: "content",
          cardIds: ["content-inventory", "content-recent"]
        })}
        ${renderWebmasterDrilldownStatCard({
          value: String(board.urgentPosts || 0),
          label: "Urgent updates",
          note: `${board.alertPosts || 0} alert-enabled`,
          tab: "content",
          cardIds: ["content-inventory", "content-recent"]
        })}
        ${renderWebmasterDrilldownStatCard({
          value: String(state.pushStatus.subscriptions || 0),
          label: "Subscriptions",
          note: state.push.supported ? "Push ready" : "No push support",
          tab: "overview",
          cardIds: ["overview-delivery-roster", "overview-enrollment"]
        })}
        ${renderWebmasterDrilldownStatCard({
          value: formatDurationMs(traffic.totals?.averageDurationMs || 0),
          label: "Avg response",
          note: `Health ${formatDurationMs(probes.health || 0)}`,
          tab: "system",
          cardIds: ["system-runtime", "system-performance"]
        })}
      </section>

      ${state.message ? `<div class="webmaster-banner ${escapeHtml(state.messageType)}">${escapeHtml(state.message)}</div>` : ""}

      ${renderTabBar(webmasterTabs, activeWebmasterTab, "webmaster", "Systems sections")}

      <section class="panel-surface">
        ${
          activeWebmasterTab === "overview"
            ? renderWebmasterOverviewPanel()
            : activeWebmasterTab === "traffic"
              ? renderWebmasterTrafficPanel()
              : activeWebmasterTab === "system"
                ? renderWebmasterSystemPanel()
                : activeWebmasterTab === "content"
                  ? renderWebmasterContentPanel()
                  : activeWebmasterTab === "codex"
                  ? renderWebmasterCodexPanel()
                    : renderWebmasterSettingsPanel()
        }
      </section>
      ${renderAdminSignoutFooter()}
    </main>
  `;
}

function renderItCompanySettingsPanel() {
  return `
    <section class="panel-stack">
      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("board")} Company Settings</p>
            <h3>Business Control</h3>
          </div>
          <span class="sync-pill">Planned</span>
        </div>
        <div class="hero-strip hero-strip-hr" aria-label="Company settings readiness">
          ${renderStatCard("Ready", "Role Model", "IT is active server-side")}
          ${renderStatCard("Next", "Billing", "Connect payment settings")}
          ${renderStatCard("Next", "Retention", "Set audit and post retention")}
        </div>
      </section>
    </section>
  `;
}

function renderAdminMfaPolicyPanel() {
  const policy = normalizeAdminMfaPolicy(state.adminMfaPolicy.policy);
  const environmentEnabled = policy.environmentEnabled !== false;
  const configuredEnabled = policy.enabled !== false;
  const effectiveEnabled = environmentEnabled && configuredEnabled && policy.effectiveEnabled !== false;
  const statusLabel = !environmentEnabled ? "Server Disabled" : effectiveEnabled ? "Required" : "Disabled";
  const lastChanged = policy.updatedAt ? formatDate(policy.updatedAt) : "Default";
  const updatedBy = policy.updatedBy ? `By @${policy.updatedBy}` : "System default";

  return `
    <section class="panel-card admin-mfa-policy-card">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("lock")} Security Policy</p>
          <h3>Admin MFA Requirement</h3>
        </div>
        <span class="sync-pill">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="hero-strip admin-mfa-policy-summary" aria-label="Admin MFA policy summary">
        ${renderStatCard(effectiveEnabled ? "Required" : "Off", "Enforcement", effectiveEnabled ? "Authenticator challenge active" : "Password-only admin sign-in")}
        ${renderStatCard(environmentEnabled ? "Ready" : "Off", "Server Override", environmentEnabled ? "Runtime policy controls access" : "ADMIN_MFA_ENABLED is off")}
        ${renderStatCard(lastChanged, "Last Change", updatedBy)}
      </div>
      <form class="auth-form admin-mfa-policy-form" data-admin-mfa-policy-form>
        <label class="checkbox-row">
          <input type="checkbox" name="enabled" value="true" ${configuredEnabled ? "checked" : ""} ${state.adminMfaPolicy.busy || !environmentEnabled ? "disabled" : ""}>
          <span>Require MFA for admin accounts</span>
        </label>
        <label class="field">
          <span>Reason</span>
          <input name="reason" maxlength="160" value="${escapeHtml(policy.reason || "")}" ${state.adminMfaPolicy.busy || !environmentEnabled ? "disabled" : ""}>
        </label>
        <div class="form-actions">
          <button class="button" type="submit" ${state.adminMfaPolicy.busy || !environmentEnabled ? "disabled" : ""}>
            ${escapeHtml(state.adminMfaPolicy.busy ? "Saving..." : "Save MFA Control")}
          </button>
        </div>
      </form>
    </section>
  `;
}

function renderItEmergencyPanel() {
  const itAdmins = (state.itAdminDirectory.adminUsers || []).filter((adminUser) => Array.isArray(adminUser.roles) && adminUser.roles.includes("it"));
  const activeItAdmins = itAdmins.filter((adminUser) => adminUser.active !== false);
  const itMfaAvailable = state.access.it.user?.mfa?.available !== false;
  const itMfaStatus = state.access.it.user?.mfa?.status || "setup-required";
  const itMfaLabel = !itMfaAvailable
    ? "Off"
    : itMfaStatus === "enabled"
      ? "Enabled"
      : itMfaStatus === "grace"
        ? "Grace"
        : "Required";
  const itMfaNote = !itMfaAvailable
    ? "Google Authenticator is currently disabled for admin accounts."
    : itMfaStatus === "enabled"
      ? "IT authenticator is active."
      : itMfaStatus === "grace"
        ? "Finish enrollment before the grace window ends."
        : "Enrollment is required before IT access is fully active.";

  return `
    <section class="panel-stack">
      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("alert")} Emergency Access</p>
            <h3>Recovery Readiness</h3>
          </div>
          <span class="sync-pill">${escapeHtml(`${activeItAdmins.length} Active IT Account${activeItAdmins.length === 1 ? "" : "s"}`)}</span>
        </div>
        <div class="hero-strip hero-strip-hr" aria-label="Emergency access summary">
          ${renderStatCard(String(activeItAdmins.length), "Active IT Accounts", "Named IT governance access")}
          ${renderStatCard(activeItAdmins.length >= 2 ? "Healthy" : "Needs Backup", "Backup IT", "Create one backup IT account")}
          ${renderStatCard(itMfaLabel, "MFA", itMfaNote)}
        </div>
      </section>
      ${renderAdminMfaPolicyPanel()}
      ${itMfaAvailable ? renderAdminMfaPanel("it") : ""}
    </section>
  `;
}

function renderIt() {
  const adminUsers = Array.isArray(state.itAdminDirectory.adminUsers) ? state.itAdminDirectory.adminUsers : [];
  const activeAdmins = adminUsers.filter((adminUser) => adminUser.active !== false);
  const itCount = activeAdmins.filter((adminUser) => Array.isArray(adminUser.roles) && adminUser.roles.includes("it")).length;
  const hrCount = activeAdmins.filter((adminUser) => Array.isArray(adminUser.roles) && adminUser.roles.includes("hr")).length;
  const webmasterCount = activeAdmins.filter((adminUser) => Array.isArray(adminUser.roles) && adminUser.roles.includes("webmaster")).length;

  return `
    <main class="page-shell it-shell">
      <header class="page-head">
        ${brandBlock("IT Control Center")}
        <div class="page-actions">
          <button class="ghost-button" type="button" data-route="launcher">${icon("home")} Launcher</button>
          <button class="ghost-button" type="button" data-route="hr">${icon("users")} HR Console</button>
          <button class="ghost-button" type="button" data-route="webmaster">${icon("monitor")} Systems Console</button>
          <button class="ghost-button" type="button" data-refresh>${icon("refresh")} Refresh</button>
        </div>
      </header>

      ${renderAppUpdateBanner()}
      <section class="hero-strip hero-strip-webmaster" aria-label="IT summary">
        ${renderStatCard(String(adminUsers.length), "Admin Accounts", "All named admin identities")}
        ${renderStatCard(String(itCount), "IT Admins", "Governance and recovery access")}
        ${renderStatCard(String(hrCount), "HR Admins", "HR and communication access")}
        ${renderStatCard(String(webmasterCount), "System Ops Admins", "System operations access")}
      </section>

      ${state.message ? `<div class="webmaster-banner ${escapeHtml(state.messageType)}">${escapeHtml(state.message)}</div>` : ""}

      ${renderTabBar(itTabs, activeItTab, "it", "IT sections")}

      <section class="panel-surface">
        ${
          activeItTab === "company"
            ? renderItCompanySettingsPanel()
            : activeItTab === "audit"
              ? renderAdminSecurityPanel()
              : activeItTab === "emergency"
                ? renderItEmergencyPanel()
                : renderAdminAccountsPanel("it")
        }
      </section>
      ${renderAdminSignoutFooter()}
    </main>
  `;
}

function renderAdmin() {
  const activeCount = state.posts.filter((post) => !isExpired(post)).length;
  const urgentCount = state.posts.filter((post) => post.priority === "Urgent" && !isExpired(post)).length;
  const activeEmployeeCount = Array.isArray(state.employeeDirectory?.employees)
    ? state.employeeDirectory.employees.filter((employee) => employee && employee.active !== false).length
    : 0;

  return `
    <main class="page-shell hr-shell">
      <header class="page-head">
        ${brandBlock("HR Control Center")}
        <div class="page-actions">
          <button class="ghost-button" type="button" data-route="launcher">${icon("home")} Launcher</button>
          <button class="ghost-button" type="button" data-route="employee">${icon("news")} Employee Feed</button>
          <button class="ghost-button" type="button" data-refresh>${icon("refresh")} Refresh</button>
        </div>
      </header>

      ${renderAppUpdateBanner()}
      <section class="hero-strip" aria-label="HR summary">
        ${renderHrSummaryStatCard({ value: String(activeCount), label: "Active Updates", tab: "feed", filter: "Active" })}
        ${renderHrSummaryStatCard({ value: String(urgentCount), label: "Urgent Updates", tab: "feed", filter: "Urgent" })}
        ${renderHrSummaryStatCard({ value: String(activeEmployeeCount), label: "Active Employees", tab: "share" })}
      </section>

      ${state.message ? `<div class="hr-banner ${escapeHtml(state.messageType)}">${escapeHtml(state.message)}</div>` : ""}

      ${renderTabBar(adminTabs, activeAdminTab, "hr", "HR sections")}

      <section class="panel-surface">
        ${
          activeAdminTab === "feed"
            ? renderHrFeedPanel()
            : activeAdminTab === "share"
              ? renderAdminAccessPanel()
            : activeAdminTab === "settings"
              ? renderAdminSettingsPanel()
              : renderHrFeedPanel()
        }
      </section>
      ${renderAdminSignoutFooter()}
    </main>
  `;
}

function setMessage(message, type = "") {
  state.message = message;
  state.messageType = type;
}

function openHrSummaryTarget(tab, filter = "") {
  activeAdminTab = tab || "feed";
  activeHistoryFilter = activeAdminTab === "feed" ? (filter || "All") : "All";
  render();
}

function clearMessageSoon() {
  window.setTimeout(() => {
    setMessage("");
    render();
  }, 2600);
}

async function routeTo(route) {
  const nextPath = routePath(route);
  state.authRecovery.hr = false;
  state.authRecovery.it = false;
  state.authRecovery.webmaster = false;
  resetAdminInviteState();

  if (route === "launcher") {
    activeAdminTab = "feed";
    activeHistoryFilter = "All";
    activeWebmasterTab = "overview";
    activeItTab = "accounts";
  }

  if (route === "hr") {
    activeAdminTab = "feed";
    activeHistoryFilter = "All";
  } else if (route === "it") {
    activeItTab = "accounts";
  } else if (route === "webmaster") {
    activeWebmasterTab = "overview";
  }

  window.history.pushState({}, "", nextPath);
  await hydrateRoute();
  render();
}

async function hydrateRoute() {
  const route = currentRoute();

  const canonicalPath = routePath(route);

  if (normalizePathname(window.location.pathname) !== canonicalPath) {
    window.history.replaceState({}, "", canonicalPath);
  }

  if (route === "launcher") {
    return;
  }

  if (route === "hr") {
    await refreshAdminData();
    if (!state.access.hr.authorized && currentInviteToken()) {
      await loadAdminInvitePreview("hr");
    } else {
      resetAdminInviteState();
    }
    return;
  }

  if (route === "it") {
    await refreshItData();
    resetAdminInviteState();
    return;
  }

  if (route === "webmaster") {
    await refreshWebmasterData();
    if (!state.access.webmaster.authorized && currentInviteToken()) {
      await loadAdminInvitePreview("webmaster");
    } else {
      resetAdminInviteState();
    }
    return;
  }

  resetAdminInviteState();

  const access = await loadEmployeeAccessStatus();

  if (!access.authorized) {
    state.posts = [];
    state.weather = defaultWeather();
    state.pushStatus = {
      loaded: false,
      supported: false,
      subscriptions: 0,
      authorizedSubscriptions: 0,
      inactiveSubscriptions: 0,
      devices: []
    };
    return;
  }

  await loadBoard();
  await Promise.all([
    loadPushStatus()
  ]);
  void syncPushState();
}

function render() {
  const route = currentRoute();
  document.body.dataset.route = route;
  const pageMarkup = state.loading
    ? '<main class="auth-shell"><section class="empty-state">Loading portal...</section></main>'
    : route === "launcher"
      ? renderLauncher()
    : route === "hr"
        ? (state.access.hr.authorized ? renderAdmin() : renderAdminAuthGate("hr"))
      : route === "it"
        ? (state.access.it.authorized ? renderIt() : renderAdminAuthGate("it"))
      : route === "webmaster"
          ? (state.access.webmaster.authorized ? renderWebmaster() : renderAdminAuthGate("webmaster"))
          : (state.access.employee.authorized ? renderEmployee() : renderEmployeeAuthGate());
  document.title = buildDocumentTitle({
    appTitle: APP_DISPLAY_TITLE,
    route,
    employeeAuthorized: Boolean(state.access.employee.authorized),
    hrAuthorized: Boolean(state.access.hr.authorized),
    webmasterAuthorized: Boolean(state.access.webmaster.authorized),
    itAuthorized: Boolean(state.access.it.authorized),
    activeAdminTab,
    activeWebmasterTab,
    activeItTab
  });
  const focusSnapshot = captureFocusSnapshot();
  app.innerHTML = pageMarkup;
  restoreFocusSnapshot(focusSnapshot);
}

function captureFocusSnapshot() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !app.contains(active)) {
    return null;
  }

  return null;
}

function restoreFocusSnapshot(snapshot) {
  if (!snapshot) return;
  const target = app.querySelector(snapshot.selector);
  if (!(target instanceof HTMLElement)) return;

  target.focus();

  if (
    typeof snapshot.start === "number" &&
    typeof snapshot.end === "number" &&
    target instanceof HTMLInputElement &&
    typeof target.setSelectionRange === "function"
  ) {
    target.setSelectionRange(snapshot.start, snapshot.end);
  }
}

async function createPost(payload) {
  const result = await requestJson("/api/posts", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  state.posts.unshift(result.post);
  return result;
}

async function deletePost(id) {
  await requestJson(`/api/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.posts = state.posts.filter((post) => post.id !== id);
}

async function updateWeather(payload) {
  const result = await requestJson("/api/weather", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
  state.weather = result.weather;
}

async function handleDeleteAction(id) {
  try {
    await deletePost(id);
    setMessage("Announcement taken down.", "success");
  } catch (error) {
    setMessage(error.message || "Could not take down announcement.");
  }

  render();
  clearMessageSoon();
}

async function handlePostSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  try {
    const result = await createPost(data);
    form.reset();
    form.elements.audience.value = "All Employees";
    form.elements.alertRetention.value = "720h";
    if (result.notification?.error) {
      setMessage(`Published, but alert delivery failed: ${result.notification.error}`, "warning");
    } else if (result.post.notifyEmployees) {
      const pushResult = result.notification?.push || result.notification || {};
      const delivered = Number(pushResult.delivered || 0);
      const total = Number(pushResult.total || 0);
      setMessage(
        total > 0
          ? `Published and notified ${delivered}/${total} subscribed device${total === 1 ? "" : "s"}.`
          : "Published. No devices are subscribed for alerts.",
        "success"
      );
    } else {
      setMessage("Published.", "success");
    }
  } catch (error) {
    setMessage(error.message || "Could not publish.");
  }

  render();
  clearMessageSoon();
}

async function handleWeatherSubmit(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));

  try {
    await updateWeather(data);
    setMessage("Weather refreshed.", "success");
  } catch (error) {
    setMessage(error.message || "Could not update weather.");
  }

  render();
  clearMessageSoon();
}

async function handleDeviceSetupSubmit(event) {
  event.preventDefault();
  const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
  const setup = buildEmployeeSetupState();
  const action = resolveDeviceSetupAction({
    submitterAction: submitter?.dataset.deviceAction,
    primaryActionId: setup.primaryAction.id
  });
  render();

  try {
    if (action === "push") {
      await enablePushAlerts(state.deviceProfile);
      render();
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("subscribed", String(Date.now()));
      window.location.replace(nextUrl.toString());
      return;
    }
  } catch (error) {
    setMessage(formatPushError(error, "Could not subscribe this device."));
  }

  render();
  clearMessageSoon();
}

async function handleEmployeeLoginSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  state.access.employee = {
    ...state.access.employee,
    busy: true,
    error: ""
  };
  render();

  try {
    await requestJson("/api/employee/login", {
      method: "POST",
      body: JSON.stringify(data)
    });
    await hydrateRoute();
    state.message = "";
    state.messageType = "";
  } catch (error) {
    state.access.employee = {
      ...state.access.employee,
      authorized: false,
      employee: null,
      error: error.message || "Could not sign in."
    };
  } finally {
    state.access.employee.busy = false;
    render();
  }
}

async function handleAdminAuthSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const mode = form.dataset.adminAuthMode === "setup" ? "setup" : "login";
  const route = normalizeAdminScope(form.dataset.adminRoute);
  const targetAccess = route;
  const endpoint = route === "it"
    ? (mode === "setup" ? "/api/it/setup" : "/api/it/login")
    : route === "webmaster"
    ? (mode === "setup" ? "/api/webmaster/setup" : "/api/webmaster/login")
    : (mode === "setup" ? "/api/hr/setup" : "/api/hr/login");

  state.access[targetAccess] = {
    ...state.access[targetAccess],
    busy: true,
    error: ""
  };
  render();

  try {
    const result = await requestJson(endpoint, {
      method: "POST",
      body: JSON.stringify(data)
    });
    clearAdminMfaState(route);
    await hydrateRoute();
    if (result.mfaRequired) {
      setMessage(
        result.mfaMode === "verify"
          ? "Enter the current Google Authenticator code to finish sign in."
          : "Set up Google Authenticator to finish access setup.",
        "success"
      );
    } else if (mode === "setup") {
      setMessage(
        route === "it" ? "IT credentials configured." : route === "webmaster" ? "Systems credentials configured." : "HR credentials configured.",
        "success"
      );
    } else {
      state.message = "";
      state.messageType = "";
    }
  } catch (error) {
    state.access[targetAccess] = {
      ...state.access[targetAccess],
      error: error.message || "Could not complete sign in."
    };
  } finally {
    state.access[targetAccess].busy = false;
    render();
  }
}

async function handleAcceptAdminInviteSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const route = currentRoute() === "it" ? "it" : currentRoute() === "webmaster" ? "webmaster" : "hr";
  const inviteToken = currentInviteToken();
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (!inviteToken) {
    setMessage("That invitation link is missing its token.");
    render();
    clearMessageSoon();
    return;
  }

  if (password !== confirmPassword) {
    setMessage("Passwords do not match.");
    render();
    clearMessageSoon();
    return;
  }

  state.adminInvite = {
    ...state.adminInvite,
    busy: true,
    error: ""
  };
  render();

  try {
    const result = await requestJson("/api/admin-invites/accept", {
      method: "POST",
      body: JSON.stringify({
        token: inviteToken,
        password
      })
    });
    clearAdminMfaState(result.preferredRoute || route);
    clearInviteToken(result.preferredRoute || route);
    resetAdminInviteState();
    await hydrateRoute();
    setMessage("Invitation accepted. Password saved.", "success");
  } catch (error) {
    state.adminInvite = {
      ...state.adminInvite,
      error: error.message || "Could not accept the invitation."
    };
  } finally {
    state.adminInvite.busy = false;
    render();
    clearMessageSoon();
  }
}

async function handleCreateEmployeeSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const data = Object.fromEntries(formData);
  data.passwordResetRequired = formData.get("passwordResetRequired") !== null;

  try {
    await requestJson("/api/employees", {
      method: "POST",
      body: JSON.stringify(data)
    });
    form.reset();
    await refreshAdminData();
    setMessage("Employee account created.", "success");
  } catch (error) {
    setMessage(error.message || "Could not create the employee account.");
  }

  render();
  clearMessageSoon();
}

function cleanCredentialClipboardCell(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function formatEmployeeBatchCredentialsForClipboard(credentials = employeeBatchCredentialRows()) {
  const rows = [["Name", "Username", "Temporary Password"]];

  for (const credential of credentials) {
    rows.push([
      cleanCredentialClipboardCell(credential.name),
      cleanCredentialClipboardCell(credential.username),
      cleanCredentialClipboardCell(credential.temporaryPassword)
    ]);
  }

  return rows.map((row) => row.join("\t")).join("\n");
}

function inferEmployeeBatchFormatFromFileName(fileName) {
  const lowerName = String(fileName || "").toLowerCase();

  if (lowerName.endsWith(".json")) {
    return "json";
  }

  if (lowerName.endsWith(".yaml") || lowerName.endsWith(".yml")) {
    return "yaml";
  }

  return "auto";
}

async function handleEmployeeBatchFileChange(event) {
  const input = event.target;

  if (!(input instanceof HTMLInputElement) || !input.matches("[data-employee-batch-file]")) {
    return;
  }

  const file = input.files?.[0];

  if (!file) {
    return;
  }

  try {
    const content = await file.text();
    const form = input.closest("[data-employee-batch-form]");
    const textarea = form?.querySelector("textarea[name='content']");
    const formatSelect = form?.querySelector("select[name='format']");

    if (textarea instanceof HTMLTextAreaElement) {
      textarea.value = content;
    }

    if (formatSelect instanceof HTMLSelectElement) {
      formatSelect.value = inferEmployeeBatchFormatFromFileName(file.name);
    }
  } catch {
    setMessage("Could not read the upload file.");
    render();
    clearMessageSoon();
  }
}

async function handleEmployeeBatchUploadSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const content = String(formData.get("content") || "").trim();
  const format = String(formData.get("format") || "auto");

  if (!content) {
    setMessage("Paste JSON or YAML before importing.");
    render();
    clearMessageSoon();
    return;
  }

  state.employeeBatchUpload = {
    ...state.employeeBatchUpload,
    busy: true,
    content,
    format
  };
  render();

  try {
    const result = await requestJson("/api/employees/batch", {
      method: "POST",
      body: JSON.stringify({
        format,
        content
      })
    });
    const credentials = Array.isArray(result.credentials) ? result.credentials : [];
    state.employeeBatchUpload = {
      busy: false,
      content: "",
      created: Number(result.created || credentials.length || 0),
      credentials,
      format: "auto"
    };
    form.reset();
    await refreshAdminData();
    setMessage(`Imported ${state.employeeBatchUpload.created} employee account${state.employeeBatchUpload.created === 1 ? "" : "s"}. Copy temporary credentials now.`, "success");
  } catch (error) {
    state.employeeBatchUpload = {
      ...state.employeeBatchUpload,
      busy: false,
      content,
      format
    };
    setMessage(error.message || "Could not import employee accounts.");
  }

  render();
  clearMessageSoon();
}

async function handleCopyEmployeeBatchCredentials(event) {
  event.preventDefault();
  const credentials = employeeBatchCredentialRows();

  if (!credentials.length) {
    setMessage("No batch credentials are available to copy.");
    render();
    clearMessageSoon();
    return;
  }

  const copied = await copyText(formatEmployeeBatchCredentialsForClipboard(credentials));
  setMessage(copied ? "Copied temporary credentials." : "Could not copy temporary credentials.", copied ? "success" : "");
  render();
  clearMessageSoon();
}

function handleClearEmployeeBatchResults(event) {
  event.preventDefault();
  state.employeeBatchUpload = {
    busy: false,
    content: "",
    created: 0,
    credentials: [],
    format: "auto"
  };
  setMessage("Cleared temporary credentials from this screen.", "success");
  render();
  clearMessageSoon();
}

function resetAdminCreateFormDefaults(form, scope) {
  if (scope === "it") {
    const defaultRole = form.querySelector('input[name="roles"][value="hr"]');
    if (defaultRole instanceof HTMLInputElement) {
      defaultRole.checked = true;
    }
  }
}

function adminMfaApiBase(route) {
  return route === "it"
    ? "/api/it/mfa"
    : route === "webmaster"
      ? "/api/webmaster/mfa"
      : "/api/hr/mfa";
}

async function handleAdminMfaEnrollSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const route = normalizeAdminScope(form.dataset.adminRoute);

  writeAdminMfaState(route, {
    busy: true
  });
  state.access[route] = {
    ...state.access[route],
    error: ""
  };
  render();

  try {
    const result = await requestJson(`${adminMfaApiBase(route)}/enroll`, {
      method: "POST",
      body: JSON.stringify({})
    });
    writeAdminMfaState(route, {
      busy: false,
      details: result
    });
    setMessage("Scan the QR code with Google Authenticator, then verify the current code.", "success");
  } catch (error) {
    writeAdminMfaState(route, {
      busy: false
    });
    state.access[route] = {
      ...state.access[route],
      error: error.message || "Could not start Google Authenticator setup."
    };
  }

  render();
  clearMessageSoon();
}

async function handleAdminMfaVerifySubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const route = normalizeAdminScope(form.dataset.adminRoute);
  const access = state.access[route];
  const enabling = Boolean(readAdminMfaState(route).details) || access.mfaMode === "setup";

  writeAdminMfaState(route, {
    busy: true
  });
  state.access[route] = {
    ...state.access[route],
    error: ""
  };
  render();

  try {
    await requestJson(`${adminMfaApiBase(route)}/verify`, {
      method: "POST",
      body: JSON.stringify({
        code: String(formData.get("code") || "")
      })
    });
    clearAdminMfaState(route);
    await hydrateRoute();
    setMessage(enabling ? "Google Authenticator enabled." : "Google Authenticator verified.", "success");
  } catch (error) {
    writeAdminMfaState(route, {
      busy: false
    });
    state.access[route] = {
      ...state.access[route],
      error: error.message || "Could not verify the authenticator code."
    };
  }

  render();
  clearMessageSoon();
}

async function handleAdminMfaPolicySubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const enabled = formData.get("enabled") !== null;
  const reason = String(formData.get("reason") || "").trim();

  if (!enabled && !reason) {
    setMessage("Enter a reason before turning off admin MFA.");
    render();
    clearMessageSoon();
    return;
  }

  state.adminMfaPolicy = {
    ...state.adminMfaPolicy,
    busy: true
  };
  render();

  try {
    const result = await requestJson("/api/it/mfa-policy", {
      method: "POST",
      body: JSON.stringify({
        enabled,
        reason
      })
    });
    state.adminMfaPolicy = {
      loaded: true,
      busy: false,
      policy: normalizeAdminMfaPolicy(result.policy)
    };
    clearAdminMfaState("it");
    await refreshItData();
    setMessage(enabled ? "Admin MFA requirement is on." : "Admin MFA requirement is off.", "success");
  } catch (error) {
    state.adminMfaPolicy = {
      ...state.adminMfaPolicy,
      busy: false
    };
    setMessage(error.message || "Could not update the MFA requirement.");
  }

  render();
  clearMessageSoon();
}

async function handleCreateAdminSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const scope = normalizeAdminScope(form.dataset.adminScope);
  const adminApi = adminApiBase(scope);
  const payload = {
    displayName: formData.get("displayName"),
    username: formData.get("username"),
    roles: formData.getAll("roles")
  };

  try {
    const password = String(formData.get("password") || "");

    if (password.length < 10) {
      throw new Error("Temporary password must be at least 10 characters.");
    }

    const result = await requestJson(adminApi, {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        password
      })
    });
    form.reset();
    resetAdminCreateFormDefaults(form, scope);
    await refreshAdminManagementScope(scope);
    setMessage(
      scope === "it"
        ? "Admin account created with a temporary password."
        : scope === "webmaster"
          ? "System Ops admin account created with a temporary password."
          : "Admin account created with a temporary password.",
      "success"
    );
  } catch (error) {
    setMessage(error.message || "Could not create the admin account.");
  }

  render();
  clearMessageSoon();
}

async function handleUpdateAdminProfileSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const adminUserId = String(formData.get("adminUserId") || "");
  const scope = normalizeAdminScope(form.dataset.adminScope);

  try {
    await requestJson(`${adminApiBase(scope)}/${encodeURIComponent(adminUserId)}/profile`, {
      method: "POST",
      body: JSON.stringify({
        displayName: formData.get("displayName")
      })
    });
    await refreshAdminManagementScope(scope);
    setMessage(scope === "webmaster" ? "System Ops admin identity updated." : "Admin identity updated.", "success");
  } catch (error) {
    setMessage(error.message || "Could not update the admin identity.");
  }

  render();
  clearMessageSoon();
}

async function handleAdminAccessSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const adminUserId = String(formData.get("adminUserId") || "");
  const active = String(formData.get("active") || "") === "true";
  const scope = normalizeAdminScope(form.dataset.adminScope);

  try {
    await requestJson(`${adminApiBase(scope)}/${encodeURIComponent(adminUserId)}/status`, {
      method: "POST",
      body: JSON.stringify({
        active
      })
    });
    await refreshAdminManagementScope(scope);
    setMessage(
      active
        ? scope === "webmaster"
          ? "System Ops admin access restored."
          : "Admin access restored."
        : scope === "webmaster"
          ? "System Ops admin access disabled."
          : "Admin access disabled.",
      "success"
    );
  } catch (error) {
    setMessage(error.message || "Could not update admin access.");
  }

  render();
  clearMessageSoon();
}

async function handleUpdateAdminRolesSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const adminUserId = String(formData.get("adminUserId") || "");
  const scope = normalizeAdminScope(form.dataset.adminScope);

  try {
    await requestJson(`${adminApiBase(scope)}/${encodeURIComponent(adminUserId)}/roles`, {
      method: "POST",
      body: JSON.stringify({
        roles: formData.getAll("roles")
      })
    });
    await refreshAdminManagementScope(scope);
    setMessage(scope === "webmaster" ? "System Ops admin roles updated." : "Admin roles updated.", "success");
  } catch (error) {
    setMessage(error.message || "Could not update admin roles.");
  }

  render();
  clearMessageSoon();
}

async function handleResetAdminPasswordSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const adminUserId = String(formData.get("adminUserId") || "");
  const scope = normalizeAdminScope(form.dataset.adminScope);

  try {
    await requestJson(`${adminApiBase(scope)}/${encodeURIComponent(adminUserId)}/password`, {
      method: "POST",
      body: JSON.stringify({
        password: formData.get("password")
      })
    });
    form.reset();
    await refreshAdminManagementScope(scope);
    setMessage(
      scope === "webmaster"
        ? "System Ops admin password reset. Existing sessions were signed out."
        : "Admin password reset. Existing sessions were signed out.",
      "success"
    );
  } catch (error) {
    setMessage(error.message || "Could not reset the admin password.");
  }

  render();
  clearMessageSoon();
}

async function handleEmployeeAccessSubmit(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));

  try {
    await requestJson(`/api/employees/${encodeURIComponent(String(data.employeeId || ""))}/status`, {
      method: "POST",
      body: JSON.stringify({
        active: String(data.active || "") === "true"
      })
    });
    await refreshAdminData();
    setMessage(String(data.active || "") === "true" ? "Employee access restored." : "Employee access disabled.", "success");
  } catch (error) {
    setMessage(error.message || "Could not update employee access.");
  }

  render();
  clearMessageSoon();
}

async function handleResetEmployeePasswordSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  try {
    await requestJson(`/api/employees/${encodeURIComponent(String(data.employeeId || ""))}/password`, {
      method: "POST",
      body: JSON.stringify({
        password: data.password
      })
    });
    form.reset();
    await refreshAdminData();
    setMessage("Employee password reset.", "success");
  } catch (error) {
    setMessage(error.message || "Could not reset the password.");
  }

  render();
  clearMessageSoon();
}

async function handleUnenrollEmployeeDevicesSubmit(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const employeeId = String(data.employeeId || "");

  try {
    const result = await requestJson(`/api/employees/${encodeURIComponent(employeeId)}/devices/unenroll`, {
      method: "POST"
    });
    await refreshAdminData();
    const removedCount = Number(result.removedCount || 0);
    setMessage(
      removedCount > 0
        ? `${removedCount} device${removedCount === 1 ? "" : "s"} unenrolled.`
        : "No enrolled devices found.",
      "success"
    );
  } catch (error) {
    setMessage(error.message || "Could not unenroll employee devices.");
  }

  render();
  clearMessageSoon();
}

async function handlePrivilegedPasswordChangeSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const route = form.dataset.roleRoute === "webmaster" ? "webmaster" : "hr";
  const role = route === "webmaster" ? "Systems" : "HR";
  const data = Object.fromEntries(new FormData(form));

  if (String(data.password || "") !== String(data.confirmPassword || "")) {
    setMessage("New passwords do not match.");
    render();
    clearMessageSoon();
    return;
  }

  try {
    const result = await requestJson(route === "webmaster" ? "/api/webmaster/password" : "/api/hr/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: data.currentPassword,
        password: data.password
      })
    });
    form.reset();

    if (route === "webmaster") {
      state.access.webmaster = {
        ...state.access.webmaster,
        ...result,
        error: ""
      };
    } else {
      state.access.hr = {
        ...state.access.hr,
        ...result,
        error: ""
      };
    }

    state.passwordChangeStatus = {
      ...(state.passwordChangeStatus || {}),
      [route]: {
        changedAt: new Date().toISOString(),
        otherSessionsSignedOut: true
      }
    };

    setMessage(`${role} password updated. Other active sessions were signed out.`, "success");
  } catch (error) {
    setMessage(error.message || `Could not update the ${role.toLowerCase()} password.`);
  }

  render();
  clearMessageSoon();
}

async function handleHrMasterRecoverySubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  if (String(data.password || "") !== String(data.confirmPassword || "")) {
    setMessage("New passwords must match.");
    render();
    clearMessageSoon();
    return;
  }

  try {
    const result = await requestJson("/api/hr/recover", {
      method: "POST",
      body: JSON.stringify({
        recoveryToken: data.recoveryToken,
        password: data.password
      })
    });
    form.reset();
    state.authRecovery.hr = false;
    state.access.hr = {
      ...state.access.hr,
      ...result,
      authorized: true,
      setupRequired: false,
      error: ""
    };
    setMessage("HR access recovered.", "success");
    await hydrateRoute();
  } catch (error) {
    setMessage(error.message || "Could not recover HR access.");
  }

  render();
  clearMessageSoon();
}

async function handleWebmasterResetHrPasswordSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  if (String(data.password || "") !== String(data.confirmPassword || "")) {
    setMessage("New passwords must match.");
    render();
    clearMessageSoon();
    return;
  }

  try {
    await requestJson("/api/hr/password/reset", {
      method: "POST",
      body: JSON.stringify({
        password: data.password
      })
    });
    form.reset();
    setMessage("HR password reset. Existing HR sessions were signed out.", "success");
  } catch (error) {
    setMessage(error.message || "Could not reset the HR password.");
  }

  render();
  clearMessageSoon();
}

async function handleRevokeEmployeeSessionsSubmit(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));

  try {
    await requestJson(`/api/employees/${encodeURIComponent(String(data.employeeId || ""))}/sessions/revoke`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await refreshAdminData();
    setMessage("Employee sessions revoked.", "success");
  } catch (error) {
    setMessage(error.message || "Could not revoke employee sessions.");
  }

  render();
  clearMessageSoon();
}

async function handleAddEmployeeHrGroupSubmit(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));

  try {
    await requestJson(`/api/employees/${encodeURIComponent(String(data.employeeId || ""))}/hr-group`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await refreshAdminData();
    setMessage("Employee added to HR. They can use their username and current password on the HR login.", "success");
  } catch (error) {
    setMessage(error.message || "Could not add employee to HR.");
  }

  render();
  clearMessageSoon();
}

async function handleRevokeAdminSessionsSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const adminUserId = String(formData.get("adminUserId") || "");
  const scope = normalizeAdminScope(form.dataset.adminScope);

  try {
    await requestJson(`${adminApiBase(scope)}/${encodeURIComponent(adminUserId)}/sessions/revoke`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await refreshAdminManagementScope(scope);
    setMessage(scope === "webmaster" ? "System Ops admin sessions revoked." : "Admin sessions revoked.", "success");
  } catch (error) {
    setMessage(error.message || "Could not revoke admin sessions.");
  }

  render();
  clearMessageSoon();
}

async function handleDeleteEmployeeSubmit(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const employeeId = String(data.employeeId || "");
  const employeeName = String(data.employeeName || "this employee");
  const confirmed = window.confirm(
    `Permanently remove ${employeeName}? This will permanently remove the account credentials, sessions, and associated data. This cannot be undone.`
  );

  if (!confirmed) {
    return;
  }

  try {
    await requestJson(`/api/employees/${encodeURIComponent(employeeId)}`, {
      method: "DELETE"
    });
    await refreshAdminData();
    setMessage(`${employeeName}'s employee account and associated data were deleted.`, "success");
  } catch (error) {
    setMessage(error.message || "Could not delete the employee account.");
  }

  render();
  clearMessageSoon();
}

async function handleDeleteAdminSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const adminUserId = String(data.adminUserId || "");
  const adminName = String(data.adminName || "this admin");
  const scope = normalizeAdminScope(form.dataset.adminScope);
  const confirmed = window.confirm(
    `Permanently remove ${adminName}? This will permanently remove the account credentials, sessions, and associated data. This cannot be undone.`
  );

  if (!confirmed) {
    return;
  }

  try {
    await requestJson(`${adminApiBase(scope)}/${encodeURIComponent(adminUserId)}`, {
      method: "DELETE"
    });
    await refreshAdminManagementScope(scope);
    setMessage(`${adminName}'s admin account was deleted.`, "success");
  } catch (error) {
    setMessage(error.message || "Could not delete the admin account.");
  }

  render();
  clearMessageSoon();
}

function clickedElement(event) {
  if (event.target instanceof Element) return event.target;
  return event.target?.parentElement || null;
}

document.addEventListener("click", async (event) => {
  const target = clickedElement(event);
  if (!target || !app.contains(target)) return;
  if (target.closest("input, select, textarea, label")) return;

  const routeButton = target.closest("button[data-route], a[data-route], [role='button'][data-route]");
  const openAuthRecoveryButton = target.closest("[data-open-auth-recovery]");
  const closeAuthRecoveryButton = target.closest("[data-close-auth-recovery]");
  const tabButton = target.closest("[data-tab]");
  const hrSummaryButton = target.closest("[data-hr-summary-tab]");
  const copyWebmasterBriefButton = target.closest("[data-copy-webmaster-brief]");
  const copyWebmasterJsonButton = target.closest("[data-copy-webmaster-json]");
  const copyEmployeeBatchCredentialsButton = target.closest("[data-copy-employee-batch-credentials]");
  const clearEmployeeBatchResultsButton = target.closest("[data-clear-employee-batch-results]");
  const enableAlertsButton = target.closest("[data-enable-alerts]");
  const disableAlertsButton = target.closest("[data-disable-alerts]");
  const sendTestPushButton = target.closest("[data-send-test-push]");
  const pushRosterFilterButton = target.closest("[data-push-roster-filter]");
  const webmasterDrilldownButton = target.closest("[data-webmaster-drilldown-tab]");
  const employeeLogoutButton = target.closest("[data-employee-logout]");
  const adminLogoutButton = target.closest("[data-admin-logout]");
  const reloadAppButton = target.closest("[data-reload-app]");

  if (reloadAppButton) {
    event.preventDefault();
    await reloadForAppUpdate();
    return;
  }

  if (routeButton) {
    event.preventDefault();
    await routeTo(routeButton.dataset.route);
    return;
  }

  if (openAuthRecoveryButton) {
    event.preventDefault();
    const route = String(openAuthRecoveryButton.dataset.openAuthRecovery || "");
    if (route === "hr") state.authRecovery.hr = true;
    if (route === "webmaster") state.authRecovery.webmaster = true;
    render();
    return;
  }

  if (closeAuthRecoveryButton) {
    event.preventDefault();
    const route = String(closeAuthRecoveryButton.dataset.closeAuthRecovery || "");
    if (route === "hr") state.authRecovery.hr = false;
    if (route === "webmaster") state.authRecovery.webmaster = false;
    render();
    return;
  }

  if (tabButton) {
    event.preventDefault();
    if (tabButton.dataset.tabGroup === "hr") {
      activeAdminTab = tabButton.dataset.tab || "feed";
    } else if (tabButton.dataset.tabGroup === "it") {
      activeItTab = tabButton.dataset.tab || "accounts";
    } else if (tabButton.dataset.tabGroup === "webmaster") {
      activeWebmasterTab = tabButton.dataset.tab || "overview";
    }
    render();
    return;
  }

  if (hrSummaryButton) {
    event.preventDefault();
    openHrSummaryTarget(
      String(hrSummaryButton.dataset.hrSummaryTab || "feed"),
      String(hrSummaryButton.dataset.hrSummaryFilter || "")
    );
    return;
  }

  if (pushRosterFilterButton) {
    event.preventDefault();
    activePushRosterFilter = pushRosterFilterButton.dataset.pushRosterFilter || "active";
    render();
    return;
  }

  if (webmasterDrilldownButton) {
    event.preventDefault();
    activeWebmasterTab = webmasterDrilldownButton.dataset.webmasterDrilldownTab || "overview";
    setWebmasterCardsExpanded(
      String(webmasterDrilldownButton.dataset.webmasterDrilldownCards || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      true
    );
    render();
    return;
  }

  if (employeeLogoutButton) {
    event.preventDefault();
    if (!window.confirm("Are you sure you want to sign out?")) {
      return;
    }
    await requestJson("/api/employee/logout", {
      method: "POST",
      body: JSON.stringify({})
    });
    state.access.employee = {
      ...state.access.employee,
      authorized: false,
      sessionExpiresAt: "",
      employee: null,
      error: ""
    };
    state.posts = [];
    render();
    return;
  }

  if (adminLogoutButton) {
    event.preventDefault();
    const route = currentRoute() === "it" ? "it" : currentRoute() === "webmaster" ? "webmaster" : "hr";
    await requestJson(route === "it" ? "/api/it/logout" : route === "webmaster" ? "/api/webmaster/logout" : "/api/hr/logout", {
      method: "POST",
      body: JSON.stringify({})
    });
    clearAdminMfaState(route);
    if (route === "it") {
      state.access.it = {
        ...state.access.it,
        authorized: false,
        sessionExpiresAt: "",
        csrfToken: "",
        error: ""
      };
    } else if (route === "webmaster") {
      state.access.webmaster = {
        ...state.access.webmaster,
        authorized: false,
        sessionExpiresAt: "",
        csrfToken: "",
        error: ""
      };
    } else {
      state.access.hr = {
        ...state.access.hr,
        authorized: false,
        setupRequired: false,
        sessionExpiresAt: "",
        csrfToken: "",
        error: ""
      };
    }
    await hydrateRoute();
    render();
    return;
  }

  if (target.closest("[data-refresh]")) {
    if (currentRoute() === "it") {
      await refreshItData();
    } else if (currentRoute() === "webmaster") {
      await refreshWebmasterData();
    } else if (currentRoute() === "hr") {
      await refreshAdminData();
    } else {
      await loadBoard();
      void syncPushState();
    }
    setMessage("Refreshed.", "success");
    render();
    clearMessageSoon();
    return;
  }

  if (copyWebmasterBriefButton) {
    event.preventDefault();
    const brief = app.querySelector("[data-webmaster-brief]")?.value || buildCodexBrief();
    const copied = await copyText(brief);
    setMessage(copied ? "Copied Codex brief." : "Could not copy the brief.");
    render();
    clearMessageSoon();
    return;
  }

  if (copyWebmasterJsonButton) {
    event.preventDefault();
    const raw = app.querySelector("[data-webmaster-json]")?.value || JSON.stringify(buildWebmasterSnapshot(), null, 2);
    const copied = await copyText(raw);
    setMessage(copied ? "Copied analytics JSON." : "Could not copy the JSON.");
    render();
    clearMessageSoon();
    return;
  }

  if (copyEmployeeBatchCredentialsButton) {
    await handleCopyEmployeeBatchCredentials(event);
    return;
  }

  if (clearEmployeeBatchResultsButton) {
    handleClearEmployeeBatchResults(event);
    return;
  }

  if (enableAlertsButton) {
    event.preventDefault();

    try {
      await enablePushAlerts();
    } catch (error) {
      setMessage(formatPushError(error, "Could not subscribe this device."));
      render();
    }
    clearMessageSoon();
    return;
  }

  if (disableAlertsButton) {
    event.preventDefault();

    try {
      await disablePushAlerts();
    } catch (error) {
      setMessage(formatPushError(error, "Could not turn off alerts."));
      render();
    }
    clearMessageSoon();
    return;
  }

  if (sendTestPushButton) {
    event.preventDefault();

    try {
      await sendTestPush();
    } catch (error) {
      setMessage(formatPushError(error, "Could not send a test push."));
      render();
    }
    return;
  }
}, true);

app.addEventListener("submit", async (event) => {
  if (event.target.matches("[data-employee-login-form]")) {
    await handleEmployeeLoginSubmit(event);
    return;
  }

  if (event.target.matches("[data-admin-auth-form]")) {
    await handleAdminAuthSubmit(event);
    return;
  }

  if (event.target.matches("[data-admin-mfa-enroll-form]")) {
    await handleAdminMfaEnrollSubmit(event);
    return;
  }

  if (event.target.matches("[data-admin-mfa-verify-form]")) {
    await handleAdminMfaVerifySubmit(event);
    return;
  }

  if (event.target.matches("[data-admin-mfa-policy-form]")) {
    await handleAdminMfaPolicySubmit(event);
    return;
  }

  if (event.target.matches("[data-accept-admin-invite-form]")) {
    await handleAcceptAdminInviteSubmit(event);
    return;
  }

  if (event.target.matches("[data-privileged-password-form]")) {
    await handlePrivilegedPasswordChangeSubmit(event);
    return;
  }

  if (event.target.matches("[data-hr-master-recovery-form]")) {
    await handleHrMasterRecoverySubmit(event);
    return;
  }

  if (event.target.matches("[data-webmaster-reset-hr-password-form]")) {
    await handleWebmasterResetHrPasswordSubmit(event);
    return;
  }

  if (event.target.matches("[data-create-employee-form]")) {
    await handleCreateEmployeeSubmit(event);
    return;
  }

  if (event.target.matches("[data-employee-batch-form]")) {
    await handleEmployeeBatchUploadSubmit(event);
    return;
  }

  if (event.target.matches("[data-create-admin-form]")) {
    await handleCreateAdminSubmit(event);
    return;
  }

  if (event.target.matches("[data-update-admin-profile-form]")) {
    await handleUpdateAdminProfileSubmit(event);
    return;
  }

  if (event.target.matches("[data-update-admin-roles-form]")) {
    await handleUpdateAdminRolesSubmit(event);
    return;
  }

  if (event.target.matches("[data-admin-access-form]")) {
    await handleAdminAccessSubmit(event);
    return;
  }

  if (event.target.matches("[data-reset-admin-password-form]")) {
    await handleResetAdminPasswordSubmit(event);
    return;
  }

  if (event.target.matches("[data-revoke-admin-sessions-form]")) {
    await handleRevokeAdminSessionsSubmit(event);
    return;
  }

  if (event.target.matches("[data-delete-admin-form]")) {
    await handleDeleteAdminSubmit(event);
    return;
  }

  if (event.target.matches("[data-employee-access-form]")) {
    await handleEmployeeAccessSubmit(event);
    return;
  }

  if (event.target.matches("[data-reset-employee-password-form]")) {
    await handleResetEmployeePasswordSubmit(event);
    return;
  }

  if (event.target.matches("[data-unenroll-employee-devices-form]")) {
    await handleUnenrollEmployeeDevicesSubmit(event);
    return;
  }

  if (event.target.matches("[data-revoke-employee-sessions-form]")) {
    await handleRevokeEmployeeSessionsSubmit(event);
    return;
  }

  if (event.target.matches("[data-add-employee-hr-group-form]")) {
    await handleAddEmployeeHrGroupSubmit(event);
    return;
  }

  if (event.target.matches("[data-delete-employee-form]")) {
    await handleDeleteEmployeeSubmit(event);
    return;
  }

  if (event.target.matches("[data-device-setup-form]")) {
    await handleDeviceSetupSubmit(event);
    return;
  }

  if (event.target.matches("[data-post-form]")) {
    await handlePostSubmit(event);
    return;
  }

  if (event.target.matches("[data-weather-form]")) {
    await handleWeatherSubmit(event);
    return;
  }

  if (event.target.matches("[data-delete-post-form]")) {
    event.preventDefault();
    const id = new FormData(event.target).get("id");
    await handleDeleteAction(id);
    return;
  }

  if (event.target.matches("[data-unsubscribe-device-form]")) {
    event.preventDefault();
    const endpoint = new FormData(event.target).get("endpoint");

    try {
      await unsubscribeDevice(endpoint);
      setMessage("Removed the device from push delivery.", "success");
    } catch (error) {
      setMessage(error.message || "Could not remove the device.");
    }

    render();
    clearMessageSoon();
  }
});

app.addEventListener("change", async (event) => {
  await handleEmployeeBatchFileChange(event);
});

app.addEventListener("toggle", (event) => {
  if (!(event.target instanceof HTMLDetailsElement)) return;

  if (event.target.matches("[data-webmaster-expand-id]")) {
    const cardId = String(event.target.dataset.webmasterExpandId || "");

    if (cardId) {
      state.webmaster.expanded[cardId] = event.target.open;
    }

    return;
  }
}, true);

app.addEventListener("toggle", (event) => {
  if (!(event.target instanceof HTMLDetailsElement)) return;
  if (!event.target.matches("[data-employee-install-guide]")) return;

  state.employeeInstallGuideOpen = event.target.open;
}, true);

window.addEventListener("hashchange", async () => {
  await hydrateRoute();
  render();
  scheduleClientShellCheck("hashchange");
});

window.addEventListener("popstate", async () => {
  await hydrateRoute();
  render();
  scheduleClientShellCheck("popstate");
});

window.addEventListener("error", (event) => {
  sendClientTelemetry({
    type: "runtime-error",
    severity: "error",
    detail: String(event.message || "Unhandled client runtime error.").slice(0, 240)
  }, { onceKey: `runtime-error:${String(event.message || "unknown").slice(0, 120)}` });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason || "Unhandled promise rejection");
  sendClientTelemetry({
    type: "unhandled-rejection",
    severity: "error",
    detail: reason.slice(0, 240)
  }, { onceKey: `unhandled-rejection:${reason.slice(0, 120)}` });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(APP_ASSET_VERSION)}`).catch(() => {});
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", async (event) => {
    if (event.data?.type !== "board-updated") {
      return;
    }

    try {
      await hydrateRoute();
      render();
    } catch {
      // Ignore refresh errors from background updates.
    }
  });
}

window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void checkForAppUpdate();
  }
});

window.setInterval(async () => {
  if (currentRoute() !== "employee" || document.visibilityState !== "visible") {
    return;
  }

  try {
    await hydrateRoute();
    render();
  } catch {
    // Keep the UI stable if polling fails.
  }
}, EMPLOYEE_REFRESH_MS);

window.setInterval(() => {
  if (document.visibilityState !== "visible") {
    return;
  }

  void checkForAppUpdate();
}, 60_000);

try {
  await hydrateRoute();
} catch (error) {
  setMessage(error.message || "Could not load the app.");
  sendClientTelemetry({
    type: "bootstrap-error",
    severity: "error",
    detail: String(error?.message || "Could not load the app.").slice(0, 240)
  }, { onceKey: "bootstrap-error" });
} finally {
  state.loading = false;
  render();
  scheduleClientShellCheck("initial-load");
  void checkForAppUpdate();
}
