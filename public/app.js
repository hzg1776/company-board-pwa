import { resolveDeviceSetupAction } from "./device-setup.js";

const DEFAULT_SITE_CONFIG = {
  name: "Palziv",
  nameSuffix: "",
  shortName: "Palziv",
  subtitle: "Updates & Alerts Portal",
  description: "Updates and alerts portal for Palziv with HR-managed company news, weather, and push notifications."
};

const SITE_CONFIG = Object.freeze({
  ...DEFAULT_SITE_CONFIG,
  ...(window.__BOARD_CONFIG__ || {})
});

const APP_ASSET_VERSION = String(SITE_CONFIG.assetVersion || "20260615");
const APP_TITLE = String(SITE_CONFIG.name || DEFAULT_SITE_CONFIG.name);
const APP_NAME_SUFFIX = String(SITE_CONFIG.nameSuffix || DEFAULT_SITE_CONFIG.nameSuffix);
const APP_DISPLAY_TITLE = APP_NAME_SUFFIX ? `${APP_TITLE} ${APP_NAME_SUFFIX}` : APP_TITLE;
const APP_SUBTITLE = String(SITE_CONFIG.subtitle || DEFAULT_SITE_CONFIG.subtitle);
const APP_BASE_PATH = "/palzivalerts";
const app = document.querySelector("#app");
const DEVICE_PROFILE_STORAGE_KEY = "palziv-employee-device-profile-v3";

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

function buildSuggestedDeviceLabel() {
  const browser = browserNameFromUserAgent();
  const platform = platformNameFromUserAgent();
  return `${platform} ${browser}`.trim();
}

function formatAccessPin(value) {
  const digits = String(value ?? "")
    .replace(/\D+/g, "")
    .slice(0, 8);

  return digits.replace(/(\d{4})(?=\d)/g, "$1-");
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
const historyFilters = ["All", "Urgent", "Weather", "News", "Shift", "Safety", "HR"];
let activeAdminTab = "publish";
let activeWebmasterTab = "overview";
let activeHistoryFilter = "All";
let employeeFeedSearch = "";
let employeeFeedFilter = "All";
let employeeFeedRenderTimer = 0;
const adminTabs = [
  { id: "publish", label: "Publish", icon: "megaphone" },
  { id: "weather", label: "Weather", icon: "cloud" },
  { id: "alerts", label: "Alerts", icon: "bell" },
  { id: "history", label: "History", icon: "board" },
  { id: "share", label: "Access", icon: "users" }
];
const employeeFeedFilters = ["All", "Urgent", "Important", "Normal", "News", "Weather", "Safety", "Shift", "HR"];
const webmasterTabs = [
  { id: "overview", label: "Overview", icon: "chart" },
  { id: "traffic", label: "Traffic", icon: "refresh" },
  { id: "system", label: "System", icon: "monitor" },
  { id: "content", label: "Content", icon: "board" },
  { id: "codex", label: "Codex", icon: "clipboard" }
];
const EMPLOYEE_REFRESH_MS = 60_000;

const state = {
  deviceProfile: loadDeviceProfile(),
  posts: [],
  weather: null,
  access: {
    hr: {
      loaded: false,
      authorized: false,
      pinRequired: true,
      pinVersion: 0,
      pinUpdatedAt: "",
      sessionExpiresAt: "",
      csrfToken: "",
      credentialManaged: false,
      busy: false,
      error: ""
    },
    webmaster: {
      loaded: false,
      authorized: false,
      hrAuthorized: false,
      browserBound: true,
      approvedBrowser: null,
      sessionExpiresAt: "",
      csrfToken: "",
      busy: false,
      error: ""
    }
  },
  hrAccessPin: null,
  webmaster: {
    loaded: false,
    summary: null,
    probes: {},
    browser: {},
    accessPin: null
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
    devices: [],
    pinRequired: false,
    pinVersion: 0,
    pinUpdatedAt: ""
  },
  message: "",
  messageType: "",
  employeeSetupOpen: false,
  loading: true
};

const icons = {
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  bell: '<path d="M10 21h4"/><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  board: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  chart: '<path d="M4 19h16"/><path d="M6 16V10"/><path d="M11 16V6"/><path d="M16 16v-5"/>',
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
  const text = String(value);
  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(text);
  if (Number.isNaN(date.getTime())) return "Never";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: text.includes("T") ? "numeric" : undefined,
    minute: text.includes("T") ? "2-digit" : undefined
  }).format(date);
}

function formatWeatherUpdatedAt(value) {
  if (!value) return "Not yet fetched";
  return formatDate(value);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePathname(pathname = window.location.pathname) {
  const value = String(pathname || "/");
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
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

function currentRoute() {
  const pathname = normalizePathname();
  const hash = window.location.hash || "";

  if (pathname === "/" || pathname === "/index.html" || pathname === APP_BASE_PATH) {
    return "launcher";
  }

  if (pathname === `${APP_BASE_PATH}/webmaster` || pathname === "/webmaster" || hash === "#webmaster") {
    return "webmaster";
  }

  if (pathname === `${APP_BASE_PATH}/hr` || pathname === `${APP_BASE_PATH}/admin` || pathname === "/hr" || pathname === "/admin" || hash === "#hr" || hash === "#admin") {
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

function routePath(route) {
  if (route === "webmaster") return appPath("webmaster");
  if (route === "hr") return appPath("hr");
  if (route === "admin") return appPath("hr");
  if (route === "employee") return appPath("employee");
  return appPath();
}

function routeTitle(route) {
  if (route === "launcher") return "Launcher";
  if (route === "webmaster") return "Webmaster";
  if (route === "hr") return "HR";
  if (route === "admin") return "HR";
  return "Employee";
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
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
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
  const security = summary.security || {};
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
  const pinRequired = state.pushStatus.loaded ? Boolean(state.pushStatus.pinRequired) : Boolean(notifications.accessPin?.enabled);
  const pinVersion = state.pushStatus.loaded ? Number(state.pushStatus.pinVersion || 0) : Number(notifications.accessPin?.version || 0);
  const pinUpdatedAt = state.pushStatus.loaded ? String(state.pushStatus.pinUpdatedAt || "") : String(notifications.accessPin?.updatedAt || "");

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
      devices: pushDevices,
      accessPin: {
        enabled: pinRequired,
        version: pinVersion,
        updatedAt: pinUpdatedAt
      }
    },
    security,
    traffic,
    browser,
    push: {
      supported: state.push.supported,
      permission: state.push.permission,
      subscribed: state.push.subscribed,
      subscriptions: pushSubscriptions,
      activeSubscriptions,
      inactiveSubscriptions,
      devices: pushDevices,
      pinRequired,
      pinVersion,
      pinUpdatedAt
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
    issues.push("The board has no published updates. Verify whether this is intentional.");
  }

  if (!browser.secureContext) {
    issues.push("The page is not running in a secure context; push and install behavior may be limited.");
  }

  if (issues.length === 0) {
    issues.push("No obvious runtime issue surfaced in the latest snapshot. Focus on the most recent traffic and content changes.");
  }

  return `# ${APP_DISPLAY_TITLE} Webmaster Brief
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
- Webmaster console: ${urls.webmaster || `${origin}${appPath("webmaster")}`}

## Raw Notes
Copying this into Codex should give it enough context to trace the site health and likely failure points quickly.
`;
}

function brandBlock(subtitle = APP_SUBTITLE) {
  return `
    <div class="brand">
      <div class="brand-lockup">
        <img class="brand-lockup-wordmark" src="/assets/palziv-wordmark.png" alt="${escapeHtml(APP_TITLE)}" loading="eager" decoding="async">
        <p>${escapeHtml(subtitle)}</p>
      </div>
    </div>
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

function renderStatCard(value, label, note = "") {
  return `
    <article class="stat-card">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
      ${note ? `<p>${escapeHtml(note)}</p>` : ""}
    </article>
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

  if (route === "/api/push/pin" || route === "/api/push/test") {
    return String(state.access.webmaster?.csrfToken || "");
  }

  if (
    route === "/api/hr/lock" ||
    route === "/api/hr/pin" ||
    route === "/api/webmaster/approve" ||
    route === "/api/webmaster/lock" ||
    route === "/api/posts" ||
    route.startsWith("/api/posts/") ||
    route === "/api/weather"
  ) {
    return String(state.access.hr?.csrfToken || "");
  }

  return "";
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

async function refreshAdminData() {
  const access = await loadHrAccessStatus();

  if (!access.authorized) {
    return {
      locked: true
    };
  }

  const [_, pushStatus] = await Promise.all([
    loadBoard(),
    loadPushStatus()
  ]);

  return {
    pushStatus
  };
}

async function refreshWebmasterData() {
  const [_, access] = await Promise.all([
    loadHrAccessStatus(),
    loadWebmasterAccessStatus()
  ]);

  if (!access.authorized) {
    return {
      locked: true
    };
  }

  const [summaryProbe, postsProbe, weatherProbe, pushProbe, healthProbe] = await Promise.all([
    safeTimedRequestJson("/api/webmaster/summary", null),
    safeTimedRequestJson("/api/posts", { posts: [] }),
    safeTimedRequestJson("/api/weather", { weather: defaultWeather() }),
    safeTimedRequestJson("/api/push/status", { supported: false, subscriptions: 0 }),
    safeTimedRequestJson("/api/health", { ok: false, now: nowIso() })
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
    devices: Array.isArray(pushProbe.body.devices) ? pushProbe.body.devices : [],
    pinRequired: Boolean(pushProbe.body.pinRequired),
    pinVersion: Number(pushProbe.body.pinVersion || 0),
    pinUpdatedAt: String(pushProbe.body.pinUpdatedAt || "")
  };
  state.webmaster = {
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
    accessPin: summaryProbe.body?.notifications?.accessPin || null,
    health: healthProbe.body || {}
  };

  await syncPushState();
  return state.webmaster;
}

function normalizeApprovedBrowser(value) {
  return value
    ? {
        label: String(value.label || ""),
        browser: String(value.browser || ""),
        platform: String(value.platform || ""),
        userAgent: String(value.userAgent || ""),
        updatedAt: String(value.updatedAt || "")
      }
    : null;
}

async function waitForWebmasterAuthorization(timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const probe = await safeTimedRequestJson("/api/webmaster/check", {
      authorized: false,
      hrAuthorized: false,
      browserBound: true,
      approvedBrowser: null,
      sessionExpiresAt: "",
      csrfToken: ""
    });

    if (probe.body?.authorized) {
      return probe.body;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }

  return null;
}

async function loadHrAccessStatus() {
  const probe = await safeTimedRequestJson("/api/hr/check", {
    authorized: false,
    pinRequired: true,
    pinVersion: 0,
    pinUpdatedAt: "",
    sessionExpiresAt: "",
    csrfToken: "",
    credentialManaged: false
  });

  state.access.hr = {
    ...state.access.hr,
    loaded: true,
    authorized: Boolean(probe.body.authorized),
    pinRequired: Boolean(probe.body.pinRequired),
    pinVersion: Number(probe.body.pinVersion || 0),
    pinUpdatedAt: String(probe.body.pinUpdatedAt || ""),
    sessionExpiresAt: String(probe.body.sessionExpiresAt || ""),
    csrfToken: String(probe.body.csrfToken || ""),
    credentialManaged: Boolean(probe.body.credentialManaged),
    error: ""
  };

  return state.access.hr;
}

async function loadWebmasterAccessStatus() {
  const probe = await safeTimedRequestJson("/api/webmaster/check", {
    authorized: false,
    hrAuthorized: false,
    browserBound: true,
    approvedBrowser: null,
    sessionExpiresAt: "",
    csrfToken: ""
  });

  const approvedBrowser = normalizeApprovedBrowser(probe.body.approvedBrowser);

  state.access.webmaster = {
    ...state.access.webmaster,
    loaded: true,
    authorized: Boolean(probe.body.authorized),
    hrAuthorized: Boolean(probe.body.hrAuthorized),
    browserBound: Boolean(probe.body.browserBound ?? true),
    approvedBrowser,
    sessionExpiresAt: String(probe.body.sessionExpiresAt || ""),
    csrfToken: String(probe.body.csrfToken || ""),
    error: ""
  };

  return state.access.webmaster;
}

function defaultWeather() {
  return {
    location: "",
    resolvedName: "",
    condition: "Weather not configured",
    temperature: "--",
    impact: "Enter a location in HR to fetch live weather.",
    level: "Clear",
    updatedAt: ""
  };
}

function pushSupportText() {
  if (!supportsPushNotifications()) {
    return isIosDevice()
      ? "On iPhone, install this site to the Home Screen and reopen it as the web app to enable push."
      : "This browser cannot receive push alerts. Open the portal in a push-capable browser to subscribe this device.";
  }

  if (state.pushStatus.pinRequired) {
    return "Enter the access PIN from HR before subscribing this device.";
  }

  if (!state.push.ready) {
    return "Checking alert support on this device.";
  }

  if (state.push.subscribed) {
    return "This device will receive broadcast updates.";
  }

  if (state.push.permission === "denied") {
    return "Notification access is turned off for this site.";
  }

  return "Subscribe this device to receive urgent updates.";
}

function formatPushError(error, fallback) {
  const message = String(error?.message || "").trim();
  const lower = message.toLowerCase();

  if (error?.statusCode === 403 || lower.includes("access pin") || lower.includes("pin is required") || lower.includes("invalid access pin")) {
    return "This device needs the current access PIN from HR.";
  }

  if (error?.name === "NotAllowedError" || lower.includes("permission denied") || lower.includes("permission is blocked")) {
    return "This browser blocked push registration. Allow notifications for this site and try again.";
  }

  if (lower.includes("not granted") || lower.includes("permission was not granted")) {
    return "Allow notifications for this site before subscribing this device.";
  }

  if (lower.includes("pushmanager") || lower.includes("push manager") || lower.includes("service worker")) {
    return "This browser cannot finish push setup on this page.";
  }

  return message || fallback;
}

function buildEmployeeSetupState() {
  const employeeName = String(
    state.deviceProfile.employeeName ||
    state.deviceProfile.label ||
    ""
  ).trim();
  const pushSupported = supportsPushNotifications();
  const pushSubscribed = Boolean(state.push.subscribed);
  const pushPermission = state.push.permission;
  const pinRequired = Boolean(state.pushStatus.pinRequired);
  const pushReady = pushSupported && pushPermission === "granted" && pushSubscribed;
  let nextStep = {
    title: "Save the employee name",
    detail: "Enter the employee's name so the roster shows exactly who subscribed.",
    action: "profile"
  };

  if (!pushSupported) {
    nextStep = isIosDevice()
      ? {
          title: "Install this site to Home Screen",
          detail: "On iPhone, web push only works from the installed web app. Add this site to your Home Screen, reopen the installed app, then subscribe.",
          action: "profile"
        }
      : {
          title: "No push support",
          detail: "This browser cannot use web push. Open the portal in a push-capable browser to enable alerts.",
          action: "profile"
        };
  } else if (pushPermission === "denied") {
      nextStep = {
        title: "Enable notifications for this site",
        detail: pinRequired
          ? "Notification access is turned off here. Enter the employee name and access PIN, then turn it back on and tap subscribe."
          : "Notification access is turned off here. Enter the employee name, then turn it back on and tap subscribe.",
        action: "profile"
      };
  } else if (pinRequired && !pushSubscribed) {
      nextStep = {
        title: "Enter the access PIN",
        detail: "Use the code from HR to enroll this device before alerts can be delivered.",
        action: "push"
      };
  } else if (!pushSubscribed) {
      nextStep = {
      title: "Subscribe this browser",
      detail: pinRequired
        ? "This browser can receive web push. Enter the employee name and access PIN, then tap subscribe to finish setup."
        : "This browser can receive web push. Enter the employee name, then tap subscribe to finish setup.",
      action: "push"
    };
  } else if (pushReady) {
    nextStep = {
      title: "This device is ready",
      detail: "Push is on and the device is enrolled.",
      action: "profile"
    };
  }

  const primaryAction = nextStep.action === "push"
    ? {
        id: "push",
        label: pushSubscribed ? "Refresh push setup" : pinRequired ? "Save name & PIN" : "Save name & subscribe",
        icon: "bell"
      }
    : {
        id: "profile",
        label: "Save employee name",
        icon: "clipboard"
      };

  const checklist = [
    {
      title: "Employee name",
      value: employeeName,
      detail: "Saved locally so this device stays easy to identify.",
      complete: Boolean(employeeName)
    },
    {
      title: "Access PIN",
      value: pinRequired ? "Required" : "Open",
      detail: pinRequired ? "Ask HR for the current access PIN before subscribing." : "No PIN is required for this portal right now.",
      complete: !pinRequired
    },
    {
      title: "Web push",
      value: pushSupported ? (pushReady ? "Ready" : pushPermission === "denied" ? "Blocked" : "Available") : "Unavailable",
      detail: pushSupported ? (pinRequired ? "Subscribe this browser after entering the access PIN." : "Subscribe this browser to receive push alerts.") : "This browser cannot use web push.",
      complete: pushReady
    }
  ];

  return {
    employeeName,
    pushSupported,
    pushSubscribed,
    pushPermission,
    pinRequired,
    busy: Boolean(state.push.busy),
    ready: Boolean(employeeName) && pushReady,
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
      devices: Array.isArray(result.devices) ? result.devices : [],
      pinRequired: Boolean(result.pinRequired),
      pinVersion: Number(result.pinVersion || 0),
      pinUpdatedAt: String(result.pinUpdatedAt || "")
    };
  } catch {
    state.pushStatus = {
      loaded: true,
      supported: false,
      subscriptions: 0,
      authorizedSubscriptions: 0,
      inactiveSubscriptions: 0,
      devices: [],
      pinRequired: false,
      pinVersion: 0,
      pinUpdatedAt: ""
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

  if (!supported) {
    state.push.subscribed = false;
    return state.push;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    state.push.subscribed = Boolean(subscription);
    state.push.ready = true;
  } catch (error) {
    state.push.subscribed = false;
    state.push.error = error instanceof Error ? error.message : "Could not read notification state.";
  }

  if (!state.loading) {
    render();
  }

  return state.push;
}

async function enablePushAlerts(profile = state.deviceProfile, accessPin = "") {
  if (!supportsPushNotifications()) {
    throw new Error("This browser does not support push alerts.");
  }

  if (Notification.permission === "denied") {
    throw new Error("Notification access is turned off for this site.");
  }

  state.push.busy = true;
  render();
  let pushError = null;

  try {
    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      throw new Error("Notification permission was not granted.");
    }

    const [{ publicKey }, registration] = await Promise.all([
      requestJson("/api/push/config"),
      navigator.serviceWorker.ready
    ]);

    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }

    await requestJson("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({
        subscription: typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription,
        deviceId: profile.deviceId,
        label: profile.employeeName || profile.label,
        browser: browserNameFromUserAgent(),
        platform: platformNameFromUserAgent(),
        userAgent: navigator.userAgent,
        accessPin: String(accessPin || "").trim(),
        createdAt: profile.updatedAt || nowIso(),
        updatedAt: nowIso()
      })
    });

    state.push.permission = permission;
    state.push.subscribed = true;
    state.push.ready = true;
    state.push.error = "";
    setMessage("Subscribed this device to push alerts.", "success");
  } catch (error) {
    pushError = error instanceof Error ? error : new Error("Could not subscribe this device.");
    state.push.error = formatPushError(pushError, "Could not subscribe this device.");
    throw pushError;
  } finally {
    state.push.busy = false;
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
      setMessage("No subscribed devices were available for the test push.", "warning");
    } else if (authorized <= 0) {
      setMessage("No devices are authorized under the current access PIN.", "warning");
    } else if (skipped > 0 && removed > 0) {
      setMessage(
        `Test push sent to ${delivered}/${authorized} authorized device${authorized === 1 ? "" : "s"}; ${skipped} device${skipped === 1 ? "" : "s"} are not enrolled under the current PIN and ${removed} stale subscription${removed === 1 ? "" : "s"} were removed.`,
        "success"
      );
    } else if (skipped > 0) {
      setMessage(
        `Test push sent to ${delivered}/${authorized} authorized device${authorized === 1 ? "" : "s"}; ${skipped} device${skipped === 1 ? "" : "s"} are not enrolled under the current PIN.`,
        "success"
      );
    } else if (removed > 0) {
      setMessage(
        `Test push sent to ${delivered}/${authorized} authorized device${authorized === 1 ? "" : "s"}; ${removed} stale subscription${removed === 1 ? "" : "s"} removed.`,
        "success"
      );
    } else {
      setMessage(`Test push sent to ${delivered}/${authorized} authorized device${authorized === 1 ? "" : "s"}.`, "success");
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

async function issueAccessPin() {
  state.push.busy = true;
  render();
  let accessPinError = null;

  try {
    const result = await requestJson("/api/push/pin", {
      method: "POST",
      body: JSON.stringify({})
    });

    state.webmaster.accessPin = {
      pin: String(result.pin || ""),
      version: Number(result.version || 0),
      updatedAt: String(result.updatedAt || nowIso())
    };

    await loadPushStatus();
    setMessage(`Generated access PIN ${state.webmaster.accessPin.pin}.`, "success");
  } catch (error) {
    accessPinError = error instanceof Error ? error : new Error("Could not generate an access PIN.");
    setMessage(formatPushError(accessPinError, "Could not generate an access PIN."));
    throw accessPinError;
  } finally {
    state.push.busy = false;
    render();
    clearMessageSoon();
  }
}

async function disableAccessPin() {
  state.push.busy = true;
  render();
  let accessPinError = null;

  try {
    await requestJson("/api/push/pin", {
      method: "DELETE"
    });

    state.webmaster.accessPin = null;
    await loadPushStatus();
    setMessage("Disabled the access PIN. New subscriptions are open again.", "success");
  } catch (error) {
    accessPinError = error instanceof Error ? error : new Error("Could not disable the access PIN.");
    setMessage(formatPushError(accessPinError, "Could not disable the access PIN."));
    throw accessPinError;
  } finally {
    state.push.busy = false;
    render();
    clearMessageSoon();
  }
}

async function copyAccessPin() {
  const pin = String(state.webmaster.accessPin?.pin || "").trim();

  if (!pin) {
    setMessage("Generate an access PIN first.", "warning");
    render();
    clearMessageSoon();
    return;
  }

  const copied = await copyText(pin);
  setMessage(copied ? "Copied the access PIN." : "Could not copy the access PIN.");
  render();
  clearMessageSoon();
}

async function unlockHrPage(pin) {
  state.access.hr.busy = true;
  state.access.hr.error = "";
  render();

  let hrError = null;

  try {
    const result = await requestJson("/api/hr/unlock", {
      method: "POST",
      body: JSON.stringify({
        pin: String(pin || "").trim()
      })
    });

    state.access.hr.authorized = Boolean(result.authorized);
    state.access.hr.pinRequired = Boolean(result.pinRequired);
    state.access.hr.pinVersion = Number(result.pinVersion || 0);
    state.access.hr.pinUpdatedAt = String(result.pinUpdatedAt || "");
    state.access.hr.sessionExpiresAt = String(result.sessionExpiresAt || "");
    state.access.hr.csrfToken = String(result.csrfToken || "");
    state.access.hr.credentialManaged = Boolean(result.credentialManaged);
    await hydrateRoute();
    setMessage("HR unlocked on this browser.", "success");
  } catch (error) {
    hrError = error instanceof Error ? error : new Error("Could not unlock HR.");
    state.access.hr.error = hrError.message || "Could not unlock HR.";
    throw hrError;
  } finally {
    state.access.hr.busy = false;
    if (hrError) {
      state.access.hr.error = hrError.message || "Could not unlock HR.";
    }
    render();
    clearMessageSoon();
  }
}

async function lockHrAccessSession() {
  state.access.hr.busy = true;
  render();

  let hrError = null;

  try {
    const result = await requestJson("/api/hr/lock", {
      method: "POST",
      body: JSON.stringify({})
    });

    state.access.hr.authorized = Boolean(result.authorized);
    state.access.hr.sessionExpiresAt = "";
    state.access.hr.csrfToken = "";
    await loadHrAccessStatus();
    setMessage("Locked the HR session on this browser.", "success");
  } catch (error) {
    hrError = error instanceof Error ? error : new Error("Could not lock HR.");
    state.access.hr.error = hrError.message || "Could not lock HR.";
    throw hrError;
  } finally {
    state.access.hr.busy = false;
    if (hrError) {
      state.access.hr.error = hrError.message || "Could not lock HR.";
    }
    render();
    clearMessageSoon();
  }
}

async function issueHrAccessPin() {
  if (state.access.hr?.credentialManaged) {
    setMessage("HR access is managed by environment variables in this deployment.", "warning");
    render();
    clearMessageSoon();
    return;
  }

  state.access.hr.busy = true;
  state.access.hr.error = "";
  render();

  let hrError = null;

  try {
    const result = await requestJson("/api/hr/pin", {
      method: "POST",
      body: JSON.stringify({})
    });

    state.hrAccessPin = {
      pin: String(result.pin || ""),
      version: Number(result.version || 0),
      updatedAt: String(result.updatedAt || nowIso())
    };

    state.access.hr.pinVersion = Number(result.version || 0);
    state.access.hr.pinUpdatedAt = String(result.updatedAt || nowIso());
    state.access.hr.pinRequired = true;
    setMessage(`Generated HR PIN ${state.hrAccessPin.pin}.`, "success");
  } catch (error) {
    hrError = error instanceof Error ? error : new Error("Could not generate the HR PIN.");
    state.access.hr.error = hrError.message || "Could not generate the HR PIN.";
    throw hrError;
  } finally {
    state.access.hr.busy = false;
    if (hrError) {
      state.access.hr.error = hrError.message || "Could not generate the HR PIN.";
    }
    render();
    clearMessageSoon();
  }
}

async function copyHrAccessPin() {
  const pin = String(state.hrAccessPin?.pin || "").trim();

  if (!pin) {
    setMessage("Generate an HR PIN first.", "warning");
    render();
    clearMessageSoon();
    return;
  }

  const copied = await copyText(pin);
  setMessage(copied ? "Copied the HR PIN." : "Could not copy the HR PIN.");
  render();
  clearMessageSoon();
}

async function approveWebmasterBrowser() {
  state.access.webmaster.busy = true;
  state.access.webmaster.error = "";
  render();

  let webmasterError = null;

  try {
    if (!state.access.hr?.csrfToken && state.access.webmaster?.hrAuthorized) {
      await loadHrAccessStatus();
    }

    const result = await requestJson("/api/webmaster/approve", {
      method: "POST",
      body: JSON.stringify({
        label: buildSuggestedDeviceLabel(),
        browser: browserNameFromUserAgent(),
        platform: platformNameFromUserAgent(),
        userAgent: navigator.userAgent
      })
    });

    state.access.webmaster.authorized = Boolean(result.authorized);
    state.access.webmaster.loaded = true;
    state.access.webmaster.hrAuthorized = Boolean(result.hrAuthorized ?? state.access.hr?.authorized);
    state.access.webmaster.browserBound = Boolean(result.browserBound ?? true);
    state.access.webmaster.approvedBrowser = normalizeApprovedBrowser(result.approvedBrowser) || state.access.webmaster.approvedBrowser;
    state.access.webmaster.sessionExpiresAt = String(result.sessionExpiresAt || "");
    state.access.webmaster.csrfToken = String(result.csrfToken || "");
    state.webmaster.loaded = true;
    const confirmedAccess = await waitForWebmasterAuthorization();

    if (confirmedAccess?.authorized) {
      state.access.webmaster.authorized = true;
      state.access.webmaster.hrAuthorized = Boolean(confirmedAccess.hrAuthorized);
      state.access.webmaster.browserBound = Boolean(confirmedAccess.browserBound ?? true);
      state.access.webmaster.approvedBrowser = normalizeApprovedBrowser(confirmedAccess.approvedBrowser) || state.access.webmaster.approvedBrowser;
      state.access.webmaster.sessionExpiresAt = String(confirmedAccess.sessionExpiresAt || state.access.webmaster.sessionExpiresAt || "");
      state.access.webmaster.csrfToken = String(confirmedAccess.csrfToken || state.access.webmaster.csrfToken || "");

      try {
        await refreshWebmasterData();
      } catch {
        // Keep the optimistic webmaster state if the summary call lags behind the cookie.
      }
    }

    setMessage("Approved this browser for webmaster access.", "success");
  } catch (error) {
    webmasterError = error instanceof Error ? error : new Error("Could not approve this browser.");
    state.access.webmaster.error = webmasterError.message || "Could not approve this browser.";
    throw webmasterError;
  } finally {
    state.access.webmaster.busy = false;
    if (webmasterError) {
      state.access.webmaster.error = webmasterError.message || "Could not approve this browser.";
    }
    render();
    clearMessageSoon();
  }
}

async function lockWebmasterBrowser() {
  state.access.webmaster.busy = true;
  render();

  let webmasterError = null;

  try {
    const result = await requestJson("/api/webmaster/lock", {
      method: "POST",
      body: JSON.stringify({})
    });

    state.access.webmaster.authorized = Boolean(result.authorized);
    state.access.webmaster.browserBound = Boolean(result.browserBound ?? false);
    state.access.webmaster.approvedBrowser = null;
    state.access.webmaster.sessionExpiresAt = "";
    state.access.webmaster.csrfToken = "";
    await loadWebmasterAccessStatus();
    setMessage("Revoked the webmaster browser.", "success");
  } catch (error) {
    webmasterError = error instanceof Error ? error : new Error("Could not revoke the webmaster browser.");
    state.access.webmaster.error = webmasterError.message || "Could not revoke the webmaster browser.";
    throw webmasterError;
  } finally {
    state.access.webmaster.busy = false;
    if (webmasterError) {
      state.access.webmaster.error = webmasterError.message || "Could not revoke the webmaster browser.";
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
}

function renderAlertControls() {
  if (state.push.busy) {
    return `
      <button class="button" type="button" disabled aria-disabled="true">${icon("refresh")} Updating...</button>
      <span class="status-chip muted">${icon("refresh")} Working...</span>
    `;
  }

  if (state.push.subscribed) {
    return `
      <button class="ghost-button" type="button" data-disable-alerts>${icon("bell")} Turn off this device</button>
      <span class="status-chip success">${icon("check")} Subscribed on this device</span>
    `;
  }

  const supported = supportsPushNotifications();
  const buttonLabel = "Subscribe this device";
  const helperText = !supported
    ? "Open the portal in a push-capable browser."
    : state.push.permission === "denied"
      ? "Notification access is turned off for this site."
      : "Receive urgent updates on this device.";

  return `
    <button class="button" type="button" data-enable-alerts>${icon("bell")} ${escapeHtml(buttonLabel)}</button>
    <span class="status-chip ${supported ? "muted" : "warning"}">${state.push.permission === "denied" ? icon("alert") : icon("lock")} ${escapeHtml(helperText)}</span>
  `;
}

function renderTestPushControl() {
  if (state.push.busy) {
    return `<span class="status-chip muted">${icon("refresh")} Sending test...</span>`;
  }

  return `<button class="ghost-button" type="button" data-send-test-push>${icon("send")} Send test push</button>`;
}

function renderDeviceChecklistItem(item) {
  return `
    <article class="device-setup-step ${item.complete ? "complete" : "missing"}">
      <div class="device-setup-step-head">
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.detail)}</p>
        </div>
        <span class="status-chip ${item.complete ? "muted" : "warning"}">${item.complete ? icon("check") : icon("alert")} ${escapeHtml(item.value)}</span>
      </div>
    </article>
  `;
}

function renderEmployeeSetupWizard() {
  const setup = buildEmployeeSetupState();
  const busy = setup.busy;
  const headlineTitle = setup.nextStep.title;
  const headlineDetail = `${pushSupportText()} ${setup.nextStep.detail}`.trim();
  const formNote = !setup.pushSupported
    ? (isIosDevice()
      ? "Open Safari, use Share -> Add to Home Screen, then reopen the installed app to enable push."
      : "Open the portal in a push-capable browser to subscribe this device.")
    : setup.pushPermission === "denied"
      ? "Enter the employee name, re-enable notifications in browser settings, then return here to subscribe."
      : setup.nextStep.action === "push"
        ? "Enter the employee name, then tap subscribe to finish setup on this device."
        : "Save the employee name to keep this device easy to identify.";
  const statusText = busy
    ? "Working..."
    : setup.ready
      ? "Ready"
      : !setup.pushSupported
        ? (isIosDevice() ? "Install required" : "No push support")
        : setup.pushPermission === "denied"
          ? "Push blocked"
          : setup.pinRequired && !setup.pushSubscribed
            ? "PIN required"
          : setup.nextStep.action === "push"
            ? "Subscribe"
            : "Web push";

  const titleMarkup = `
    <div class="employee-setup-summary-copy">
      <p class="eyebrow">${icon("bell")} Device setup</p>
      <h2>${escapeHtml(headlineTitle)}</h2>
      <p>${escapeHtml(headlineDetail)}</p>
    </div>
  `;

  const bodyContent = `
    <form class="device-setup-form" data-device-setup-form>
      <div class="device-setup-grid">
        <label class="field full">
          <span>Employee name</span>
          <input name="employeeName" maxlength="80" required value="${escapeHtml(setup.employeeName)}" placeholder="e.g. Maria Lopez" autocomplete="off" autocapitalize="words" spellcheck="false" data-employee-name-field>
        </label>
        ${
          setup.pinRequired
            ? `
              <label class="field full">
                <span>Access PIN</span>
                <input name="accessPin" maxlength="16" required inputmode="numeric" autocomplete="one-time-code" placeholder="1234-5678" spellcheck="false" data-access-pin-field>
              </label>
            `
            : ""
        }
      </div>

      <div class="device-setup-actions">
        <button class="button" type="submit" data-device-action="${escapeHtml(setup.primaryAction.id)}" ${busy ? "disabled aria-disabled=\"true\"" : ""}>
          ${icon(setup.primaryAction.icon)} ${escapeHtml(setup.primaryAction.label)}
        </button>
      </div>

      <p class="form-note">${escapeHtml(formNote)}</p>
    </form>

    <div class="device-setup-checklist" aria-label="Device setup checklist">
      ${setup.checklist.map((item) => renderDeviceChecklistItem(item)).join("")}
    </div>

    ${state.push.error ? `<p class="panel-copy employee-alert-error">${escapeHtml(state.push.error)}</p>` : ""}
  `;

  if (setup.ready) {
    return `
      <details class="tool-panel panel-card employee-setup-panel employee-setup-dropdown" data-employee-setup-dropdown ${state.employeeSetupOpen ? "open" : ""}>
        <summary class="employee-setup-summary" data-employee-setup-summary>
          ${titleMarkup}
          <div class="employee-setup-summary-meta">
            <span class="sync-pill">${escapeHtml(statusText)}</span>
            <span class="employee-setup-summary-caret" aria-hidden="true"></span>
          </div>
        </summary>

        <div class="employee-setup-body">
          ${bodyContent}
        </div>
      </details>
    `;
  }

  return `
    <section class="tool-panel panel-card employee-setup-panel">
      <div class="panel-title panel-title-wide">
        ${titleMarkup}
        <span class="sync-pill">${escapeHtml(statusText)}</span>
      </div>
      ${bodyContent}
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

function renderAdminPushActions() {
  return `
    <div class="employee-alert-actions admin-alert-actions">
      ${renderAlertControls()}
      ${renderTestPushControl()}
    </div>
  `;
}

function hasLegacyWeatherSnapshot(weather) {
  return Boolean(
    weather &&
      !weather.location &&
      !weather.resolvedName &&
      (weather.condition !== "Weather not configured" ||
        weather.temperature !== "--" ||
        weather.impact !== "Enter a location in HR to fetch live weather.")
  );
}

function weatherDisplayName(weather) {
  if (weather.resolvedName || weather.location) {
    return weather.resolvedName || weather.location;
  }

  return hasLegacyWeatherSnapshot(weather) ? "Stored weather snapshot" : "Weather not configured";
}

function weatherHeadline(weather) {
  const condition = String(weather?.condition || "Weather not configured").trim();
  const temperature = String(weather?.temperature || "").trim();
  if (!temperature || temperature === "--") return condition;
  return `${condition} - ${temperature}`;
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
    HR: "users",
    News: "news",
    Safety: "shield",
    Shift: "board",
    Weather: "cloud"
  }[type] || "bell";
}

function visiblePosts() {
  return state.posts
    .filter((post) => !isExpired(post))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function filteredEmployeePosts() {
  const query = String(employeeFeedSearch || "").trim().toLowerCase();
  const filter = String(employeeFeedFilter || "All");

  return visiblePosts().filter((post) => {
    const matchesFilter = filter === "All"
      ? true
      : String(post.priority || "") === filter || String(post.type || "") === filter;

    if (!matchesFilter) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      post.title,
      post.body,
      post.type,
      post.priority,
      post.audience
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

function historyPosts() {
  return [...state.posts]
    .filter((post) => {
      if (activeHistoryFilter === "All") return true;
      if (activeHistoryFilter === "Urgent") return post.priority === "Urgent";
      return post.type === activeHistoryFilter;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderNotice(post, includeControls = false) {
  const safePriority = priorityClass(post.priority);

  return `
    <article class="notice-card priority-${safePriority}">
      <div class="notice-meta">
        <span class="notice-type">${icon(typeIcon(post.type))}${escapeHtml(post.type)}</span>
        <span class="priority-pill ${safePriority}">${escapeHtml(post.priority)}</span>
        ${post.notifyEmployees ? `<span class="sync-pill">${icon("bell")} Alert sent</span>` : ""}
        <span class="notice-date">${escapeHtml(formatDate(post.createdAt))}</span>
      </div>
      <h2>${escapeHtml(post.title)}</h2>
      <p>${escapeHtml(post.body)}</p>
      <div class="notice-footer">
        <span>${escapeHtml(post.audience || "All employees")}</span>
        <span>Expires: ${escapeHtml(formatDate(post.expiresAt))}</span>
      </div>
      ${
        includeControls
          ? `<form class="post-controls" data-delete-post-form>
              <input type="hidden" name="id" value="${escapeHtml(post.id)}">
              <button class="ghost-button" type="submit" data-delete-post="${escapeHtml(post.id)}" title="Delete post">
                ${icon("delete")} Delete
              </button>
            </form>`
          : ""
      }
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
      <div class="feed-avatar priority-${safePriority}" aria-hidden="true">
        ${icon(typeIcon(post.type))}
      </div>
      <div class="feed-main">
        <div class="feed-head">
          <div class="feed-head-copy">
            <strong>${escapeHtml(feedTitle)}</strong>
            <span class="feed-type">${escapeHtml(feedType)}</span>
          </div>
          <time class="feed-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(feedTime)}</time>
        </div>
        <div class="feed-badges">
          <span class="priority-pill ${safePriority}">${escapeHtml(feedPriority)}</span>
          ${post.notifyEmployees ? `<span class="sync-pill">${icon("bell")} Alert sent</span>` : ""}
        </div>
        <p class="feed-body">${escapeHtml(feedBody)}</p>
      </div>
    </article>
  `;
}

function renderEmployeeFeedToolbar(totalCount, visibleCount) {
  const search = String(employeeFeedSearch || "");
  const filter = String(employeeFeedFilter || "All");
  const active = Boolean(search.trim() || filter !== "All");

  return `
    <div class="feed-toolbar" role="search" aria-label="Filter and search employee updates">
      <label class="field inline feed-search-field">
        <span>${icon("search")} Search</span>
        <input
          type="search"
          name="feed-search"
          value="${escapeHtml(search)}"
          placeholder="Search titles, text, or type"
          data-employee-feed-search
        >
      </label>

      <label class="field inline feed-filter-field">
        <span>${icon("filter")} Filter</span>
        <select name="feed-filter" data-employee-feed-filter>
          ${employeeFeedFilters
            .map(
              (option) => `
                <option value="${escapeHtml(option)}" ${option === filter ? "selected" : ""}>
                  ${escapeHtml(option)}
                </option>
              `
            )
            .join("")}
        </select>
      </label>

      <div class="feed-toolbar-meta">
        <span class="sync-pill">${escapeHtml(active ? `${visibleCount} of ${totalCount}` : `${totalCount}`)} updates</span>
        ${active ? '<button class="ghost-button feed-toolbar-clear" type="button" data-clear-employee-feed-filters>Clear</button>' : ""}
      </div>
    </div>
  `;
}

function renderEmployeeSharePanel() {
  const employeeLink = `${window.location.origin}${routePath("employee")}`;

  return `
    <section class="tool-panel panel-card access-card">
      <div class="panel-title">
        <div>
          <p class="eyebrow">${icon("users")} Employee access</p>
          <h2>Scan to open the portal</h2>
          <p>Workers can scan this code to open the read-only portal on their phone.</p>
        </div>
      </div>
      <div class="qr-panel compact">
        <div class="qr-box">
          <img src="/employee-qr.svg" alt="QR code for employee portal">
        </div>
        <a class="employee-link" href="${escapeHtml(routePath("employee"))}">${escapeHtml(employeeLink)}</a>
      </div>
    </section>
  `;
}

function renderAdminPushPanel() {
  const subscriptions = Number(state.pushStatus.subscriptions || 0);
  const activeSubscriptions = Number(state.pushStatus.authorizedSubscriptions ?? subscriptions);
  const inactiveSubscriptions = Number(state.pushStatus.inactiveSubscriptions || 0);
  const loaded = Boolean(state.pushStatus.loaded);
  const readyCopy = state.pushStatus.supported
    ? "Push delivery is ready."
    : "Push delivery is unavailable on this server.";
  const pinRequired = Boolean(state.pushStatus.pinRequired);

  return `
    <section class="tool-panel push-panel panel-card">
      <div class="panel-title">
        <div>
          <p class="eyebrow">${icon("bell")} Alert delivery</p>
          <h2>${escapeHtml(loaded ? `${activeSubscriptions} active device${activeSubscriptions === 1 ? "" : "s"}` : "Loading alert status")}</h2>
          <p>${escapeHtml(readyCopy)} Employees enable alerts once on each device, then urgent updates can reach everyone at once.${inactiveSubscriptions ? ` ${inactiveSubscriptions} inactive device${inactiveSubscriptions === 1 ? "" : "s"} need the current PIN or an unsubscribe.` : ""}</p>
        </div>
      </div>
      <div class="push-metrics">
        <div class="push-metric">
          <strong>${escapeHtml(loaded ? String(activeSubscriptions) : "…")}</strong>
          <span>Active devices</span>
        </div>
        <div class="push-metric">
          <strong>${escapeHtml(state.pushStatus.supported ? "Ready" : "Off")}</strong>
          <span>Push status</span>
        </div>
        <div class="push-metric">
          <strong>${escapeHtml(pinRequired ? "On" : "Open")}</strong>
          <span>Access PIN</span>
        </div>
      </div>
      ${renderAdminPushActions()}
    </section>
  `;
}

function renderAccessPinPanel() {
  const pinRequired = Boolean(state.pushStatus.pinRequired);
  const pin = state.webmaster.accessPin?.pin || "";
  const pinVersion = Number(state.pushStatus.pinVersion || state.webmaster.accessPin?.version || 0);
  const updatedAt = state.webmaster.accessPin?.updatedAt || state.pushStatus.pinUpdatedAt || "";
  const activeDevices = Number(state.pushStatus.authorizedSubscriptions ?? (Array.isArray(state.pushStatus.devices) ? state.pushStatus.devices.filter((device) => device.authorized !== false).length : 0));
  const busy = Boolean(state.push.busy);
  const pinLabel = pin
    ? "Current PIN"
    : pinRequired
      ? "PIN active"
      : "No PIN generated yet";
  const pinValue = pin
    ? pin
    : pinRequired
      ? "Generate a new PIN to reveal the code"
      : "Generate a PIN to reveal the code";
  const pinNote = updatedAt
    ? `Last updated ${formatDate(updatedAt)}`
    : pinRequired
      ? "The current code is active but not visible until you issue a new one."
      : "Use the button below to issue a new code.";

  return `
    <section class="panel-card">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("lock")} Access control</p>
          <h3>Enrollment PIN</h3>
          <p>${escapeHtml(pinRequired ? "Devices must enroll with the current PIN before they can receive alerts." : "Open enrollment is active. Generate a PIN when you want to lock down new device access.")}</p>
        </div>
        <span class="sync-pill">${escapeHtml(pinRequired ? "PIN required" : "Open enrollment")}</span>
      </div>

      <div class="push-metrics">
        <div class="push-metric">
          <strong>${escapeHtml(pinRequired ? `v${pinVersion || 1}` : "Off")}</strong>
          <span>PIN version</span>
        </div>
        <div class="push-metric">
          <strong>${escapeHtml(String(activeDevices))}</strong>
          <span>Authorized devices</span>
        </div>
      </div>

      <div class="access-pin-display ${pin ? "has-pin" : "empty"}">
        <span>${escapeHtml(pinLabel)}</span>
        <strong>${escapeHtml(pinValue)}</strong>
        <small>${escapeHtml(pinNote)}</small>
      </div>

      <div class="employee-alert-actions admin-alert-actions">
        <button class="button" type="button" data-issue-access-pin ${busy ? "disabled aria-disabled=\"true\"" : ""}>${icon("lock")} ${escapeHtml(pinRequired ? "Rotate access PIN" : "Generate access PIN")}</button>
        ${pinRequired ? `<button class="ghost-button" type="button" data-disable-access-pin ${busy ? "disabled aria-disabled=\"true\"" : ""}>${icon("check")} Disable PIN</button>` : ""}
        ${pin ? `<button class="ghost-button" type="button" data-copy-access-pin ${busy ? "disabled aria-disabled=\"true\"" : ""}>${icon("clipboard")} Copy PIN</button>` : ""}
      </div>

      <p class="panel-copy">Rotating the PIN invalidates the old code for future subscriptions. Devices already enrolled under a previous PIN must resubscribe with the new one.</p>
    </section>
  `;
}

function renderEmployee() {
  const notices = filteredEmployeePosts();
  const totalNotices = visiblePosts().length;

  return `
    <main class="page-shell employee-shell">
      <header class="page-head">
        ${brandBlock()}
        <div class="page-actions">
          <span class="sync-pill">${icon("news")} Latest feed</span>
        </div>
      </header>

      ${state.message ? `<div class="employee-banner ${escapeHtml(state.messageType)}">${escapeHtml(state.message)}</div>` : ""}

      <section class="feed-shell" aria-label="Latest updates feed">
        <div class="feed-intro">
          <div>
            <p class="eyebrow">${icon("news")} Latest updates</p>
            <h2>Latest from the portal</h2>
            <p>Newest posts stay up top. Scroll down for the full feed.</p>
          </div>
        </div>

        ${renderEmployeeFeedToolbar(totalNotices, notices.length)}

        <div class="feed-list">
          ${
            notices.length
              ? notices.map((post) => renderFeedItem(post)).join("")
              : `<div class="empty-state">No updates match your search or filter.</div>`
          }
        </div>
      </section>

      ${renderEmployeeSetupWizard()}
    </main>
  `;
}

function renderLauncherCard(route, title, description, note, iconName) {
  return `
    <a class="launch-card" href="${escapeHtml(routePath(route))}" data-route="${escapeHtml(route)}">
      <div class="launch-card-icon" aria-hidden="true">${icon(iconName)}</div>
      <div class="launch-card-copy">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(description)}</span>
      </div>
      <div class="launch-card-note">${escapeHtml(note)}</div>
    </a>
  `;
}

function renderLauncher() {
  return `
    <main class="page-shell launcher-shell">
      <header class="page-head launcher-head">
        ${brandBlock("Portal home")}
        <div class="page-actions">
          <span class="sync-pill">${icon("home")} Start here</span>
        </div>
      </header>

      <section class="launcher-panel panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("refresh")} Palziv Alerts</p>
            <h2>Choose your section</h2>
            <p>Read updates, publish notices, or review site health from one branded entry point.</p>
          </div>
        </div>

        <div class="launcher-grid">
          ${renderLauncherCard("employee", "Read updates", "Open the company feed for the latest notices and alerts.", "Read only", "news")}
          ${renderLauncherCard("hr", "Publish notices", "Go to HR to post updates, weather, and alerts.", "Publishing", "users")}
          ${renderLauncherCard("webmaster", "Review site health", "Open analytics, devices, and system status.", "Monitoring", "chart")}
        </div>
      </section>
    </main>
  `;
}

function renderAdminPublishPanel() {
  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("megaphone")} Publish</p>
          <h2>New update</h2>
          <p>Use the dropdowns to keep publishing focused and send the right update to the right group.</p>
        </div>
        <span class="sync-pill">Live server</span>
      </div>
      <section class="tool-panel composer-panel panel-card">
        <form data-post-form>
          <div class="composer-grid">
            <label class="field field-span-2">
              <span>Title</span>
              <input name="title" maxlength="90" required placeholder="Short headline">
            </label>
            <label class="field field-span-2">
              <span>Message</span>
              <textarea name="body" maxlength="700" required placeholder="What employees need to know"></textarea>
            </label>
            <label class="field">
              <span>Category</span>
              <select name="type">
                <option>News</option>
                <option>Weather</option>
                <option>Shift</option>
                <option>Safety</option>
                <option>HR</option>
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
              <input name="audience" maxlength="80" value="All employees">
            </label>
            <label class="field">
              <span>Expires</span>
              <input name="expiresAt" type="date">
            </label>
          </div>
          <label class="checkbox-row">
            <input type="checkbox" name="notifyEmployees">
            <span>Send a push alert to subscribed employees</span>
          </label>
          <p class="form-note">Important and urgent updates notify employees automatically. Use the checkbox for routine updates you still want to broadcast.</p>
          <div class="form-actions">
            <button class="button" type="submit">${icon("send")} Publish</button>
          </div>
        </form>
      </section>
    </section>
  `;
}

function renderAdminWeatherPanel(weather, weatherLocation) {
  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("cloud")} Weather</p>
          <h2>Live site weather</h2>
          <p>Support data stays on its own tab so publishing stays focused.</p>
        </div>
      </div>
      <section class="tool-panel panel-card">
        <form data-weather-form>
          <div class="form-grid">
            <label class="field full">
              <span>Location</span>
              <input name="location" maxlength="120" value="${escapeHtml(weather.location || weather.resolvedName || "")}" required placeholder="City, state, ZIP, or address">
            </label>
          </div>
          <div class="form-actions">
            <button class="button secondary" type="submit">${icon("refresh")} Refresh weather</button>
          </div>
        </form>
        <div class="weather-preview" aria-label="Live weather preview">
          <div class="weather-preview-head">
            <div>
              <p class="eyebrow">${icon("cloud")} Live result</p>
              <h3>${escapeHtml(weatherLocation)}</h3>
            </div>
            <span class="weather-level ${escapeHtml(String(weather.level || "Clear").toLowerCase())}">${escapeHtml(weather.level || "Clear")}</span>
          </div>
          <div class="weather-preview-grid">
            <div class="weather-preview-item">
              <span>Condition</span>
              <strong>${escapeHtml(weather.condition)}</strong>
            </div>
            <div class="weather-preview-item">
              <span>Temperature</span>
              <strong>${escapeHtml(weather.temperature)}</strong>
            </div>
            <div class="weather-preview-item full">
              <span>Impact</span>
              <strong>${escapeHtml(weather.impact)}</strong>
            </div>
            <div class="weather-preview-item">
              <span>Updated</span>
              <strong>${escapeHtml(formatWeatherUpdatedAt(weather.updatedAt))}</strong>
            </div>
          </div>
        </div>
      </section>
    </section>
  `;
}

function renderAdminAlertsPanel() {
  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("bell")} Alert delivery</p>
          <h2>Delivery status</h2>
          <p>Keep alert delivery simple: subscribe the device to push, then use test push to verify it receives alerts immediately.</p>
        </div>
      </div>
      ${renderAdminPushPanel()}
      <div class="panel-card">
        <p class="panel-copy">Important and urgent updates notify employees automatically through web push. Devices that subscribe here can receive alerts without any paid messaging service.</p>
      </div>
    </section>
  `;
}

function renderAdminHistoryPanel() {
  const notices = historyPosts();

  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("board")} Update history</p>
          <h2>Published updates</h2>
          <p>Narrow the feed with a dropdown before deleting or reviewing older updates.</p>
        </div>
        <div class="panel-toolbar">
          ${renderFilterSelect({
            name: "history-filter",
            label: "History filter",
            value: activeHistoryFilter,
            options: historyFilters
          })}
        </div>
      </div>
      <div class="post-list">
        ${
          notices.length
            ? notices.map((post) => renderNotice(post, true)).join("")
            : '<div class="empty-state">No updates yet.</div>'
        }
      </div>
    </section>
  `;
}

function renderAdminAccessPanel() {
  const hrAccess = state.access.hr || {};
  const webmasterAccess = state.access.webmaster || {};
  const hrCredentialManaged = Boolean(hrAccess.credentialManaged);
  const hrPin = String(state.hrAccessPin?.pin || "");
  const hrPinVersion = Number(hrAccess.pinVersion || state.hrAccessPin?.version || 0);
  const hrUpdatedAt = state.hrAccessPin?.updatedAt || hrAccess.pinUpdatedAt || "";
  const approvedBrowser = webmasterAccess.approvedBrowser || null;
  const approvedBrowserLabel = approvedBrowser
    ? approvedBrowser.label || [approvedBrowser.platform, approvedBrowser.browser].filter(Boolean).join(" ").trim()
    : "";
  const approvedBrowserDetail = approvedBrowser
    ? [approvedBrowser.platform, approvedBrowser.browser, approvedBrowser.updatedAt ? `approved ${formatDate(approvedBrowser.updatedAt)}` : ""]
        .filter(Boolean)
        .join(" · ")
    : "";

  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("lock")} Access control</p>
          <h2>Control who gets in</h2>
          <p>HR uses a PIN. Webmaster is locked to one approved browser.</p>
        </div>
        <span class="sync-pill">${escapeHtml(hrAccess.authorized ? "HR unlocked" : "HR locked")}</span>
      </div>

      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("users")} HR page</p>
            <h3>HR access PIN</h3>
            <p>${escapeHtml(hrCredentialManaged ? "This deployment uses an environment-managed admin credential." : "Rotate this PIN whenever you want to lock out old HR sessions.")}</p>
          </div>
          <span class="sync-pill">${escapeHtml(hrAccess.pinRequired ? `v${hrPinVersion || 1}` : "Open")}</span>
        </div>

        <div class="access-pin-display ${hrPin ? "has-pin" : "empty"}">
          <span>${escapeHtml(hrCredentialManaged ? "Managed credential" : hrPin ? "Current HR PIN" : "Generate a PIN")}</span>
          <strong>${escapeHtml(hrCredentialManaged ? "Set in environment variables" : hrPin ? hrPin : "Generate a new PIN to reveal the code")}</strong>
          <small>${escapeHtml(
            hrCredentialManaged
              ? "Update ADMIN_PASSWORD or HR_PIN on the server to change HR access."
              : hrUpdatedAt
                ? `Last updated ${formatDate(hrUpdatedAt)}`
                : "The current PIN is hidden until you issue a new one."
          )}</small>
        </div>

        <div class="employee-alert-actions admin-alert-actions">
          <button class="button" type="button" data-issue-hr-pin ${hrAccess.busy || hrCredentialManaged ? "disabled aria-disabled=\"true\"" : ""}>${icon("lock")} ${escapeHtml(hrCredentialManaged ? "Managed in environment" : hrPin ? "Rotate HR PIN" : "Generate HR PIN")}</button>
          ${hrPin ? `<button class="ghost-button" type="button" data-copy-hr-pin ${hrAccess.busy ? "disabled aria-disabled=\"true\"" : ""}>${icon("clipboard")} Copy HR PIN</button>` : ""}
          <button class="ghost-button" type="button" data-lock-hr-session ${hrAccess.busy ? "disabled aria-disabled=\"true\"" : ""}>${icon("check")} Lock HR session</button>
        </div>

        <p class="panel-copy">${escapeHtml(
          hrCredentialManaged
            ? "HR access is controlled by the server environment. Browser rotation is disabled for this deployment."
            : "The HR page stays locked until the current PIN is entered. Rotating it invalidates older browser sessions."
        )}</p>
      </section>
      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("shield")} Webmaster access</p>
            <h3>Approve this browser</h3>
            <p>Only the approved browser can open the webmaster page. Websites cannot read MAC addresses, so approval is stored as a signed browser cookie.</p>
          </div>
          <span class="sync-pill">${escapeHtml(webmasterAccess.authorized ? "Approved" : "Locked")}</span>
        </div>

        <div class="access-pin-display ${approvedBrowser ? "has-pin" : "empty"}">
          <span>${escapeHtml(approvedBrowser ? "Approved browser" : "No browser approved")}</span>
          <strong>${escapeHtml(approvedBrowserLabel || "Approve this browser")}</strong>
          <small>${escapeHtml(approvedBrowserDetail || (hrAccess.authorized ? "This browser can be approved now." : "Unlock HR first in the browser you want to use for webmaster access."))}</small>
        </div>

        <div class="employee-alert-actions admin-alert-actions">
          <button class="button" type="button" data-approve-webmaster-browser ${webmasterAccess.busy || !hrAccess.authorized ? "disabled aria-disabled=\"true\"" : ""}>${icon("shield")} Approve this browser</button>
          <button class="ghost-button" type="button" data-lock-webmaster-browser ${webmasterAccess.busy ? "disabled aria-disabled=\"true\"" : ""}>${icon("delete")} Revoke browser</button>
        </div>

        <p class="panel-copy">Webmaster approval is browser-bound because websites cannot read MAC addresses. Revoke it here any time you want to force a new approval.</p>
      </section>

      ${renderEmployeeSharePanel()}
    </section>
  `;
}

function renderHrLockScreen() {
  const hrAccess = state.access.hr || {};
  const pinError = hrAccess.error ? `<p class="employee-alert-error">${escapeHtml(hrAccess.error)}</p>` : "";

  return `
    <main class="auth-shell">
      <section class="panel-card auth-gate-card">
        ${brandBlock("HR access required")}
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("lock")} Locked page</p>
            <h2>Unlock the HR console</h2>
            <p>Enter the HR PIN to publish updates, manage weather, and control alerts.</p>
          </div>
          <span class="sync-pill">${escapeHtml(hrAccess.pinRequired ? "PIN required" : "Open")}</span>
        </div>

        <form class="auth-form" data-hr-unlock-form>
          <label class="field full">
            <span>HR PIN</span>
            <input
              name="pin"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="16"
              required
              placeholder="1234-5678"
              data-hr-pin-field
            >
          </label>

          <div class="auth-form-actions">
            <button class="button" type="submit" ${hrAccess.busy ? "disabled aria-disabled=\"true\"" : ""}>${icon("lock")} Unlock HR</button>
            <button class="ghost-button" type="button" data-route="launcher">${icon("home")} Launcher</button>
          </div>

          <p class="form-note">Web apps cannot read MAC addresses. HR access is protected by a signed browser cookie after the correct PIN is entered.</p>
          ${pinError}
        </form>
      </section>
    </main>
  `;
}

function renderWebmasterLockScreen() {
  const webmasterAccess = state.access.webmaster || {};
  const approvedBrowser = webmasterAccess.approvedBrowser || null;
  const approvedBrowserLabel = approvedBrowser
    ? approvedBrowser.label || [approvedBrowser.platform, approvedBrowser.browser].filter(Boolean).join(" ").trim()
    : "";
  const approvedBrowserDetail = approvedBrowser
    ? [approvedBrowser.platform, approvedBrowser.browser, approvedBrowser.updatedAt ? `approved ${formatDate(approvedBrowser.updatedAt)}` : ""]
        .filter(Boolean)
        .join(" · ")
    : "";
  const approvalNote = webmasterAccess.hrAuthorized
    ? "HR is unlocked in this browser. Approve it once and the webmaster page will stay open here until you revoke it."
    : "Unlock HR in the browser you want to use first, then approve this browser for webmaster access.";
  const actionButton = webmasterAccess.hrAuthorized
    ? `<button class="button" type="button" data-approve-webmaster-browser ${webmasterAccess.busy ? "disabled aria-disabled=\"true\"" : ""}>${icon("shield")} Approve this browser</button>`
    : `<button class="button" type="button" data-route="hr">${icon("users")} Open HR</button>`;

  return `
    <main class="auth-shell">
      <section class="panel-card auth-gate-card">
        ${brandBlock("Webmaster access required")}
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("shield")} Browser locked</p>
            <h2>Approve this browser</h2>
            <p>Webmaster access is bound to one approved browser. The browser is locked until HR approves it.</p>
          </div>
          <span class="sync-pill">${escapeHtml(webmasterAccess.authorized ? "Approved" : "Locked")}</span>
        </div>

        <div class="access-pin-display ${approvedBrowser ? "has-pin" : "empty"}">
          <span>${escapeHtml(approvedBrowser ? "Approved browser" : "No browser approved")}</span>
          <strong>${escapeHtml(approvedBrowserLabel || "Approve this browser")}</strong>
          <small>${escapeHtml(approvedBrowserDetail || approvalNote)}</small>
        </div>

        <div class="auth-form-actions">
          ${actionButton}
          <button class="ghost-button" type="button" data-route="launcher">${icon("home")} Launcher</button>
        </div>

        <p class="form-note">MAC addresses are not exposed to websites. This lock is enforced with a signed cookie on the approved browser.</p>
        ${webmasterAccess.error ? `<p class="employee-alert-error">${escapeHtml(webmasterAccess.error)}</p>` : ""}
      </section>
    </main>
  `;
}

function renderWebmasterOverviewPanel() {
  const snapshot = buildWebmasterSnapshot();
  const board = snapshot.board || {};
  const notifications = snapshot.notifications || {};
  const security = snapshot.security || {};
  const urls = snapshot.urls || {};
  const server = snapshot.server || {};
  const probes = state.webmaster.probes || {};

  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("chart")} Power center</p>
          <h2>Webmaster overview</h2>
          <p>Quick status for the site, the host, and the copy-ready brief.</p>
        </div>
        <span class="sync-pill">${icon("check")} Live snapshot</span>
      </div>

      <section class="panel-card">
        ${renderKeyValueGrid([
          ["Generated", formatDate(snapshot.generatedAt), "Snapshot time"],
          ["Launcher URL", urls.base || `${window.location.origin}${appPath()}`, "Canonical entry point"],
          ["HR route", urls.hr || `${window.location.origin}${routePath("hr")}`, "Publish console"],
          ["Employee route", urls.employee || `${window.location.origin}${routePath("employee")}`, "Read-only feed"],
          ["Latest update", board.latestPost ? board.latestPost.title : "None", board.latestPost ? formatDate(board.latestPost.createdAt) : "No posts yet"],
          ["Push subs", String(notifications.pushSubscriptions || 0), "Web push enrollments"],
          ["HR pin", security.hrPin?.enabled ? `v${security.hrPin.version || 1}` : "Open", security.hrPin?.updatedAt ? `Updated ${formatDate(security.hrPin.updatedAt)}` : "No HR PIN configured"],
          ["Webmaster", security.webmaster ? security.webmaster.label || "Approved browser" : "Locked", security.webmaster ? [security.webmaster.platform, security.webmaster.browser].filter(Boolean).join(" · ") : "Approve a browser"],
          ["Health ping", formatDurationMs(probes.health || 0), "API round-trip"]
        ])}
      </section>

      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("monitor")} Host snapshot</p>
            <h3>Runtime and probe timings</h3>
          </div>
        </div>
        ${renderKeyValueGrid([
          ["Node", server.nodeVersion || "Unknown", `Uptime ${server.uptimeSeconds || 0}s`],
          ["Board items", String(board.totalPosts || 0), "Updates tracked"],
          ["Summary fetch", formatDurationMs(probes.summary || 0), "Webmaster endpoint"],
          ["Posts fetch", formatDurationMs(probes.posts || 0), "Feed data"],
          ["Weather fetch", formatDurationMs(probes.weather || 0), "Weather payload"],
          ["Push status", formatDurationMs(probes.pushStatus || 0), "Notification status"]
        ])}
      </section>

      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("users")} Delivery roster</p>
            <h3>Subscribed devices</h3>
            <p>Active devices stay on top. Inactive entries need the current PIN or an unsubscribe.</p>
          </div>
        </div>
        ${renderNotificationDeviceRoster(notifications.devices || [], "No push devices have subscribed yet.")}
      </section>

      ${renderAccessPinPanel()}
    </section>
  `;
}

function renderWebmasterTrafficPanel() {
  const snapshot = buildWebmasterSnapshot();
  const traffic = snapshot.traffic || {};

  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("refresh")} Traffic</p>
          <h2>Request activity</h2>
          <p>These counts show how the site is being used and where errors are happening.</p>
        </div>
      </div>

      <section class="panel-card">
        ${renderKeyValueGrid([
          ["Requests", String(traffic.totals?.requests || 0), "All tracked requests"],
          ["Page views", String(traffic.totals?.pageViews || 0), "Employee, HR, and webmaster views"],
          ["API calls", String(traffic.totals?.apiRequests || 0), "Backend requests"],
          ["Success rate", traffic.totals?.requests ? `${Math.round(((traffic.totals.successfulRequests || 0) / traffic.totals.requests) * 100)}%` : "0%", "2xx and 3xx responses"],
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
      </section>

      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("news")} Recent requests</p>
            <h3>Latest activity</h3>
          </div>
        </div>
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
      </section>
    </section>
  `;
}

function renderWebmasterSystemPanel() {
  const snapshot = buildWebmasterSnapshot();
  const server = snapshot.server || {};
  const browser = snapshot.browser || {};
  const probes = state.webmaster.probes || {};

  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("monitor")} System</p>
          <h2>Host and device diagnostics</h2>
          <p>Use this tab to see the server, browser, and performance environment behind the portal.</p>
        </div>
      </div>

      <section class="panel-card">
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
      </section>

      <section class="panel-card">
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
              ["Load", browser.performance?.loadMs ? `${browser.performance.loadMs} ms` : "Unknown", "Navigation timing"],
              ["DOMContentLoaded", browser.performance?.domContentLoadedMs ? `${browser.performance.domContentLoadedMs} ms` : "Unknown", "Document ready time"],
              ["Transfer", browser.performance ? formatBytes(browser.performance.transferSize || 0) : "Unknown", "Transferred payload"],
              ["Encoded body", browser.performance ? formatBytes(browser.performance.encodedBodySize || 0) : "Unknown", "Uncompressed size"],
              ["Heap used", browser.memory ? formatBytes(browser.memory.usedJSHeapSize || 0) : "Unknown", "Browser JS heap"],
              ["Heap limit", browser.memory ? formatBytes(browser.memory.jsHeapSizeLimit || 0) : "Unknown", "Browser cap"]
            ])}
          </div>
        </div>
      </section>
    </section>
  `;
}

function renderWebmasterContentPanel() {
  const snapshot = buildWebmasterSnapshot();
  const board = snapshot.board || {};

  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("board")} Content</p>
          <h2>Portal inventory</h2>
          <p>See what is live, what is urgent, and what is about to expire.</p>
        </div>
      </div>

      <section class="panel-card">
        ${renderKeyValueGrid([
          ["Total posts", String(board.totalPosts || 0), "All saved updates"],
          ["Active posts", String(board.activePosts || 0), "Not expired"],
          ["Urgent posts", String(board.urgentPosts || 0), "Require immediate attention"],
          ["Important posts", String(board.importantPosts || 0), "Visible to staff"],
          ["Alert-enabled", String(board.alertPosts || 0), "Will notify subscribed devices"],
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
      </section>

      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("news")} Latest posts</p>
            <h3>Most recent activity</h3>
          </div>
        </div>
        <div class="post-list compact">
          ${board.recentPosts?.length ? board.recentPosts.map((post) => renderNotice(post, false)).join("") : '<div class="empty-state compact">No updates yet.</div>'}
        </div>
      </section>
    </section>
  `;
}

function renderWebmasterCodexPanel() {
  const snapshot = buildWebmasterSnapshot();
  const brief = buildCodexBrief(snapshot);
  const raw = JSON.stringify(snapshot, null, 2);

  return `
    <section class="panel-stack">
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("clipboard")} Codex</p>
          <h2>Copy the incident brief</h2>
          <p>Use these buttons to move the snapshot into Codex without rebuilding the context by hand.</p>
        </div>
        <div class="action-row">
          <button class="ghost-button" type="button" data-copy-webmaster-brief>${icon("clipboard")} Copy brief</button>
          <button class="ghost-button" type="button" data-copy-webmaster-json>${icon("chart")} Copy JSON</button>
        </div>
      </div>

      <section class="panel-card codex-panel">
        <label class="field full">
          <span>Codex brief</span>
          <textarea readonly rows="18" data-webmaster-brief>${escapeHtml(brief)}</textarea>
        </label>
        <label class="field full">
          <span>Raw JSON snapshot</span>
          <textarea readonly rows="18" data-webmaster-json>${escapeHtml(raw)}</textarea>
        </label>
      </section>
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
        ${brandBlock("Webmaster command center")}
        <div class="page-actions">
          <button class="ghost-button" type="button" data-route="launcher">${icon("home")} Launcher</button>
          <button class="ghost-button" type="button" data-route="employee">${icon("news")} Employee feed</button>
          <button class="ghost-button" type="button" data-route="hr">${icon("users")} HR console</button>
          <button class="ghost-button" type="button" data-copy-webmaster-brief>${icon("clipboard")} Copy brief</button>
          <button class="ghost-button" type="button" data-refresh>${icon("refresh")} Refresh</button>
        </div>
      </header>

      <section class="hero-strip hero-strip-webmaster" aria-label="Webmaster summary">
        ${renderStatCard(String(traffic.totals?.requests || 0), "Requests", `${traffic.totals?.apiRequests || 0} API calls`)}
        ${renderStatCard(String(traffic.totals?.serverErrors || 0), "Server errors", `${traffic.totals?.clientErrors || 0} client errors`)}
        ${renderStatCard(String(board.activePosts || 0), "Active updates", `${board.expiringSoon || 0} expiring soon`)}
        ${renderStatCard(String(board.urgentPosts || 0), "Urgent updates", `${board.alertPosts || 0} alert-enabled`)}
        ${renderStatCard(String(state.pushStatus.subscriptions || 0), "Subscriptions", state.push.supported ? "Push ready" : "No push support")}
        ${renderStatCard(formatDurationMs(traffic.totals?.averageDurationMs || 0), "Avg response", `Health ${formatDurationMs(probes.health || 0)}`)}
      </section>

      ${state.message ? `<div class="webmaster-banner ${escapeHtml(state.messageType)}">${escapeHtml(state.message)}</div>` : ""}

      ${renderTabBar(webmasterTabs, activeWebmasterTab, "webmaster", "Webmaster sections")}

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
                  : renderWebmasterCodexPanel()
        }
      </section>
    </main>
  `;
}

function renderAdmin() {
  const weather = state.weather || defaultWeather();
  const activeCount = state.posts.filter((post) => !isExpired(post)).length;
  const urgentCount = state.posts.filter((post) => post.priority === "Urgent" && !isExpired(post)).length;
  const latest = state.posts[0]?.createdAt ? formatDate(state.posts[0].createdAt) : "None";
  const weatherLocation = weatherDisplayName(weather);

  return `
    <main class="page-shell hr-shell">
      <header class="page-head">
        ${brandBlock("HR control center")}
        <div class="page-actions">
          <button class="ghost-button" type="button" data-route="launcher">${icon("home")} Launcher</button>
          <button class="ghost-button" type="button" data-route="employee">${icon("news")} Employee feed</button>
          <button class="ghost-button" type="button" data-route="webmaster">${icon("chart")} Webmaster</button>
          <button class="ghost-button" type="button" data-refresh>${icon("refresh")} Refresh</button>
        </div>
      </header>

      <section class="hero-strip hero-strip-hr" aria-label="HR summary">
        ${renderStatCard(String(activeCount), "Active updates", "Visible to employees")}
        ${renderStatCard(String(urgentCount), "Urgent alerts", "Items that trigger attention")}
        ${renderStatCard(weather.level, "Weather level", weatherLocation)}
        ${renderStatCard(latest, "Latest update", "Most recent publish time")}
      </section>

      ${state.message ? `<div class="hr-banner ${escapeHtml(state.messageType)}">${escapeHtml(state.message)}</div>` : ""}

      ${renderTabBar(adminTabs, activeAdminTab, "hr", "HR sections")}

      <section class="panel-surface">
        ${
          activeAdminTab === "publish"
            ? renderAdminPublishPanel()
            : activeAdminTab === "weather"
              ? renderAdminWeatherPanel(weather, weatherLocation)
              : activeAdminTab === "alerts"
                ? renderAdminAlertsPanel()
                : activeAdminTab === "history"
                  ? renderAdminHistoryPanel()
                  : renderAdminAccessPanel()
        }
      </section>
    </main>
  `;
}

function setMessage(message, type = "") {
  state.message = message;
  state.messageType = type;
}

function clearMessageSoon() {
  window.setTimeout(() => {
    setMessage("");
    render();
  }, 2600);
}

async function routeTo(route) {
  const nextPath = routePath(route);

  if (route === "launcher") {
    activeAdminTab = "publish";
    activeHistoryFilter = "All";
    activeWebmasterTab = "overview";
  }

  if (route === "hr") {
    activeAdminTab = "publish";
    activeHistoryFilter = "All";
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
    return;
  }

  if (route === "webmaster") {
    await refreshWebmasterData();
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
  const hrUnlocked = Boolean(state.access.hr?.authorized);
  const webmasterUnlocked = Boolean(state.access.webmaster?.authorized);
  document.body.dataset.route = route;
  const pageMarkup = state.loading
    ? '<main class="auth-shell"><section class="empty-state">Loading portal...</section></main>'
    : route === "launcher"
      ? renderLauncher()
      : route === "hr"
        ? (state.access.hr?.loaded && !hrUnlocked ? renderHrLockScreen() : renderAdmin())
      : route === "webmaster"
          ? (state.access.webmaster?.loaded && !webmasterUnlocked ? renderWebmasterLockScreen() : renderWebmaster())
          : renderEmployee();
  document.title = route === "launcher"
    ? APP_DISPLAY_TITLE
    : route === "hr"
    ? `${APP_DISPLAY_TITLE} HR${state.access.hr?.loaded && !hrUnlocked ? " Locked" : ""}`
    : route === "webmaster"
      ? `${APP_DISPLAY_TITLE} Webmaster${state.access.webmaster?.loaded && !webmasterUnlocked ? " Locked" : ""}`
      : APP_DISPLAY_TITLE;
  const focusSnapshot = captureFocusSnapshot();
  app.innerHTML = pageMarkup;
  restoreFocusSnapshot(focusSnapshot);
  syncEmployeeNameField();
  window.requestAnimationFrame(syncEmployeeNameField);
}

function captureFocusSnapshot() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !app.contains(active)) {
    return null;
  }

  if (active.matches("[data-employee-feed-search]")) {
    return {
      selector: "[data-employee-feed-search]",
      start: active.selectionStart,
      end: active.selectionEnd
    };
  }

  if (active.matches("[data-employee-feed-filter]")) {
    return { selector: "[data-employee-feed-filter]" };
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

function syncEmployeeNameField() {
  const input = app.querySelector("[data-employee-name-field]");
  if (!(input instanceof HTMLInputElement)) return;

  const storedEmployeeName = String(
    state.deviceProfile.employeeName ||
    state.deviceProfile.label ||
    ""
  ).trim();

  if (!storedEmployeeName) {
    input.value = "";
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
    setMessage("Deleted.", "success");
  } catch (error) {
    setMessage(error.message || "Could not delete post.");
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
    form.elements.audience.value = "All employees";
    if (result.notification?.error) {
      setMessage(`Published, but alert delivery failed: ${result.notification.error}`, "warning");
    } else if (result.post.notifyEmployees) {
      const delivered = Number(result.notification?.delivered || 0);
      const total = Number(result.notification?.total || 0);
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
  const form = event.target;
  const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
  const data = Object.fromEntries(new FormData(form));
  const nextProfile = saveDeviceProfile({
    ...state.deviceProfile,
    employeeName: String(data.employeeName || data.label || "").trim() || buildSuggestedDeviceLabel()
  });
  const accessPin = String(data.accessPin || "").trim();
  const setup = buildEmployeeSetupState();
  const action = resolveDeviceSetupAction({
    submitterAction: submitter?.dataset.deviceAction,
    primaryActionId: setup.primaryAction.id
  });

  state.deviceProfile = nextProfile;
  render();

  try {
    if (action === "push") {
      await enablePushAlerts(nextProfile, accessPin);
    } else {
      state.push.error = "";
      setMessage("Saved the employee name.", "success");
    }
  } catch (error) {
    if (action === "push") {
      setMessage(formatPushError(error, "Could not subscribe this device."));
    } else {
      setMessage(error.message || "Could not save the employee name.");
    }
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
  const tabButton = target.closest("[data-tab]");
  const copyWebmasterBriefButton = target.closest("[data-copy-webmaster-brief]");
  const copyWebmasterJsonButton = target.closest("[data-copy-webmaster-json]");
  const deleteButton = target.closest("[data-delete-post]");
  const enableAlertsButton = target.closest("[data-enable-alerts]");
  const disableAlertsButton = target.closest("[data-disable-alerts]");
  const sendTestPushButton = target.closest("[data-send-test-push]");
  const issueAccessPinButton = target.closest("[data-issue-access-pin]");
  const disableAccessPinButton = target.closest("[data-disable-access-pin]");
  const copyAccessPinButton = target.closest("[data-copy-access-pin]");
  const issueHrPinButton = target.closest("[data-issue-hr-pin]");
  const copyHrPinButton = target.closest("[data-copy-hr-pin]");
  const lockHrSessionButton = target.closest("[data-lock-hr-session]");
  const approveWebmasterButton = target.closest("[data-approve-webmaster-browser]");
  const lockWebmasterButton = target.closest("[data-lock-webmaster-browser]");

  if (routeButton) {
    event.preventDefault();
    await routeTo(routeButton.dataset.route);
    return;
  }

  if (tabButton) {
    event.preventDefault();
    if (tabButton.dataset.tabGroup === "hr") {
      activeAdminTab = tabButton.dataset.tab || "publish";
    } else if (tabButton.dataset.tabGroup === "webmaster") {
      activeWebmasterTab = tabButton.dataset.tab || "overview";
    }
    render();
    return;
  }

  if (target.closest("[data-refresh]")) {
    if (currentRoute() === "webmaster") {
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

  if (deleteButton) {
    event.preventDefault();
    await handleDeleteAction(deleteButton.dataset.deletePost);
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

  if (issueAccessPinButton) {
    event.preventDefault();

    try {
      await issueAccessPin();
    } catch (error) {
      setMessage(formatPushError(error, "Could not generate an access PIN."));
      render();
    }
    return;
  }

  if (disableAccessPinButton) {
    event.preventDefault();

    try {
      await disableAccessPin();
    } catch (error) {
      setMessage(formatPushError(error, "Could not disable the access PIN."));
      render();
    }
    return;
  }

  if (copyAccessPinButton) {
    event.preventDefault();

    try {
      await copyAccessPin();
    } catch {
      setMessage("Could not copy the access PIN.");
      render();
    }
    return;
  }

  if (issueHrPinButton) {
    event.preventDefault();

    try {
      await issueHrAccessPin();
    } catch (error) {
      setMessage(error.message || "Could not generate the HR PIN.");
      render();
    }
    return;
  }

  if (copyHrPinButton) {
    event.preventDefault();

    try {
      await copyHrAccessPin();
    } catch {
      setMessage("Could not copy the HR PIN.");
      render();
    }
    return;
  }

  if (lockHrSessionButton) {
    event.preventDefault();

    try {
      await lockHrAccessSession();
    } catch (error) {
      setMessage(error.message || "Could not lock the HR session.");
      render();
    }
    return;
  }

  if (approveWebmasterButton) {
    event.preventDefault();

    try {
      await approveWebmasterBrowser();
    } catch (error) {
      setMessage(error.message || "Could not approve this browser.");
      render();
    }
    return;
  }

  if (lockWebmasterButton) {
    event.preventDefault();

    try {
      await lockWebmasterBrowser();
    } catch (error) {
      setMessage(error.message || "Could not revoke the webmaster browser.");
      render();
    }
    return;
  }
}, true);

app.addEventListener("submit", async (event) => {
  if (event.target.matches("[data-hr-unlock-form]")) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));

    try {
      await unlockHrPage(data.pin);
    } catch (error) {
      setMessage(error.message || "Could not unlock HR.");
      render();
    }
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

app.addEventListener("change", (event) => {
  if (!(event.target instanceof HTMLSelectElement)) return;

  if (event.target.matches("[data-employee-feed-filter]")) {
    employeeFeedFilter = event.target.value || "All";
    render();
    return;
  }

  if (event.target.matches("[data-history-filter-select]")) {
    activeHistoryFilter = event.target.value;
    render();
    return;
  }

  if (event.target.name !== "priority" || !event.target.form?.matches("[data-post-form]")) {
    return;
  }

  const form = event.target.form;
  const checkbox = form?.elements.namedItem("notifyEmployees");

  if (checkbox instanceof HTMLInputElement) {
    checkbox.checked = event.target.value !== "Normal";
  }
});

app.addEventListener("input", (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;

  if (event.target.matches("[data-employee-feed-search]")) {
    employeeFeedSearch = event.target.value;
    if (employeeFeedRenderTimer) {
      window.clearTimeout(employeeFeedRenderTimer);
    }

    employeeFeedRenderTimer = window.setTimeout(() => {
      employeeFeedRenderTimer = 0;
      render();
    }, 120);
  }
});

app.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLElement)) return;

  if (!event.target.matches("[data-clear-employee-feed-filters]")) {
    return;
  }

  if (employeeFeedRenderTimer) {
    window.clearTimeout(employeeFeedRenderTimer);
    employeeFeedRenderTimer = 0;
  }

  employeeFeedSearch = "";
  employeeFeedFilter = "All";
  render();
});

app.addEventListener("toggle", (event) => {
  if (!(event.target instanceof HTMLDetailsElement)) return;
  if (!event.target.matches("[data-employee-setup-dropdown]")) return;

  state.employeeSetupOpen = event.target.open;
}, true);

window.addEventListener("hashchange", async () => {
  await hydrateRoute();
  render();
});

window.addEventListener("popstate", async () => {
  await hydrateRoute();
  render();
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

window.setInterval(async () => {
  if (currentRoute() !== "employee" || document.visibilityState !== "visible") {
    return;
  }

  try {
    await loadBoard();
    await Promise.all([
      loadPushStatus()
    ]);
    await syncPushState();
  } catch {
    // Keep the UI stable if polling fails.
  }
}, EMPLOYEE_REFRESH_MS);

try {
  await hydrateRoute();
} catch (error) {
  setMessage(error.message || "Could not load the app.");
} finally {
  state.loading = false;
  render();
}
