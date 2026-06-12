const app = document.querySelector("#app");

const ADMIN_PIN_KEY = "company-board-admin-pin";
const EMPLOYEE_SESSION_KEY = "company-board-employee-session-v1";
const EMPLOYEE_PROFILE_KEY = "company-board-employee-profile-v1";

const filters = ["All", "Urgent", "Weather", "News", "Shift", "Safety", "HR"];
let activeFilter = "All";
let deferredInstallPrompt = null;
let presenceTimer = null;

const state = {
  posts: [],
  weather: null,
  settings: defaultSettings(),
  employees: [],
  events: [],
  adminAuthed: Boolean(sessionStorage.getItem(ADMIN_PIN_KEY)),
  employeeAuthed: Boolean(sessionStorage.getItem(EMPLOYEE_SESSION_KEY)),
  employee: readSessionJson(EMPLOYEE_PROFILE_KEY, null),
  message: "",
  messageType: "",
  loading: true
};

const icons = {
  activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  bell: '<path d="M10 21h4"/><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  board: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  cloud: '<path d="M17.5 19H8a6 6 0 1 1 5.5-8.42A4.5 4.5 0 1 1 17.5 19Z"/>',
  delete: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
  filter: '<path d="M4 5h16"/><path d="M7 12h10"/><path d="M10 19h4"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
  install: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  key: '<path d="M21 2l-2 2"/><path d="m7.5 11.5 5 5"/><circle cx="7.5" cy="16.5" r="5.5"/><path d="m12 12 7-7 3 3-7 7"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  megaphone: '<path d="m3 11 18-5v12L3 13v-2Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  news: '<path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2a10 10 0 0 0 0 20h1.5a2.5 2.5 0 0 0 0-5H12a2 2 0 0 1 0-4h2a8 8 0 0 0 0-16Z"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18 5.3L21 8"/><path d="M21 3v5h-5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
  userX: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5"/><path d="m22 8-5 5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.board}</svg>`;
}

function defaultSettings() {
  return {
    companyName: "Company Board",
    boardSubtitle: "Work updates",
    logoUrl: "/assets/logo.svg",
    primaryColor: "#0f766e",
    accentColor: "#c94f3d",
    backgroundColor: "#f6f1e8"
  };
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

function readSessionJson(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeSessionJson(key, value) {
  sessionStorage.setItem(key, JSON.stringify(value));
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

function currentDayLabel() {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric"
  }).format(new Date());
}

function currentRoute() {
  if (window.location.pathname === "/admin" || window.location.hash === "#admin") return "admin";
  return "employee";
}

function adminPin() {
  return sessionStorage.getItem(ADMIN_PIN_KEY) || "";
}

function employeeSession() {
  return sessionStorage.getItem(EMPLOYEE_SESSION_KEY) || "";
}

function clearEmployeeSession() {
  sessionStorage.removeItem(EMPLOYEE_SESSION_KEY);
  sessionStorage.removeItem(EMPLOYEE_PROFILE_KEY);
  state.employeeAuthed = false;
  state.employee = null;
  state.posts = [];
  state.weather = null;
}

function hexToRgb(hex) {
  const clean = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function softColor(hex, alpha) {
  const rgb = hexToRgb(hex);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : hex;
}

function applySettings(settings) {
  state.settings = { ...defaultSettings(), ...(settings || {}) };
  const root = document.documentElement;
  root.style.setProperty("--teal", state.settings.primaryColor);
  root.style.setProperty("--teal-soft", softColor(state.settings.primaryColor, 0.14));
  root.style.setProperty("--coral", state.settings.accentColor);
  root.style.setProperty("--coral-soft", softColor(state.settings.accentColor, 0.14));
  root.style.setProperty("--paper", state.settings.backgroundColor);
  document.title = state.settings.companyName || "Company Board";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.settings.primaryColor);
}

function brandBlock(subtitle = state.settings.boardSubtitle) {
  return `
    <div class="brand">
      <img class="brand-mark" src="${escapeHtml(state.settings.logoUrl)}" alt="">
      <div>
        <h1>${escapeHtml(state.settings.companyName)}</h1>
        <p>${escapeHtml(subtitle)}</p>
      </div>
    </div>
  `;
}

async function requestJson(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(adminPin() ? { "x-admin-pin": adminPin() } : {}),
    ...(employeeSession() ? { "x-employee-session": employeeSession() } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || "Request failed.");
  }

  return body;
}

async function loadSettings() {
  const result = await requestJson("/api/settings");
  applySettings(result.settings);
}

async function loadBoard() {
  const [postsResult, weatherResult] = await Promise.all([
    requestJson("/api/posts"),
    requestJson("/api/weather")
  ]);

  state.posts = postsResult.posts || [];
  state.weather = weatherResult.weather || defaultWeather();
}

async function loadAdminControls() {
  const result = await requestJson("/api/admin/employees");
  state.employees = result.employees || [];
  state.events = result.events || [];
}

async function refreshAdminData() {
  await Promise.all([loadBoard(), loadAdminControls()]);
}

async function restoreAdminSession() {
  if (!adminPin()) return;

  try {
    const result = await requestJson("/api/admin/check");
    state.adminAuthed = true;
    if (result.settings) applySettings(result.settings);
  } catch {
    sessionStorage.removeItem(ADMIN_PIN_KEY);
    state.adminAuthed = false;
  }
}

async function restoreEmployeeSession() {
  if (!employeeSession()) return;

  try {
    const result = await requestJson("/api/employee/check");
    state.employeeAuthed = true;
    state.employee = result.employee;
    writeSessionJson(EMPLOYEE_PROFILE_KEY, result.employee);
  } catch {
    clearEmployeeSession();
  }
}

function defaultWeather() {
  return {
    condition: "Clear",
    temperature: "72 F",
    impact: "Normal operations.",
    level: "Clear",
    updatedAt: new Date().toISOString()
  };
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
    .filter((post) => {
      if (activeFilter === "All") return true;
      if (activeFilter === "Urgent") return post.priority === "Urgent";
      return post.type === activeFilter;
    })
    .sort((a, b) => {
      const urgency = { Urgent: 3, Important: 2, Normal: 1 };
      return (urgency[b.priority] || 1) - (urgency[a.priority] || 1) || new Date(b.createdAt) - new Date(a.createdAt);
    });
}

function weatherScene(level) {
  const normalizedLevel = String(level || "Clear").toLowerCase();
  const showRain = normalizedLevel !== "clear";
  const showWarning = normalizedLevel === "warning";

  return `
    <svg class="weather-scene" viewBox="0 0 360 210" role="img" aria-label="Weather status">
      <rect x="0" y="0" width="360" height="210" rx="8" fill="currentColor" opacity="0.08"></rect>
      <circle cx="88" cy="66" r="34" fill="currentColor" opacity="0.34"></circle>
      <path d="M126 138h142c29 0 52-20 52-45s-23-45-52-45c-11 0-21 3-29 8-15-24-43-39-75-39-48 0-86 32-86 72 0 3 0 6 1 9-22 4-39 20-39 40 0 23 21 42 46 42h40Z" fill="#fffdf8" stroke="currentColor" stroke-width="8"></path>
      ${showRain ? '<path d="M116 166v24M166 158v30M216 166v24M266 158v30" stroke="currentColor" stroke-width="9" stroke-linecap="round"></path>' : ""}
      ${showWarning ? '<path d="M288 40 330 112h-84l42-72Z" fill="#c94f3d"></path><path d="M288 66v23M288 103h.01" stroke="#fffdf8" stroke-width="8" stroke-linecap="round"></path>' : ""}
    </svg>
  `;
}

function renderNotice(post, includeControls = false) {
  const safePriority = priorityClass(post.priority);

  return `
    <article class="notice-card priority-${safePriority}">
      <div class="notice-meta">
        <span class="notice-type">${icon(typeIcon(post.type))}${escapeHtml(post.type)}</span>
        <span class="priority-pill ${safePriority}">${escapeHtml(post.priority)}</span>
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
          ? `<div class="post-controls">
              <button class="ghost-button" type="button" data-delete-post="${escapeHtml(post.id)}" title="Delete post">
                ${icon("delete")} Delete
              </button>
            </div>`
          : ""
      }
    </article>
  `;
}

function renderEmployeeAuth() {
  return `
    <main class="auth-shell">
      <section class="auth-card">
        ${brandBlock("Employee access")}
        <h2>Employee sign in</h2>
        <form data-employee-login-form>
          <div class="field full tap-field" data-focus-field>
            <label for="employee-identifier">Employee ID</label>
            <input id="employee-identifier" name="identifier" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" enterkeyhint="next" required value="owner" placeholder="Example: j.smith">
          </div>
          <div class="field full tap-field" data-focus-field>
            <label for="employee-pin">PIN</label>
            <input id="employee-pin" name="pin" type="tel" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" enterkeyhint="go" required placeholder="Numbers only">
          </div>
          <div class="pin-pad" aria-label="PIN keypad">
            ${["1", "2", "3", "4", "5", "6", "7", "8", "9"]
              .map((digit) => `<button class="pin-key" type="button" data-pin-digit="${digit}">${digit}</button>`)
              .join("")}
            <button class="pin-key muted" type="button" data-pin-clear>Clear</button>
            <button class="pin-key" type="button" data-pin-digit="0">0</button>
            <button class="pin-key muted" type="button" data-pin-backspace>Back</button>
          </div>
          <div class="form-actions">
            <button class="ghost-button" type="button" data-route="admin">${icon("lock")} HR admin</button>
            <button class="button" type="submit">${icon("key")} View board</button>
          </div>
          <div class="message ${state.messageType}">${escapeHtml(state.message)}</div>
        </form>
      </section>
    </main>
  `;
}

function renderEmployee() {
  if (!state.employeeAuthed) return renderEmployeeAuth();

  const weather = state.weather || defaultWeather();
  const notices = visiblePosts();
  const urgentCount = state.posts.filter((post) => post.priority === "Urgent" && !isExpired(post)).length;

  return `
    <main class="shell">
      <header class="topbar">
        ${brandBlock(currentDayLabel())}
        <div class="top-actions">
          <span class="employee-badge">${icon("userCheck")}${escapeHtml(state.employee?.name || "Employee")}</span>
          <button class="button install-text" type="button" data-install title="Install app">
            ${icon("install")}<span>Install</span>
          </button>
          <button class="icon-button" type="button" data-employee-logout title="Sign out">
            ${icon("logOut")}
          </button>
        </div>
      </header>

      <section class="employee-grid" aria-label="Employee notification board">
        <aside class="status-panel">
          <div class="weather-visual ${escapeHtml(String(weather.level || "Clear").toLowerCase())}">
            ${weatherScene(weather.level)}
          </div>
          <div class="weather-copy">
            <p class="eyebrow">${icon("cloud")} Weather</p>
            <h2>${escapeHtml(weather.condition)} - ${escapeHtml(weather.temperature)}</h2>
            <p>${escapeHtml(weather.impact)}</p>
          </div>
          <div class="quick-stats">
            <div class="quick-stat"><strong>${state.posts.filter((post) => !isExpired(post)).length}</strong><span>Active posts</span></div>
            <div class="quick-stat"><strong>${urgentCount}</strong><span>Urgent</span></div>
            <div class="quick-stat"><strong>Live</strong><span>Status</span></div>
          </div>
        </aside>

        <section class="board-column">
          <nav class="segment-bar" aria-label="Post filters">
            ${filters
              .map(
                (filter) => `
                  <button class="segment-button" type="button" data-filter="${filter}" aria-pressed="${activeFilter === filter}">
                    ${escapeHtml(filter)}
                  </button>
                `
              )
              .join("")}
          </nav>

          <div class="notice-list">
            ${
              notices.length
                ? notices.map((post) => renderNotice(post)).join("")
                : '<div class="empty-state">No active notices in this view.</div>'
            }
          </div>
        </section>
      </section>
    </main>
  `;
}

function renderAuth() {
  const employeeLink = `${window.location.origin}/employee`;

  return `
    <main class="auth-shell">
      <section class="auth-card">
        ${brandBlock("HR publishing")}
        <h2>HR access</h2>
        <form data-login-form>
          <div class="field full tap-field" data-focus-field>
            <label for="hr-pin">PIN</label>
            <input id="hr-pin" name="pin" type="tel" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" enterkeyhint="go" required>
          </div>
          <div class="form-actions">
            <button class="ghost-button" type="button" data-route="employee">${icon("home")} Employee login</button>
            <button class="button" type="submit">${icon("lock")} Unlock</button>
          </div>
          <div class="message ${state.messageType}">${escapeHtml(state.message)}</div>
        </form>
        <section class="qr-panel" aria-label="Employee portal QR code">
          <div>
            <p class="eyebrow">${icon("users")} Employee access</p>
            <h2>Scan for employee login</h2>
            <p>Employees scan this code, then use their assigned employee ID and PIN.</p>
          </div>
          <div class="qr-box">
            <img src="/employee-qr.svg" alt="QR code for employee portal">
          </div>
          <a class="employee-link" href="/employee">${escapeHtml(employeeLink)}</a>
        </section>
      </section>
    </main>
  `;
}

function renderBrandingPanel() {
  const settings = state.settings;

  return `
    <section class="tool-panel">
      <div class="panel-title">
        <div>
          <p class="eyebrow">${icon("palette")} Brand</p>
          <h2>Company look</h2>
          <p>Update the logo, name, and colors employees see.</p>
        </div>
      </div>
      <form data-branding-form>
        <div class="form-grid">
          <label class="field">
            <span>Company name</span>
            <input name="companyName" maxlength="70" value="${escapeHtml(settings.companyName)}" required>
          </label>
          <label class="field">
            <span>Board subtitle</span>
            <input name="boardSubtitle" maxlength="90" value="${escapeHtml(settings.boardSubtitle)}">
          </label>
          <label class="field full">
            <span>Logo URL</span>
            <input name="logoUrl" maxlength="300" value="${escapeHtml(settings.logoUrl)}" placeholder="https://example.com/logo.png">
          </label>
          <label class="field color-field">
            <span>Main color</span>
            <input name="primaryColor" type="color" value="${escapeHtml(settings.primaryColor)}">
          </label>
          <label class="field color-field">
            <span>Alert color</span>
            <input name="accentColor" type="color" value="${escapeHtml(settings.accentColor)}">
          </label>
          <label class="field color-field">
            <span>Background</span>
            <input name="backgroundColor" type="color" value="${escapeHtml(settings.backgroundColor)}">
          </label>
        </div>
        <div class="form-actions">
          <button class="button secondary" type="submit">${icon("palette")} Save brand</button>
        </div>
      </form>
    </section>
  `;
}

function renderEmployeeAccessPanel() {
  return `
    <section class="tool-panel">
      <div class="panel-title">
        <div>
          <p class="eyebrow">${icon("key")} Access</p>
          <h2>Employee PINs</h2>
          <p>Create employee access and revoke it when needed.</p>
        </div>
      </div>
      <form data-employee-form>
        <div class="form-grid compact-grid">
          <label class="field">
            <span>Name</span>
            <input name="name" maxlength="80" required placeholder="Employee name">
          </label>
          <label class="field">
            <span>Employee ID</span>
            <input name="username" maxlength="32" placeholder="j.smith">
          </label>
          <label class="field">
            <span>PIN</span>
            <input name="pin" type="tel" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="12" required placeholder="4-12 numbers">
          </label>
          <label class="field">
            <span>Department</span>
            <input name="department" maxlength="80" placeholder="Operations">
          </label>
        </div>
        <div class="form-actions">
          <button class="button" type="submit">${icon("userCheck")} Add employee</button>
        </div>
      </form>
      <div class="employee-list">
        ${
          state.employees.length
            ? state.employees.map((employee) => renderEmployeeRow(employee)).join("")
            : '<div class="empty-state small">No employee access records yet.</div>'
        }
      </div>
    </section>
  `;
}

function renderEmployeeRow(employee) {
  const status = !employee.active ? "Revoked" : employee.online ? "Online" : "Offline";
  const statusClass = !employee.active ? "revoked" : employee.online ? "online" : "offline";

  return `
    <article class="employee-row">
      <div>
        <div class="employee-row-title">
          <strong>${escapeHtml(employee.name)}</strong>
          <span class="status-pill ${statusClass}">${escapeHtml(status)}</span>
        </div>
        <p>@${escapeHtml(employee.username)}${employee.department ? ` - ${escapeHtml(employee.department)}` : ""}</p>
        <p>Last seen: ${escapeHtml(formatDate(employee.lastSeenAt))}</p>
      </div>
      <div class="row-actions">
        <button class="ghost-button" type="button" data-employee-action="reset-pin" data-employee-id="${escapeHtml(employee.id)}">${icon("key")} Reset PIN</button>
        <button class="ghost-button ${employee.active ? "danger-text" : ""}" type="button" data-employee-action="${employee.active ? "revoke" : "restore"}" data-employee-id="${escapeHtml(employee.id)}">
          ${employee.active ? icon("userX") + " Revoke" : icon("userCheck") + " Restore"}
        </button>
      </div>
    </article>
  `;
}

function eventLabel(type) {
  return {
    employee_created: "Employee created",
    employee_restored: "Access restored",
    employee_revoked: "Access revoked",
    login: "Employee login",
    login_failed: "Failed login",
    logout: "Employee logout",
    pin_reset: "PIN reset"
  }[type] || "Employee activity";
}

function renderActivityPanel() {
  return `
    <section class="tool-panel">
      <div class="panel-title">
        <div>
          <p class="eyebrow">${icon("activity")} Activity</p>
          <h2>Employee access log</h2>
        </div>
      </div>
      <div class="activity-list">
        ${
          state.events.length
            ? state.events
                .map(
                  (event) => `
                    <div class="activity-row ${event.success ? "" : "failed"}">
                      <div>
                        <strong>${escapeHtml(eventLabel(event.type))}</strong>
                        <p>${escapeHtml(event.employeeName)}${event.username ? ` (@${escapeHtml(event.username)})` : ""}</p>
                      </div>
                      <span>${escapeHtml(formatDate(event.createdAt))}</span>
                    </div>
                  `
                )
                .join("")
            : '<div class="empty-state small">No employee activity yet.</div>'
        }
      </div>
    </section>
  `;
}

function renderAdmin() {
  if (!state.adminAuthed) return renderAuth();

  const weather = state.weather || defaultWeather();
  const activeCount = state.posts.filter((post) => !isExpired(post)).length;
  const onlineEmployees = state.employees.filter((employee) => employee.online).length;
  const activeEmployees = state.employees.filter((employee) => employee.active).length;
  const latest = state.posts[0]?.createdAt ? formatDate(state.posts[0].createdAt) : "None";

  return `
    <main class="admin-shell">
      <section class="admin-layout">
        <aside class="admin-sidebar">
          ${brandBlock("HR dashboard")}
          <nav class="admin-nav" aria-label="Admin actions">
            <button class="ghost-button" type="button" data-route="employee">${icon("home")} Employee login</button>
            <button class="ghost-button" type="button" data-refresh>${icon("refresh")} Refresh</button>
            <button class="ghost-button" type="button" data-logout>${icon("logOut")} Sign out</button>
          </nav>
        </aside>

        <section class="admin-main">
          <section class="admin-summary" aria-label="Board summary">
            <div class="metric"><strong>${activeCount}</strong><span>Active posts</span></div>
            <div class="metric"><strong>${onlineEmployees}</strong><span>Employees online</span></div>
            <div class="metric"><strong>${activeEmployees}</strong><span>Active employees</span></div>
            <div class="metric"><strong>${escapeHtml(latest)}</strong><span>Latest post</span></div>
          </section>

          <section class="tool-grid">
            ${renderBrandingPanel()}
            ${renderEmployeeAccessPanel()}
          </section>

          <section class="tool-grid">
            <section class="tool-panel">
              <div class="panel-title">
                <div>
                  <p class="eyebrow">${icon("megaphone")} Publish</p>
                  <h2>New update</h2>
                </div>
                <span class="sync-pill">Live server</span>
              </div>
              <form data-post-form>
                <div class="form-grid">
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
                  <label class="field full">
                    <span>Title</span>
                    <input name="title" maxlength="90" required placeholder="Short headline">
                  </label>
                  <label class="field full">
                    <span>Message</span>
                    <textarea name="body" maxlength="700" required placeholder="What employees need to know"></textarea>
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
                <div class="form-actions">
                  <button class="button" type="submit">${icon("send")} Publish</button>
                </div>
                <div class="message ${state.messageType}">${escapeHtml(state.message)}</div>
              </form>
            </section>

            <section class="tool-panel">
              <div class="panel-title">
                <div>
                  <p class="eyebrow">${icon("cloud")} Weather</p>
                  <h2>Current status</h2>
                </div>
              </div>
              <form data-weather-form>
                <div class="form-grid">
                  <label class="field">
                    <span>Level</span>
                    <select name="level">
                      ${["Clear", "Watch", "Warning"]
                        .map((level) => `<option ${weather.level === level ? "selected" : ""}>${level}</option>`)
                        .join("")}
                    </select>
                  </label>
                  <label class="field">
                    <span>Temperature</span>
                    <input name="temperature" maxlength="20" value="${escapeHtml(weather.temperature)}" required>
                  </label>
                  <label class="field full">
                    <span>Condition</span>
                    <input name="condition" maxlength="80" value="${escapeHtml(weather.condition)}" required>
                  </label>
                  <label class="field full">
                    <span>Impact</span>
                    <textarea name="impact" maxlength="300" required>${escapeHtml(weather.impact)}</textarea>
                  </label>
                </div>
                <div class="form-actions">
                  <button class="button secondary" type="submit">${icon("cloud")} Update</button>
                </div>
              </form>
            </section>
          </section>

          ${renderActivityPanel()}

          <section class="tool-panel">
            <div class="panel-title">
              <div>
                <p class="eyebrow">${icon("board")} Board</p>
                <h2>Published updates</h2>
              </div>
            </div>
            <div class="post-list">
              ${
                state.posts.length
                  ? state.posts.map((post) => renderNotice(post, true)).join("")
                  : '<div class="empty-state">No posts yet.</div>'
              }
            </div>
          </section>
        </section>
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
  const nextPath = route === "admin" ? "/admin" : "/employee";
  window.history.pushState({}, "", nextPath);
  await hydrateRoute();
  render();
}

async function hydrateRoute() {
  const route = currentRoute();

  if (route === "admin") {
    await restoreAdminSession();
    if (state.adminAuthed) await refreshAdminData();
    return;
  }

  await restoreEmployeeSession();
  if (state.employeeAuthed) await loadBoard();
}

function syncPresenceTimer() {
  if (presenceTimer) {
    window.clearInterval(presenceTimer);
    presenceTimer = null;
  }

  if (!state.employeeAuthed || currentRoute() !== "employee") return;

  sendPresence();
  presenceTimer = window.setInterval(sendPresence, 60_000);
}

async function sendPresence() {
  if (!state.employeeAuthed || !employeeSession()) return;

  try {
    const result = await requestJson("/api/employee/presence", { method: "POST" });
    state.employee = result.employee || state.employee;
    if (state.employee) writeSessionJson(EMPLOYEE_PROFILE_KEY, state.employee);
  } catch {
    clearEmployeeSession();
    render();
  }
}

function render() {
  const route = currentRoute();
  document.body.dataset.route = route;
  app.innerHTML = state.loading
    ? '<main class="auth-shell"><section class="empty-state">Loading board...</section></main>'
    : route === "admin"
      ? renderAdmin()
      : renderEmployee();
  syncPresenceTimer();
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.target;
  const pin = String(new FormData(form).get("pin") || "").trim();

  if (!pin) {
    setMessage("Enter the HR PIN.");
    render();
    return;
  }

  sessionStorage.setItem(ADMIN_PIN_KEY, pin);

  try {
    const result = await requestJson("/api/admin/check");
    state.adminAuthed = true;
    if (result.settings) applySettings(result.settings);
    setMessage("");
  } catch (error) {
    sessionStorage.removeItem(ADMIN_PIN_KEY);
    state.adminAuthed = false;
    setMessage(error.message || "That HR PIN did not work.");
    render();
    return;
  }

  render();

  try {
    await refreshAdminData();
  } catch (error) {
    setMessage(error.message || "Signed in, but dashboard data could not load. Tap Refresh.");
  }

  render();
}

async function handleEmployeeLogin(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  try {
    const result = await requestJson("/api/employee/login", {
      method: "POST",
      body: JSON.stringify(data)
    });
    sessionStorage.setItem(EMPLOYEE_SESSION_KEY, result.sessionToken);
    writeSessionJson(EMPLOYEE_PROFILE_KEY, result.employee);
    state.employeeAuthed = true;
    state.employee = result.employee;
    await loadBoard();
    setMessage("");
  } catch (error) {
    clearEmployeeSession();
    setMessage(error.message || "Could not sign in.");
  }

  render();
}

async function createPost(payload) {
  const result = await requestJson("/api/posts", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  state.posts.unshift(result.post);
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

async function handlePostSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  try {
    await createPost(data);
    form.reset();
    form.elements.audience.value = "All employees";
    setMessage("Published.", "success");
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
    setMessage("Weather updated.", "success");
  } catch (error) {
    setMessage(error.message || "Could not update weather.");
  }

  render();
  clearMessageSoon();
}

async function handleBrandingSubmit(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));

  try {
    const result = await requestJson("/api/settings", {
      method: "PUT",
      body: JSON.stringify(data)
    });
    applySettings(result.settings);
    setMessage("Branding saved.", "success");
  } catch (error) {
    setMessage(error.message || "Could not save branding.");
  }

  render();
  clearMessageSoon();
}

async function handleEmployeeSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  try {
    await requestJson("/api/admin/employees", {
      method: "POST",
      body: JSON.stringify(data)
    });
    form.reset();
    await loadAdminControls();
    setMessage("Employee access created.", "success");
  } catch (error) {
    setMessage(error.message || "Could not create employee access.");
  }

  render();
  clearMessageSoon();
}

async function updateEmployeeAccess(id, payload) {
  await requestJson(`/api/admin/employees/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  await loadAdminControls();
}

async function handleEmployeeAction(button) {
  const employee = state.employees.find((candidate) => candidate.id === button.dataset.employeeId);
  if (!employee) return;

  try {
    if (button.dataset.employeeAction === "reset-pin") {
      const pin = window.prompt(`New PIN for ${employee.name}`);
      if (!pin) return;
      await updateEmployeeAccess(employee.id, { pin });
      setMessage("PIN reset.", "success");
    }

    if (button.dataset.employeeAction === "revoke") {
      if (!window.confirm(`Revoke employee board access for ${employee.name}?`)) return;
      await updateEmployeeAccess(employee.id, { active: false });
      setMessage("Access revoked.", "success");
    }

    if (button.dataset.employeeAction === "restore") {
      await updateEmployeeAccess(employee.id, { active: true });
      setMessage("Access restored.", "success");
    }
  } catch (error) {
    setMessage(error.message || "Could not update employee access.");
  }

  render();
  clearMessageSoon();
}

async function installApp() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
}

async function employeeLogout() {
  try {
    await requestJson("/api/employee/logout", { method: "POST" });
  } catch {
    // The local session still needs to be cleared if the server is unavailable.
  }

  clearEmployeeSession();
  setMessage("");
  render();
}

app.addEventListener("click", async (event) => {
  if (event.target.closest("input, select, textarea, label")) return;

  const routeButton = event.target.closest("[data-route]");
  const filterButton = event.target.closest("[data-filter]");
  const deleteButton = event.target.closest("[data-delete-post]");
  const employeeAction = event.target.closest("[data-employee-action]");
  const pinDigitButton = event.target.closest("[data-pin-digit]");
  const pinBackspaceButton = event.target.closest("[data-pin-backspace]");
  const pinClearButton = event.target.closest("[data-pin-clear]");

  if (pinDigitButton || pinBackspaceButton || pinClearButton) {
    const pinInput = document.querySelector("#employee-pin");
    if (!pinInput) return;

    if (pinDigitButton && pinInput.value.length < 12) {
      pinInput.value += pinDigitButton.dataset.pinDigit;
    }

    if (pinBackspaceButton) {
      pinInput.value = pinInput.value.slice(0, -1);
    }

    if (pinClearButton) {
      pinInput.value = "";
    }

    return;
  }

  if (routeButton) {
    await routeTo(routeButton.dataset.route);
    return;
  }

  if (filterButton) {
    activeFilter = filterButton.dataset.filter;
    render();
    return;
  }

  if (event.target.closest("[data-install]")) {
    await installApp();
    return;
  }

  if (event.target.closest("[data-refresh]")) {
    await refreshAdminData();
    render();
    return;
  }

  if (event.target.closest("[data-logout]")) {
    sessionStorage.removeItem(ADMIN_PIN_KEY);
    state.adminAuthed = false;
    state.posts = [];
    state.employees = [];
    state.events = [];
    setMessage("");
    render();
    return;
  }

  if (event.target.closest("[data-employee-logout]")) {
    await employeeLogout();
    return;
  }

  if (employeeAction) {
    await handleEmployeeAction(employeeAction);
    return;
  }

  if (deleteButton) {
    try {
      await deletePost(deleteButton.dataset.deletePost);
      setMessage("Deleted.", "success");
    } catch (error) {
      setMessage(error.message || "Could not delete post.");
    }

    render();
    clearMessageSoon();
  }
});

app.addEventListener("submit", async (event) => {
  if (event.target.matches("[data-login-form]")) {
    await handleLogin(event);
    return;
  }

  if (event.target.matches("[data-employee-login-form]")) {
    await handleEmployeeLogin(event);
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

  if (event.target.matches("[data-branding-form]")) {
    await handleBrandingSubmit(event);
    return;
  }

  if (event.target.matches("[data-employee-form]")) {
    await handleEmployeeSubmit(event);
  }
});

window.addEventListener("hashchange", async () => {
  await hydrateRoute();
  render();
});

window.addEventListener("popstate", async () => {
  await hydrateRoute();
  render();
});

window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sendPresence();
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  render();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

try {
  await loadSettings();
  await hydrateRoute();
} catch (error) {
  setMessage(error.message || "Could not load the app.");
} finally {
  state.loading = false;
  render();
}
