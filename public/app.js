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
const historyFilters = ["All", "Active", "Urgent", "Weather", "News", "Shift", "Safety", "HR"];
let activeAdminTab = "publish";
let activeWebmasterTab = "overview";
let activeHistoryFilter = "All";
let activePushRosterFilter = "active";
const adminTabs = [
  { id: "publish", label: "Publish", icon: "megaphone" },
  { id: "share", label: "Users", icon: "users" },
  { id: "history", label: "History", icon: "board" },
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
  adminInvite: {
    loaded: false,
    token: "",
    details: null,
    busy: false,
    error: ""
  },
  employeeDirectory: {
    loaded: false,
    employees: []
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
    webmaster: false
  },
  employeeInstallGuideOpen: false,
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
          <div class="brand-logo-disc">
            <img class="brand-lockup-logo" src="/assets/palziv-logo-transparent.png?v=20260617c" alt="${escapeHtml(APP_TITLE)}" loading="eager" decoding="async">
          </div>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
        </div>
      </div>
    `;
  }

function renderAuthFrame({
  title,
  eyebrow = "",
  description = "",
  error = "",
  content,
  className = "",
  contentClassName = ""
}) {
  const cardClasses = ["auth-gate-card", "panel-card", className].filter(Boolean).join(" ");
  const contentClasses = ["auth-frame-content", contentClassName].filter(Boolean).join(" ");

  return `
    <main class="auth-shell">
      <section class="${cardClasses}">
        ${brandBlock("")}
        <div class="panel-title auth-frame-title">
          <div>
            ${eyebrow ? `<p class="eyebrow auth-frame-eyebrow">${escapeHtml(eyebrow)}</p>` : ""}
            <h2>${escapeHtml(title)}</h2>
            ${description ? `<p>${escapeHtml(description)}</p>` : ""}
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

function renderAdminAuthFrame({ route, title, description = "", error = "", content, footer = "" }) {
  const routeLabel = route === "webmaster" ? "Webmaster admin" : "HR admin";

  return `
    <main class="admin-auth-shell">
      <section class="admin-auth-card panel-card" data-admin-auth-surface="${escapeHtml(route)}">
        <header class="admin-auth-header">
          <div class="admin-auth-brand">
            <div class="admin-auth-brand-disc">
              <img class="admin-auth-brand-logo" src="/assets/palziv-logo-transparent.png?v=20260617c" alt="${escapeHtml(APP_TITLE)}" loading="eager" decoding="async">
            </div>
            <div class="admin-auth-brand-copy">
              <p class="eyebrow">${escapeHtml(routeLabel)}</p>
              <h1>${escapeHtml(title)}</h1>
              ${description ? `<p>${escapeHtml(description)}</p>` : ""}
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

function renderStatCard(value, label, note = "") {
  return `
    <article class="stat-card">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
      ${note ? `<p>${escapeHtml(note)}</p>` : ""}
    </article>
  `;
}

function renderHrSummaryStatCard({ value, label, tab, filter = "" }) {
  const actionLabel =
    tab === "share"
      ? "Open Employee Accounts."
      : filter === "Urgent"
        ? "Open Urgent Alert History."
        : "Open Active Update History.";

  return `
    <button
      class="stat-card hr-stat-button"
      type="button"
      onclick="window.openHrSummaryTarget && window.openHrSummaryTarget('${escapeHtml(tab)}', '${escapeHtml(filter)}')"
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
      aria-label="${escapeHtml(`${label}. ${note ? `${note}. ` : ""}Open detailed webmaster data.`)}"
    >
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
      ${note ? `<p>${escapeHtml(note)}</p>` : ""}
      <small class="webmaster-stat-hint">Click for details</small>
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
  description = "",
  badge = "",
  hint = "Click to toggle",
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
            ${description ? `<p>${escapeHtml(description)}</p>` : ""}
          </div>
          <div class="webmaster-expand-summary-meta">
            ${badge ? `<span class="sync-pill">${escapeHtml(badge)}</span>` : ""}
            <span class="webmaster-expand-hint">${escapeHtml(hint)}</span>
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
    route === "/api/push/test" ||
    route === "/api/webmaster/logout" ||
    route === "/api/webmaster/password" ||
    route === "/api/hr/password/reset"
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

async function loadAdminDirectory() {
  try {
    const result = await requestJson("/api/admin-users");
    state.adminDirectory = {
      loaded: true,
      adminUsers: Array.isArray(result.adminUsers) ? result.adminUsers : []
    };
  } catch {
    state.adminDirectory = {
      loaded: true,
      adminUsers: []
    };
  }

  return state.adminDirectory;
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
    state.adminDirectory = {
      loaded: false,
      adminUsers: []
    };
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
    loadAdminDirectory(),
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
  return state.webmaster;
}

async function loadHrAccessStatus() {
  const probe = await safeTimedRequestJson("/api/hr/check", {
    authorized: false,
    setupRequired: false,
    sessionExpiresAt: "",
    csrfToken: "",
    user: null
  });

  state.access.hr = {
    ...state.access.hr,
    loaded: true,
    authorized: Boolean(probe.body.authorized),
    setupRequired: Boolean(probe.body.setupRequired),
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

async function loadAdminInvitePreview(route) {
  const inviteToken = currentInviteToken();

  if (!inviteToken || (route !== "hr" && route !== "webmaster")) {
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
  const employeeName = String(
    state.deviceProfile.employeeName ||
    state.deviceProfile.label ||
    ""
  ).trim();
  const currentPush = buildCurrentPushDeviceState();
  const pushSupported = currentPush.supported;
  const pushSubscribed = currentPush.subscribed;
  const pushPermission = currentPush.permission;
  const pushReady = currentPush.active;
  const installRequired = isMobileDevice();
  const installed = !installRequired || isInstalledWebApp();
  const notificationGranted = pushPermission === "granted";
  let nextStep = {
    title: "Save the employee name",
    detail: "Enter the employee's name so the roster shows exactly who subscribed.",
    action: "profile"
  };

  if (installRequired && !installed) {
    nextStep = {
      title: "Install this site on your phone",
      detail: isIosDevice()
        ? "Use Safari Share -> Add to Home Screen, then reopen the installed Palziv app before subscribing."
        : "Add this site to your Home Screen or install the app from the browser menu, then reopen it to finish setup.",
      action: "profile"
    };
  } else if (!pushSupported) {
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
  } else if (!employeeName) {
    nextStep = {
      title: "Enter name to subscribe",
      detail: "Use your employee name, then tap Subscribe.",
      action: pushPermission === "denied" ? "profile" : "push"
    };
  } else if (pushPermission === "denied") {
      nextStep = {
        title: "Enable notifications for this site",
        detail: "Notification access is turned off here. Enter the employee name, then turn it back on and tap subscribe.",
        action: "profile"
      };
  } else if (!pushSubscribed) {
      nextStep = {
      title: "Subscribe This Browser",
      detail: "This browser can receive web push. Enter the employee name, then tap subscribe to finish setup.",
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
        id: "profile",
        label: "Save",
        icon: "clipboard"
      };

  const checklist = [
    {
      title: "Install On Phone",
      value: installRequired ? (installed ? "Installed" : "Needed") : "Not needed",
      detail: installRequired
        ? "Open the installed Palziv app from your Home Screen before you finish alert setup."
        : "Phone installation is only required on mobile devices.",
      complete: installed
    },
    {
      title: "Employee name",
      value: employeeName,
      detail: "Saved locally so this device stays easy to identify.",
      complete: Boolean(employeeName)
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
      title: "Alert delivery",
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
    employeeName,
    installRequired,
    installed,
    pushSupported,
    pushSubscribed,
    pushPermission,
    busy: Boolean(state.push.busy),
    ready: Boolean(employeeName) && installed && notificationGranted && pushReady,
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
          label: profile.employeeName || profile.label,
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
      <span class="status-chip success">${icon("check")} Subscribed On This Device</span>
    `;
  }

  const supported = supportsPushNotifications();
  const buttonLabel = "Subscribe This Device";
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

  return `<button class="ghost-button" type="button" data-send-test-push>${icon("send")} Send Test Push</button>`;
}

function renderCurrentPushStatusCard(currentPush) {
  const badgeClass = currentPush.tone === "success" ? "success" : "warning";
  const badgeIcon = currentPush.tone === "success" ? icon("check") : icon("alert");

  return `
    <article class="device-subscription-card ${currentPush.tone}">
      <div class="device-subscription-head">
        <div class="device-subscription-copy">
          <p class="eyebrow">${icon("bell")} This device</p>
          <h3>${escapeHtml(currentPush.title)}</h3>
          <p>${escapeHtml(currentPush.detail)}</p>
        </div>
        <span class="status-chip ${badgeClass}">${badgeIcon} ${escapeHtml(currentPush.badge)}</span>
      </div>
      <div class="device-subscription-facts">
        <span class="status-chip muted">${icon("lock")} Permission ${escapeHtml(currentPush.permissionLabel)}</span>
        <span class="status-chip muted">${icon("check")} Server ${escapeHtml(currentPush.serverLabel)}</span>
        ${currentPush.device?.label ? `<span class="status-chip muted">${icon("users")} ${escapeHtml(currentPush.device.label)}</span>` : ""}
      </div>
      <p class="device-subscription-note">${escapeHtml(currentPush.hint)}</p>
      <small class="device-subscription-meta">${escapeHtml(currentPush.lastUpdatedLabel)}</small>
    </article>
  `;
}

function renderDeviceChecklistItem(item) {
  return `
    <article class="device-setup-step ${item.complete ? "complete" : "missing"}">
      <div class="device-setup-step-head">
        <strong>${escapeHtml(item.title)}</strong>
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
      "Open the Palziv app from your Home Screen.",
      "Return to Account and finish setup."
    ];
  }

  if (navigator.userAgent.toLowerCase().includes("android")) {
    return [
      "Open this page in Chrome.",
      "Tap the three dots.",
      "Tap Install app or Add to Home screen.",
      "Open the Palziv app from your Home Screen.",
      "Return to Account and finish setup."
    ];
  }

  return [
    "Open this page on your phone.",
    "Use the browser menu or Share button.",
    "Tap Install app or Add to Home Screen.",
    "Open the Palziv app from your Home Screen.",
    "Return to Account and finish setup."
  ];
}

function renderInstallGuideToggle() {
  return `
    <details class="employee-install-guide"${state.employeeInstallGuideOpen ? " open" : ""} data-employee-install-guide>
      <summary class="ghost-button employee-install-guide-toggle">Install On Phone</summary>
      <div class="employee-install-guide-body">
        <p class="panel-copy">Use the phone that should receive Palziv alerts.</p>
        <ol class="employee-install-guide-list">
          ${installGuideSteps().map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
        </ol>
      </div>
    </details>
  `;
}

function renderEmployeeSubscriptionBanner(setup) {
  if (setup.ready) return "";

  const incompleteSteps = setup.checklist.filter((item) => !item.complete);
  const firstIncomplete = incompleteSteps[0];
  const headline = firstIncomplete?.title === "Install on phone"
    ? "Install the Palziv app on this phone before alerts can work."
    : firstIncomplete?.title === "Employee name"
      ? "Enter name to subscribe."
    : "This phone is not fully subscribed for urgent alerts yet.";

  return `
    <section class="employee-subscription-banner warning" aria-label="Not subscribed">
      <div class="employee-subscription-banner-head">
        <div class="employee-subscription-banner-copy">
          <p class="eyebrow">${icon("alert")} Not subscribed</p>
          <h2>${escapeHtml(headline)}</h2>
        </div>
        <div class="employee-subscription-banner-actions">
          ${setup.installRequired && !setup.installed ? renderInstallGuideToggle() : ""}
        </div>
      </div>
      <div class="employee-subscription-banner-checklist">
        ${incompleteSteps.map((item) => renderDeviceChecklistItem(item)).join("")}
      </div>
      ${renderEmployeeSetupWizard()}
    </section>
  `;
}

function renderEmployeeSetupWizard() {
  const setup = buildEmployeeSetupState();
  const busy = setup.busy;

  const formMarkup = `
    <form class="device-setup-form" data-device-setup-form>
      <div class="device-setup-grid">
        <label class="field full">
          <span>Name</span>
          <input name="employeeName" maxlength="80" required value="${escapeHtml(setup.employeeName)}" placeholder="e.g. Maria Lopez" autocomplete="off" autocapitalize="words" spellcheck="false" data-employee-name-field>
        </label>
      </div>

      <div class="device-setup-actions">
        <button class="button" type="submit" data-device-action="${escapeHtml(setup.primaryAction.id)}" ${busy ? "disabled aria-disabled=\"true\"" : ""}>
          ${icon(setup.primaryAction.icon)} ${escapeHtml(setup.primaryAction.label)}
        </button>
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

function renderAdminPushActions() {
  return `<p class="panel-copy">Employee devices enroll from the employee portal. Use the roster below to monitor which accounts are Active and which still need cleanup.</p>`;
}

function renderWebmasterPushActions() {
  return `
    <div class="employee-alert-actions admin-alert-actions">
      ${renderTestPushControl()}
    </div>
  `;
}

function filterPushRosterDevices(filter) {
  const devices = Array.isArray(state.pushStatus.devices) ? state.pushStatus.devices : [];

  if (filter === "attention") {
    return devices.filter((device) => !device.authorized);
  }

  if (filter === "all") {
    return devices;
  }

  return devices.filter((device) => device.authorized);
}

function pushRosterTitle(filter, count) {
  if (filter === "attention") {
    return `${count} device${count === 1 ? "" : "s"} needing attention`;
  }

  if (filter === "all") {
    return `${count} enrolled device${count === 1 ? "" : "s"}`;
  }

  return `${count} active device${count === 1 ? "" : "s"}`;
}

function pushRosterEmptyLabel(filter) {
  if (filter === "attention") {
    return "No devices currently need attention.";
  }

  if (filter === "all") {
    return "No devices enrolled yet.";
  }

  return "No devices are Active yet.";
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

function historyPosts() {
  return [...state.posts]
    .filter((post) => {
      if (activeHistoryFilter === "All") return true;
      if (activeHistoryFilter === "Active") return !isExpired(post);
      if (activeHistoryFilter === "Urgent") return post.priority === "Urgent";
      return post.type === activeHistoryFilter;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function formatAlertRetentionLabel(value) {
  return {
    "24h": "24 Hours",
    "48h": "48 Hours",
    "168h": "7 Days",
    manual: "Manual Only"
  }[String(value || "48h")] || "48 Hours";
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
      <div class="feed-main">
        <div class="feed-head">
          <div class="feed-head-copy">
            <span class="feed-type">${escapeHtml(feedType)}</span>
            <strong>${escapeHtml(feedTitle)}</strong>
          </div>
          <time class="feed-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(feedTime)}</time>
        </div>
        ${(feedPriority !== "Normal" || post.notifyEmployees) ? `
        <div class="feed-badges">
          ${feedPriority !== "Normal" ? `<span class="priority-pill ${safePriority}">${escapeHtml(feedPriority)}</span>` : ""}
          ${post.notifyEmployees ? `<span class="sync-pill">Alert sent</span>` : ""}
        </div>
        ` : ""}
        <p class="feed-body">${escapeHtml(feedBody)}</p>
      </div>
    </article>
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
  const inactiveSubscriptions = Number(state.pushStatus.inactiveSubscriptions ?? Math.max(0, subscriptions - activeSubscriptions));
  const loaded = Boolean(state.pushStatus.loaded);
  const rosterFilter = activePushRosterFilter === "attention" || activePushRosterFilter === "all" ? activePushRosterFilter : "active";
  const rosterDevices = filterPushRosterDevices(rosterFilter);
  const readyCopy = state.pushStatus.supported
    ? "Push delivery is ready."
    : "Push delivery is unavailable on this server.";
  const followUpCopy = !loaded
    ? "Checking which devices can receive urgent alerts."
    : inactiveSubscriptions > 0
      ? `${inactiveSubscriptions} enrolled device${inactiveSubscriptions === 1 ? "" : "s"} still need refresh before HR tests can reach them.`
      : activeSubscriptions > 0
        ? "All enrolled devices are currently Active for HR test alerts."
        : "No devices are Active yet. Employees still need to finish enrollment on their phone or browser.";

  return `
    <section class="tool-panel push-panel panel-card">
      <div class="panel-title">
        <div>
          <p class="eyebrow">${icon("bell")} Alert delivery</p>
          <h2>${escapeHtml(loaded ? `${activeSubscriptions} active device${activeSubscriptions === 1 ? "" : "s"}` : "Loading alert status")}</h2>
          <p>${escapeHtml(readyCopy)} Test alerts only reach devices marked Active.</p>
        </div>
      </div>
      <div class="push-metrics">
        <button class="push-metric push-metric-button ${rosterFilter === "active" ? "selected" : ""}" type="button" data-push-roster-filter="active" aria-pressed="${rosterFilter === "active" ? "true" : "false"}">
          <strong>${escapeHtml(loaded ? String(activeSubscriptions) : "…")}</strong>
          <span>Active devices</span>
        </button>
        <button class="push-metric push-metric-button ${rosterFilter === "attention" ? "selected" : ""}" type="button" data-push-roster-filter="attention" aria-pressed="${rosterFilter === "attention" ? "true" : "false"}">
          <strong>${escapeHtml(loaded ? String(inactiveSubscriptions) : "…")}</strong>
          <span>Need attention</span>
        </button>
        <button class="push-metric push-metric-button ${rosterFilter === "all" ? "selected" : ""}" type="button" data-push-roster-filter="all" aria-pressed="${rosterFilter === "all" ? "true" : "false"}">
          <strong>${escapeHtml(loaded ? String(subscriptions) : "…")}</strong>
          <span>Total devices</span>
        </button>
      </div>
      <p class="push-health-note ${inactiveSubscriptions > 0 ? "warning" : "success"}">${escapeHtml(followUpCopy)}</p>
      ${renderAdminPushActions()}
      <section class="push-roster-panel">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("users")} Device roster</p>
            <h2>${escapeHtml(loaded ? pushRosterTitle(rosterFilter, rosterDevices.length) : "Loading enrolled devices")}</h2>
            <p>Click the delivery totals above to switch between Active devices, cleanup work, and the full roster.</p>
          </div>
          <span class="status-chip muted">${icon("filter")} ${escapeHtml(rosterFilter === "attention" ? "Need attention" : rosterFilter === "all" ? "All devices" : "Active only")}</span>
        </div>
        ${loaded
          ? renderNotificationDeviceRoster(rosterDevices, pushRosterEmptyLabel(rosterFilter))
          : '<div class="empty-state compact">Loading enrolled devices...</div>'}
      </section>
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
          <span>Push delivery</span>
        </div>
      </div>

      ${renderWebmasterPushActions()}

      <p class="panel-copy">If a device needs cleanup, unsubscribe it from the roster or turn alerts off on that browser.</p>
    `
  });
}

function renderEmployeeAuthGate() {
  const authError = state.access.employee.error || state.message;

  return renderAuthFrame({
    title: "Employee login",
    error: authError,
    content: `
      <form class="auth-form" data-employee-login-form>
        <label class="field">
          <span>Username</span>
          <input name="username" maxlength="80" required autocomplete="username" placeholder="e.g. maria.lopez">
        </label>
        <label class="field">
          <span>Password</span>
          <input name="password" type="password" minlength="10" required autocomplete="current-password" placeholder="Your employee password">
        </label>
        <div class="auth-form-actions">
          <button class="button" type="submit">Sign In</button>
          <button class="ghost-button" type="button" data-route="launcher">Launcher</button>
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
      content: '<div class="auth-form"><p class="auth-inline-meta">Checking the invitation details.</p></div>'
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
          <div class="invite-summary-row">${escapeHtml(adminUser.email || "")}</div>
          <div class="invite-summary-row">${escapeHtml(`@${adminUser.username || ""} · ${roles}`)}</div>
          <div class="invite-summary-row">${escapeHtml(adminUser.inviteExpiresAt ? `Expires ${formatDate(adminUser.inviteExpiresAt)}` : "")}</div>
        </div>
        <form class="auth-form" data-accept-admin-invite-form>
          <label class="field">
            <span>Create password</span>
            <input name="password" type="password" minlength="10" required autocomplete="new-password" placeholder="Create your password">
          </label>
          <label class="field">
            <span>Confirm password</span>
            <input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password" placeholder="Repeat your password">
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

function renderAdminAuthGate(route) {
  const access = route === "webmaster" ? state.access.webmaster : state.access.hr;
  const sectionTitle = route === "webmaster" ? "Webmaster" : "HR";
  const inviteToken = currentInviteToken();
  const authError = access.error || state.message;
  const canSetup = route === "hr" ? access.setupRequired : (access.setupRequired && access.hrAuthorized);
  const setupBlocked = route === "webmaster" && access.setupRequired && !access.hrAuthorized;
  const recoveryMode = route === "hr"
    ? state.authRecovery.hr
    : route === "webmaster"
      ? state.authRecovery.webmaster
      : false;

  if (inviteToken) {
    return renderAdminInviteGate(route);
  }

  const heading = recoveryMode
    ? `Reset ${sectionTitle} access`
    : setupBlocked
      ? `${sectionTitle} not ready`
      : canSetup
        ? `Create first ${sectionTitle} admin`
        : `${sectionTitle} sign in`;
  const description = recoveryMode
    ? route === "hr"
      ? "Use today's master key to set a new password."
      : "Password resets for Webmaster admins are handled from HR."
    : setupBlocked
      ? "HR must finish setup or grant Webmaster access before this screen can be used."
      : canSetup
        ? `Create the first named admin account for ${sectionTitle}.`
        : `Use your named admin account to continue.`;

  return renderAdminAuthFrame({
    route,
    title: heading,
    description,
    error: authError,
    content: recoveryMode
      ? route === "hr"
        ? `
          <form class="auth-form admin-auth-form" data-hr-master-recovery-form>
            <label class="field">
              <span>Master key</span>
              <input name="recoveryToken" type="password" required autocomplete="one-time-code" placeholder="Today's master key">
            </label>
            <label class="field">
              <span>New password</span>
              <input name="password" type="password" minlength="10" required autocomplete="new-password" placeholder="New password">
            </label>
            <label class="field">
              <span>Confirm new password</span>
              <input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password" placeholder="Repeat the new password">
            </label>
            <button class="button admin-auth-submit" type="submit">Recover With Master Key</button>
          </form>
        `
        : `
          <div class="admin-auth-message">
            HR handles password resets for Webmaster admins from Admin Management.
          </div>
          <div class="admin-auth-primary-actions">
            <button class="button admin-auth-submit" type="button" data-route="hr">Open HR</button>
          </div>
        `
      : setupBlocked
      ? `
        <div class="admin-auth-message">
          HR must finish the first admin setup or assign Webmaster access before this sign-in becomes available.
        </div>
        <div class="admin-auth-primary-actions">
          <button class="button admin-auth-submit" type="button" data-route="hr">Open HR</button>
        </div>
      `
      : `
        <form class="auth-form admin-auth-form" data-admin-auth-form data-admin-auth-mode="${escapeHtml(canSetup ? "setup" : "login")}" data-admin-route="${escapeHtml(route)}">
          ${route === "hr" && canSetup ? `
          <label class="field">
            <span>Deployment setup secret</span>
            <input name="setupToken" type="password" required autocomplete="one-time-code" placeholder="Bootstrap secret">
          </label>
          ` : ""}
          <label class="field">
            <span>${escapeHtml(canSetup ? "Create username" : "Username")}</span>
            <input name="username" maxlength="80" required autocomplete="username" placeholder="e.g. alex.smith">
          </label>
          <label class="field">
            <span>${escapeHtml(canSetup ? "Create password" : "Password")}</span>
            <input name="password" type="password" minlength="10" required autocomplete="${escapeHtml(canSetup ? "new-password" : "current-password")}" placeholder="${escapeHtml(canSetup ? "Create a password" : "Your password")}">
          </label>
          <button class="button admin-auth-submit" type="submit">${escapeHtml(canSetup ? "Save Credentials" : "Sign In")}</button>
        </form>
      `,
    footer: recoveryMode
      ? `
        <div class="admin-auth-footer-actions">
          <button class="auth-inline-action" type="button" data-close-auth-recovery="${escapeHtml(route)}">Back to Sign In</button>
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
        <p class="admin-auth-footer-note">${escapeHtml(
          route === "webmaster"
            ? "Finish HR setup first if Webmaster access has not been assigned yet."
            : "After setup, use Admin Management to create or invite additional admins."
        )}</p>
        <div class="admin-auth-footer-actions">
          <button class="auth-inline-action" type="button" data-route="launcher">Back to Launcher</button>
        </div>
      `
      : `
        <div class="admin-auth-footer-actions">
          <button class="auth-inline-action" type="button" data-open-auth-recovery="${escapeHtml(route)}">Forgot Password?</button>
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
      </td>
      <td>
        <span class="admin-table-chip ${employee.active ? "is-positive" : "is-muted"}">${escapeHtml(employee.active ? "Active" : "Disabled")}</span>
      </td>
      <td>
        <div class="admin-table-primary">${escapeHtml(String(employee.activeSessions || 0))}</div>
        <div class="admin-table-secondary">${escapeHtml(employee.lastLoginAt ? `Last Login ${formatDate(employee.lastLoginAt)}` : "No Login Yet")}</div>
      </td>
      <td>
        <div class="admin-table-primary">${escapeHtml(String(employee.authorizedDevices || 0))}</div>
        <div class="admin-table-secondary">${escapeHtml(`${employee.devices || 0} Total Enrolled`)}</div>
      </td>
      <td>
        <form class="admin-table-inline-form employee-password-inline-form" data-reset-employee-password-form>
          <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}">
          <input name="password" type="password" minlength="10" required autocomplete="new-password" placeholder="New Temporary Password">
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
        </div>
      </td>
    </tr>
  `;
}

function adminRoleLabel(role) {
  return role === "webmaster" ? "IT" : "HR";
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

  if (adminUser.inviteState === "pending") {
    return adminUser.inviteExpiresAt
      ? `Invite Pending Until ${formatDate(adminUser.inviteExpiresAt)}`
      : "Invite Pending";
  }

  if (adminUser.inviteState === "expired") {
    return adminUser.inviteExpiresAt
      ? `Invite Expired ${formatDate(adminUser.inviteExpiresAt)}`
      : "Invite Expired";
  }

  return "Credentials Not Configured";
}

function renderAdminDirectoryRow(adminUser) {
  const roles = Array.isArray(adminUser.roles) ? adminUser.roles : [];
  const isCurrentUser = Boolean(adminUser.currentUser);
  const identitySummary = [adminUser.email || "Email required", adminUser.username ? `@${adminUser.username}` : ""]
    .filter(Boolean)
    .join(" · ");
  const statusSummary = isCurrentUser
    ? `Current account${adminUser.lastLoginAt ? ` · Last Login ${formatDate(adminUser.lastLoginAt)}` : ""}`
    : adminInviteStatusText(adminUser);

  return `
    <tr>
      <td>
        <div class="admin-table-primary">${escapeHtml(adminUser.displayName || adminUser.username || "Unknown admin")}</div>
        <div class="admin-table-secondary">${escapeHtml(identitySummary)}</div>
        <div class="admin-table-secondary">${escapeHtml(statusSummary)}</div>
        <form class="admin-identity-form" data-update-admin-profile-form>
          <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
          <div class="admin-identity-grid">
            <label class="field">
              <span>Display name</span>
              <input name="displayName" maxlength="120" required value="${escapeHtml(adminUser.displayName || "")}" placeholder="Admin name">
            </label>
            <label class="field">
              <span>Email</span>
              <input name="email" type="email" maxlength="200" required value="${escapeHtml(adminUser.email || "")}" placeholder="admin@company.com">
            </label>
          </div>
          <button class="ghost-button" type="submit">${icon("check")} Save Identity</button>
        </form>
      </td>
      <td>
        <div class="admin-role-cell">
          <div class="admin-role-chip-row">${renderAdminRoleChips(roles)}</div>
          <div class="admin-table-secondary">Webmaster roles stay outside the HR console.</div>
        </div>
      </td>
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
                : adminUser.inviteState === "pending"
                  ? "Invite Pending"
                  : adminUser.inviteState === "expired"
                    ? "Invite Expired"
                    : "Needs Invite"
            )}
          </span>
          <form class="admin-table-inline-form admin-password-inline-form" data-reset-admin-password-form>
            <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
            <input name="password" type="password" minlength="10" required autocomplete="new-password" placeholder="${escapeHtml(isCurrentUser ? "Use settings for your password" : "New Temporary Password")}"${isCurrentUser ? " disabled" : ""}>
            <button class="ghost-button" type="submit"${isCurrentUser ? " disabled" : ""}>${icon("lock")} Reset</button>
          </form>
        </div>
      </td>
      <td>
        <div class="admin-table-actions">
          ${!adminUser.credentialsConfigured ? `
          <form data-resend-admin-invite-form>
            <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
            <button class="ghost-button" type="submit">${icon("send")} ${escapeHtml(adminUser.inviteState === "pending" ? "Resend Invite" : "Send Invite")}</button>
          </form>
          ` : ""}
          <form data-admin-access-form>
            <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
            <input type="hidden" name="active" value="${adminUser.active ? "false" : "true"}">
            <button class="ghost-button" type="submit"${isCurrentUser ? " disabled" : ""}>
              ${adminUser.active ? `${icon("alert")} Disable Access` : `${icon("check")} Enable Access`}
            </button>
          </form>
          <form data-revoke-admin-sessions-form>
            <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
            <button class="ghost-button" type="submit"${isCurrentUser ? " disabled" : ""}>${icon("refresh")} Sign Out Sessions</button>
          </form>
        </div>
      </td>
    </tr>
  `;
}

function renderAdminDirectoryTable(adminUsers) {
  if (!adminUsers.length) {
    return '<div class="empty-state">No HR Admin Accounts Yet.</div>';
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
          ${adminUsers.map((adminUser) => renderAdminDirectoryRow(adminUser)).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAdminAccountsPanel() {
  const adminUsers = Array.isArray(state.adminDirectory.adminUsers) ? state.adminDirectory.adminUsers : [];

  return `
    <section class="panel-card employee-access-card">
      <div class="employee-access-head">
        <div>
          <h3>HR Admin Accounts</h3>
          <p>Webmaster-role accounts are intentionally hidden from the HR console.</p>
        </div>
        <span class="sync-pill">${escapeHtml(`${adminUsers.length} HR Admin${adminUsers.length === 1 ? "" : "s"}`)}</span>
      </div>

      <form class="employee-create-form admin-create-grid" data-create-admin-form>
        <label class="field">
          <span>Display name</span>
          <input name="displayName" maxlength="120" required placeholder="Alex Morgan">
        </label>
        <label class="field">
          <span>Email</span>
          <input name="email" type="email" maxlength="200" required placeholder="alex@company.com">
        </label>
        <label class="field">
          <span>Username</span>
          <input name="username" maxlength="80" required placeholder="Admin Username">
        </label>
        <label class="field">
          <span>Temporary password</span>
          <input name="password" type="password" minlength="10" autocomplete="new-password" placeholder="Only needed for manual setup">
        </label>
        <input name="roles" type="hidden" value="hr">
        <div class="field">
          <span>Role</span>
          <div class="admin-role-chip-row">${renderAdminRoleChips(["hr"])}</div>
        </div>
        <div class="admin-create-actions">
          <button class="button employee-create-submit" type="submit" data-admin-create-action="invite">${icon("send")} Send Invite</button>
          <button class="ghost-button" type="submit" data-admin-create-action="password">${icon("lock")} Create With Password</button>
        </div>
      </form>
      <p class="form-note admin-create-note">This surface creates HR-only admin accounts. Webmaster-role accounts stay outside the HR console.</p>

      ${renderAdminDirectoryTable(adminUsers)}
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

      <form class="employee-create-form employee-create-grid" data-create-employee-form>
          <label class="field">
            <span>Name</span>
            <input name="name" maxlength="120" required placeholder="Employee Name">
          </label>
          <label class="field">
            <span>Username</span>
            <input name="username" maxlength="80" required placeholder="Username">
          </label>
          <label class="field">
            <span>Temporary password</span>
            <input name="password" type="password" minlength="10" required placeholder="Temporary Password">
          </label>
          <button class="button employee-create-submit" type="submit">${icon("users")} Create Account</button>
      </form>

      ${renderEmployeeDirectoryTable(employees)}
    </section>
  `;
}

function renderEmployee() {
  const notices = visiblePosts();
  const setup = buildEmployeeSetupState();

  return `
    <main class="page-shell employee-shell">
        <section class="employee-brand-banner" aria-label="Palziv brand banner">
          <div class="employee-brand-banner-head">
            <div class="employee-brand-banner-copy">
              <div class="employee-brand-banner-disc">
                <img class="employee-brand-banner-logo" src="/assets/palziv-logo-transparent.png?v=20260617c" alt="Palziv" loading="eager" decoding="async">
              </div>
              <p class="employee-brand-banner-kicker">Employee updates</p>
              <p class="employee-brand-banner-tagline">Official notices, urgent alerts, and company signal in one stream.</p>
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

      <section class="employee-bottom-actions" aria-label="Account actions">
        <button class="ghost-button employee-signout-button" type="button" data-employee-logout>Sign Out</button>
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

function renderLauncher() {
  return `
    <main class="page-shell launcher-shell">
      ${renderAppUpdateBanner()}
        <section class="launcher-stage">
          <div class="launcher-brand" aria-label="Palziv">
            <div class="launcher-brand-disc">
              <img class="launcher-brand-logo" src="/assets/palziv-logo-transparent.png?v=20260617c" alt="Palziv" loading="eager" decoding="async">
            </div>
          </div>

        <div class="launcher-panel">
          <div class="launcher-grid">
            ${renderLauncherCard("employee", "Employee login")}
            ${renderLauncherCard("hr", "HR login")}
            ${renderLauncherCard("webmaster", "IT login")}
          </div>
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
          <h2>New Update</h2>
          <p>Create a clear employee update and choose exactly who should receive it.</p>
        </div>
      </div>
      <section class="tool-panel composer-panel panel-card">
        <form data-post-form>
          <div class="composer-grid">
            <label class="field field-span-2">
              <span>Title</span>
              <input name="title" maxlength="90" required placeholder="Short Headline">
            </label>
            <label class="field field-span-2">
              <span>Message</span>
              <textarea name="body" maxlength="700" required placeholder="What Employees Need To Know"></textarea>
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
              <select name="audience">
                <option>All Employees</option>
                <option>Operations</option>
                <option>Office Staff</option>
                <option>Warehouse</option>
                <option>Leadership</option>
                <option>HR</option>
              </select>
            </label>
            <label class="field">
              <span>Alert Retention</span>
              <select name="alertRetention">
                <option value="24h">24 Hours</option>
                <option value="48h" selected>48 Hours</option>
                <option value="168h">7 Days</option>
                <option value="manual">Manual Only</option>
              </select>
            </label>
          </div>
          <label class="checkbox-row">
            <input type="checkbox" name="notifyEmployees">
            <span>Send a push alert to subscribed employees</span>
          </label>
          <p class="form-note">Important and urgent updates notify employees automatically. Routine updates stay in the feed unless you choose to send an alert.</p>
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
          <p>HR monitors delivery here. Employees enroll from the employee portal, and Webmaster runs direct push diagnostics.</p>
        </div>
      </div>
      ${renderAdminPushPanel()}
      <div class="panel-card">
        <p class="panel-copy">Important and urgent updates notify employees automatically through web push. Use this roster to see which employee devices are Active and which need cleanup.</p>
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
      ${renderHistoryTable(notices)}
    </section>
  `;
}

function renderHistoryTable(posts) {
  if (!posts.length) {
    return '<div class="empty-state">No Updates Yet.</div>';
  }

  return `
    <div class="admin-table-wrap">
      <table class="admin-table admin-table-history">
        <thead>
          <tr>
            <th>Published</th>
            <th>Title</th>
            <th>Category</th>
            <th>Priority</th>
            <th>Audience</th>
            <th>Alert</th>
            <th>Retention</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${posts.map((post) => renderHistoryTableRow(post)).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderHistoryTableRow(post) {
  const safePriority = priorityClass(post.priority);

  return `
    <tr>
      <td>
        <div class="admin-table-primary">${escapeHtml(formatDate(post.createdAt))}</div>
      </td>
      <td>
        <div class="admin-table-primary">${escapeHtml(post.title)}</div>
      </td>
      <td>
        <span class="admin-table-chip">${escapeHtml(post.type)}</span>
      </td>
      <td>
        <span class="priority-pill ${safePriority}">${escapeHtml(post.priority)}</span>
      </td>
      <td>
        <div class="admin-table-primary">${escapeHtml(post.audience || "All Employees")}</div>
      </td>
      <td>
        <span class="admin-table-chip ${post.notifyEmployees ? "is-info" : "is-muted"}">${escapeHtml(post.notifyEmployees ? "Sent" : "No")}</span>
      </td>
      <td>
        <div class="admin-table-primary">${escapeHtml(formatAlertRetentionLabel(post.alertRetention))}</div>
      </td>
      <td>
        <form class="admin-table-actions" data-delete-post-form>
          <input type="hidden" name="id" value="${escapeHtml(post.id)}">
          <button class="ghost-button" type="submit" data-delete-post="${escapeHtml(post.id)}" title="Delete Post">
            ${icon("delete")} Delete
          </button>
        </form>
      </td>
    </tr>
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
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("alert")} Security visibility</p>
          <h2>Recent auth events</h2>
          <p>Review the latest failed logins, throttles, and lockouts across HR, Webmaster, and employee sign-in.</p>
        </div>
        <span class="sync-pill">Persisted</span>
      </div>

      <section class="panel-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("lock")} Auth pressure</p>
            <h3>Current snapshot</h3>
            <p>These counters are drawn from the most recent persisted security events.</p>
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

function renderRoleSettingsHero(route) {
  const role = route === "webmaster" ? "Webmaster" : "HR";
  const passwordStatus = state.passwordChangeStatus?.[route] || null;

  return `
    <section class="panel-card settings-hero-card">
      <div class="settings-hero-grid">
        <div class="settings-hero-copy">
          <p class="eyebrow">${icon("lock")} Settings</p>
          <h2>${escapeHtml(role)} account settings</h2>
          <p>${escapeHtml(
            route === "webmaster"
              ? "Keep diagnostics and system review in the operational tabs. Use this space for identity, credential, and account maintenance."
              : "Keep publishing and employee operations in the working tabs. Use this space only for HR account and credential maintenance."
          )}</p>
        </div>
        <div class="settings-chip-grid" aria-label="${escapeHtml(role)} settings summary">
          <div class="settings-chip">
            <span>Surface</span>
            <strong>Settings Only</strong>
            <small>Sensitive controls stay out of the daily workflow.</small>
          </div>
          <div class="settings-chip">
            <span>Session rule</span>
            <strong>Contained</strong>
            <small>Other active sessions for this account are signed out after a password change.</small>
          </div>
          <div class="settings-chip">
            <span>Last password change</span>
            <strong>${escapeHtml(passwordStatus ? formatDate(passwordStatus.changedAt) : "Not changed in this session")}</strong>
            <small>${escapeHtml(passwordStatus ? "Verified in the current session." : "No local confirmation yet.")}</small>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderPrivilegedPasswordPanel(route) {
  const role = route === "webmaster" ? "Webmaster" : "HR";

  return `
    <section class="panel-card settings-credential-card" data-privileged-password-panel>
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("lock")} ${escapeHtml(role)} Credentials</p>
          <h3>Change ${escapeHtml(role)} Password</h3>
          <p>Update the password for this account.</p>
        </div>
      </div>
      <form class="auth-form" data-privileged-password-form data-role-route="${escapeHtml(route)}">
        <div class="composer-grid">
          <label class="field">
            <span>Current Password</span>
            <input name="currentPassword" type="password" minlength="10" required autocomplete="current-password" placeholder="Current ${escapeHtml(role)} Password">
          </label>
          <label class="field">
            <span>New Password</span>
            <input name="password" type="password" minlength="10" required autocomplete="new-password" placeholder="New ${escapeHtml(role)} Password">
          </label>
          <label class="field field-span-2">
            <span>Confirm New Password</span>
            <input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password" placeholder="Repeat The New Password">
          </label>
        </div>
        <div class="auth-form-actions">
          <button class="ghost-button" type="submit">${icon("lock")} Save New Password</button>
        </div>
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
          <p>Use Webmaster authority to rotate the HR password and immediately sign out existing HR sessions.</p>
        </div>
      </div>
      <form class="auth-form" data-webmaster-reset-hr-password-form>
        <div class="composer-grid">
          <label class="field">
            <span>New HR password</span>
            <input name="password" type="password" minlength="10" required autocomplete="new-password" placeholder="New HR password">
          </label>
          <label class="field">
            <span>Confirm new HR password</span>
            <input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password" placeholder="Repeat the new password">
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
      ${renderPrivilegedPasswordPanel("hr")}
    </section>
  `;
}

function renderWebmasterSettingsPanel() {
  return `
    <section class="panel-stack settings-shell">
      ${renderRoleSettingsHero("webmaster")}

      <section class="panel-card settings-context-card">
        <div class="panel-title panel-title-wide">
          <div>
            <p class="eyebrow">${icon("monitor")} Control boundary</p>
            <h3>Keep diagnostics separate from credentials</h3>
            <p>The webmaster console should feel analytical and calm. Credential changes belong in a separate settings surface so operators do not treat security actions like routine navigation.</p>
          </div>
        </div>

        <div class="settings-context-grid">
          <div class="settings-context-item">
            <span>Operational tabs</span>
            <strong>Overview, traffic, system, content</strong>
            <small>System review remains uncluttered and fast to scan.</small>
          </div>
          <div class="settings-context-item">
            <span>Credential action</span>
            <strong>Isolated under settings</strong>
            <small>Changing the webmaster password signs out other active sessions for that account immediately.</small>
          </div>
        </div>
      </section>

      ${renderPrivilegedPasswordPanel("webmaster")}
      ${renderWebmasterHrResetPanel()}
    </section>
  `;
}

function renderAdminAccessPanel() {
  return `
    <section class="panel-stack">
      ${renderEmployeeDirectoryPanel()}
      ${renderAdminAccountsPanel()}
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
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("chart")} Power Center</p>
          <h2>Webmaster overview</h2>
          <p>Quick status for the site, the host, and the copy-ready brief.</p>
        </div>
        <span class="sync-pill">${icon("check")} Live snapshot</span>
      </div>

      ${renderWebmasterExpandableCard({
        id: "overview-site-snapshot",
        eyebrow: "Site snapshot",
        title: "Routes, access, and last publish",
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
          ["HR route", urls.hr || `${window.location.origin}${routePath("hr")}`, "Publish console"],
          ["Employee route", urls.employee || `${window.location.origin}${routePath("employee")}`, "Read-only feed"],
          ["Latest Update", board.latestPost ? board.latestPost.title : "None", board.latestPost ? formatDate(board.latestPost.createdAt) : "No Posts Yet"],
          ["Push subs", String(notifications.pushSubscriptions || 0), "Web push enrollments"],
          ["Admin access", "Separated roles", "Distinct HR and Webmaster sessions"],
          ["Enrollment", "Employee-authenticated", "Employees must sign in before subscribing"],
          ["Health ping", formatDurationMs(probes.health || 0), "API round-trip"]
        ])
      })}

      ${renderWebmasterExpandableCard({
        id: "overview-host-snapshot",
        eyebrow: "Host snapshot",
        title: "Runtime and probe timings",
        description: "Check the active Node runtime, item counts, and how long each Webmaster probe took.",
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
          ["Summary fetch", formatDurationMs(probes.summary || 0), "Webmaster endpoint"],
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
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("refresh")} Traffic</p>
          <h2>Request activity</h2>
          <p>These counts show how the site is being used and where errors are happening.</p>
        </div>
      </div>

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
            ["Page views", String(traffic.totals?.pageViews || 0), "Employee, HR, and webmaster views"],
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
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("monitor")} System</p>
          <h2>Host and device diagnostics</h2>
          <p>Use this tab to see the server, browser, and performance environment behind the portal.</p>
        </div>
      </div>

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
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("board")} Content</p>
          <h2>Portal inventory</h2>
          <p>See what is live, what is urgent, and what is about to expire.</p>
        </div>
      </div>

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
          { label: "Alerts", value: String(board.alertPosts || 0) }
        ],
        body: `
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
        `
      })}

      ${renderWebmasterExpandableCard({
        id: "content-recent",
        eyebrow: "Latest posts",
        title: "Most recent activity",
        description: "Expand to inspect the newest published updates in the same order employees see them.",
        badge: "Recent",
        iconName: "news",
        summaryMetrics: [
          { label: "Count", value: String(board.recentPosts?.length || 0) },
          { label: "Latest", value: latestPost ? formatDate(latestPost.createdAt) : "None" },
          { label: "Type", value: latestPost?.type || "None" }
        ],
        body: `
          <div class="post-list compact">
            ${board.recentPosts?.length ? board.recentPosts.map((post) => renderNotice(post, false)).join("") : '<div class="empty-state compact">No updates yet.</div>'}
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
      <div class="panel-title panel-title-wide">
        <div>
          <p class="eyebrow">${icon("clipboard")} Codex</p>
          <h2>Copy the incident brief</h2>
          <p>Use these buttons to move the snapshot into Codex without rebuilding the context by hand.</p>
        </div>
      </div>

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
        ${brandBlock("Webmaster Command Center")}
        <div class="page-actions">
          <button class="ghost-button" type="button" data-route="launcher">${icon("home")} Launcher</button>
          <button class="ghost-button" type="button" data-route="employee">${icon("news")} Employee Feed</button>
          <button class="ghost-button" type="button" data-route="hr">${icon("users")} HR console</button>
          <button class="ghost-button" type="button" data-copy-webmaster-brief>${icon("clipboard")} Copy brief</button>
          <button class="ghost-button" type="button" data-refresh>${icon("refresh")} Refresh</button>
          <button class="ghost-button" type="button" data-admin-logout>${icon("lock")} Sign Out</button>
        </div>
      </header>

      ${renderAppUpdateBanner()}
      <section class="hero-strip hero-strip-webmaster" aria-label="Webmaster summary">
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
                  : activeWebmasterTab === "codex"
                    ? renderWebmasterCodexPanel()
                    : renderWebmasterSettingsPanel()
        }
      </section>
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
          <button class="ghost-button" type="button" data-admin-logout>${icon("lock")} Sign Out</button>
        </div>
      </header>

      ${renderAppUpdateBanner()}
      <section class="hero-strip" aria-label="HR summary">
        ${renderHrSummaryStatCard({ value: String(activeCount), label: "Active Updates", tab: "history", filter: "Active" })}
        ${renderHrSummaryStatCard({ value: String(urgentCount), label: "Urgent Alerts", tab: "history", filter: "Urgent" })}
        ${renderHrSummaryStatCard({ value: String(activeEmployeeCount), label: "Active Employees", tab: "share" })}
      </section>

      ${state.message ? `<div class="hr-banner ${escapeHtml(state.messageType)}">${escapeHtml(state.message)}</div>` : ""}

      ${renderTabBar(adminTabs, activeAdminTab, "hr", "HR sections")}

      <section class="panel-surface">
        ${
          activeAdminTab === "publish"
            ? renderAdminPublishPanel()
            : activeAdminTab === "share"
              ? renderAdminAccessPanel()
              : activeAdminTab === "history"
                ? renderAdminHistoryPanel()
                : renderAdminSettingsPanel()
        }
      </section>
    </main>
  `;
}

function setMessage(message, type = "") {
  state.message = message;
  state.messageType = type;
}

function openHrSummaryTarget(tab, filter = "") {
  activeAdminTab = tab || "publish";
  activeHistoryFilter = activeAdminTab === "history" ? (filter || "All") : "All";
  render();
}

window.openHrSummaryTarget = openHrSummaryTarget;

function clearMessageSoon() {
  window.setTimeout(() => {
    setMessage("");
    render();
  }, 2600);
}

async function routeTo(route) {
  const nextPath = routePath(route);
  state.authRecovery.hr = false;
  state.authRecovery.webmaster = false;
  resetAdminInviteState();

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
    if (!state.access.hr.authorized && currentInviteToken()) {
      await loadAdminInvitePreview("hr");
    } else {
      resetAdminInviteState();
    }
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
      : route === "webmaster"
          ? (state.access.webmaster.authorized ? renderWebmaster() : renderAdminAuthGate("webmaster"))
          : (state.access.employee.authorized ? renderEmployee() : renderEmployeeAuthGate());
  document.title = route === "launcher"
    ? APP_DISPLAY_TITLE
    : route === "hr"
    ? `${APP_DISPLAY_TITLE} HR`
    : route === "webmaster"
      ? `${APP_DISPLAY_TITLE} Webmaster`
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
    form.elements.audience.value = "All Employees";
    form.elements.alertRetention.value = "48h";
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
  const form = event.target;
  const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
  const data = Object.fromEntries(new FormData(form));
  const nextProfile = saveDeviceProfile({
    ...state.deviceProfile,
    employeeName: String(data.employeeName || data.label || "").trim()
  });
  const setup = buildEmployeeSetupState();
  const action = resolveDeviceSetupAction({
    submitterAction: submitter?.dataset.deviceAction,
    primaryActionId: setup.primaryAction.id
  });

  state.deviceProfile = nextProfile;
  render();

  try {
    if (action === "push") {
      await enablePushAlerts(nextProfile);
      render();
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("subscribed", String(Date.now()));
      window.location.replace(nextUrl.toString());
      return;
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
  const route = form.dataset.adminRoute === "webmaster" ? "webmaster" : "hr";
  const targetAccess = route === "webmaster" ? "webmaster" : "hr";
  const endpoint = route === "webmaster"
    ? (mode === "setup" ? "/api/webmaster/setup" : "/api/webmaster/login")
    : (mode === "setup" ? "/api/hr/setup" : "/api/hr/login");

  state.access[targetAccess] = {
    ...state.access[targetAccess],
    busy: true,
    error: ""
  };
  render();

  try {
    await requestJson(endpoint, {
      method: "POST",
      body: JSON.stringify(data)
    });
    await hydrateRoute();
    if (mode === "setup") {
      setMessage(
        route === "webmaster" ? "Webmaster credentials configured." : "HR credentials configured.",
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
  const route = currentRoute() === "webmaster" ? "webmaster" : "hr";
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
    clearInviteToken(result.preferredRoute === "webmaster" ? "webmaster" : route);
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
  const data = Object.fromEntries(new FormData(form));

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

async function handleCreateAdminSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
  const action = submitter?.dataset.adminCreateAction === "password" ? "password" : "invite";
  const payload = {
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    username: formData.get("username"),
    roles: formData.getAll("roles")
  };

  try {
    if (action === "password") {
      const password = String(formData.get("password") || "");

      if (password.length < 10) {
        throw new Error("Temporary password must be at least 10 characters.");
      }

      const result = await requestJson("/api/admin-users", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          password
        })
      });
      form.reset();
      const defaultHrCheckbox = form.querySelector('input[name="roles"][value="hr"]');
      if (defaultHrCheckbox) {
        defaultHrCheckbox.checked = true;
      }
      await refreshAdminData();
      setMessage("Admin account created with a temporary password.", "success");
      render();
      clearMessageSoon();
      return result;
    }

    const result = await requestJson("/api/admin-users/invite", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    form.reset();
    const defaultHrCheckbox = form.querySelector('input[name="roles"][value="hr"]');
    if (defaultHrCheckbox) {
      defaultHrCheckbox.checked = true;
    }
    await refreshAdminData();
    setMessage(
      result.emailDelivered === false
        ? "Admin account created, but the invitation email could not be sent."
        : "Admin invitation sent.",
      result.emailDelivered === false ? "warning" : "success"
    );
  } catch (error) {
    setMessage(error.message || "Could not create the admin account.");
  }

  render();
  clearMessageSoon();
}

async function handleUpdateAdminProfileSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const adminUserId = String(formData.get("adminUserId") || "");

  try {
    await requestJson(`/api/admin-users/${encodeURIComponent(adminUserId)}/profile`, {
      method: "POST",
      body: JSON.stringify({
        displayName: formData.get("displayName"),
        email: formData.get("email")
      })
    });
    await refreshAdminData();
    setMessage("Admin identity updated.", "success");
  } catch (error) {
    setMessage(error.message || "Could not update the admin identity.");
  }

  render();
  clearMessageSoon();
}

async function handleResendAdminInviteSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const adminUserId = String(formData.get("adminUserId") || "");

  try {
    const result = await requestJson(`/api/admin-users/${encodeURIComponent(adminUserId)}/invite`, {
      method: "POST"
    });
    await refreshAdminData();
    setMessage(
      result.emailDelivered === false
        ? "Invitation refreshed, but the email could not be sent."
        : "Invitation sent.",
      result.emailDelivered === false ? "warning" : "success"
    );
  } catch (error) {
    setMessage(error.message || "Could not send the invitation.");
  }

  render();
  clearMessageSoon();
}

async function handleAdminAccessSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const adminUserId = String(formData.get("adminUserId") || "");
  const active = String(formData.get("active") || "") === "true";

  try {
    await requestJson(`/api/admin-users/${encodeURIComponent(adminUserId)}/status`, {
      method: "POST",
      body: JSON.stringify({
        active
      })
    });
    await refreshAdminData();
    setMessage(active ? "Admin access restored." : "Admin access disabled.", "success");
  } catch (error) {
    setMessage(error.message || "Could not update admin access.");
  }

  render();
  clearMessageSoon();
}

async function handleResetAdminPasswordSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const adminUserId = String(formData.get("adminUserId") || "");

  try {
    await requestJson(`/api/admin-users/${encodeURIComponent(adminUserId)}/password`, {
      method: "POST",
      body: JSON.stringify({
        password: formData.get("password")
      })
    });
    form.reset();
    await refreshAdminData();
    setMessage("Admin password reset. Existing sessions were signed out.", "success");
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

async function handlePrivilegedPasswordChangeSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const route = form.dataset.roleRoute === "webmaster" ? "webmaster" : "hr";
  const role = route === "webmaster" ? "Webmaster" : "HR";
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

async function handleRevokeAdminSessionsSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const adminUserId = String(formData.get("adminUserId") || "");

  try {
    await requestJson(`/api/admin-users/${encodeURIComponent(adminUserId)}/sessions/revoke`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await refreshAdminData();
    setMessage("Admin sessions revoked.", "success");
  } catch (error) {
    setMessage(error.message || "Could not revoke admin sessions.");
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
  const copyWebmasterBriefButton = target.closest("[data-copy-webmaster-brief]");
  const copyWebmasterJsonButton = target.closest("[data-copy-webmaster-json]");
  const deleteButton = target.closest("[data-delete-post]");
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
      activeAdminTab = tabButton.dataset.tab || "publish";
    } else if (tabButton.dataset.tabGroup === "webmaster") {
      activeWebmasterTab = tabButton.dataset.tab || "overview";
    }
    render();
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
    const route = currentRoute() === "webmaster" ? "webmaster" : "hr";
    await requestJson(route === "webmaster" ? "/api/webmaster/logout" : "/api/hr/logout", {
      method: "POST",
      body: JSON.stringify({})
    });
    if (route === "webmaster") {
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

  if (event.target.matches("[data-create-admin-form]")) {
    await handleCreateAdminSubmit(event);
    return;
  }

  if (event.target.matches("[data-update-admin-profile-form]")) {
    await handleUpdateAdminProfileSubmit(event);
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

  if (event.target.matches("[data-resend-admin-invite-form]")) {
    await handleResendAdminInviteSubmit(event);
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

  if (event.target.matches("[data-revoke-employee-sessions-form]")) {
    await handleRevokeEmployeeSessionsSubmit(event);
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
} finally {
  state.loading = false;
  render();
  void checkForAppUpdate();
}





