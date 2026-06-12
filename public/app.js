const app = document.querySelector("#app");

const LOCAL_POSTS_KEY = "company-board-posts-v1";
const LOCAL_WEATHER_KEY = "company-board-weather-v1";
const ADMIN_PIN_KEY = "company-board-admin-pin";
const LOCAL_DEMO_PIN = "2468";

const filters = ["All", "Urgent", "Weather", "News", "Shift", "Safety", "HR"];
let activeFilter = "All";
let deferredInstallPrompt = null;

const state = {
  mode: "server",
  posts: [],
  weather: null,
  adminAuthed: Boolean(sessionStorage.getItem(ADMIN_PIN_KEY)),
  message: "",
  messageType: "",
  loading: true
};

const icons = {
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  bell: '<path d="M10 21h4"/><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  board: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  cloud: '<path d="M17.5 19H8a6 6 0 1 1 5.5-8.42A4.5 4.5 0 1 1 17.5 19Z"/>',
  delete: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
  filter: '<path d="M4 5h16"/><path d="M7 12h10"/><path d="M10 19h4"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
  install: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  megaphone: '<path d="m3 11 18-5v12L3 13v-2Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  news: '<path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18 5.3L21 8"/><path d="M21 3v5h-5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
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
  if (!value) return "No expiration";
  const dateOnlyMatch = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "No expiration";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: value.includes("T") ? "numeric" : undefined,
    minute: value.includes("T") ? "2-digit" : undefined
  }).format(date);
}

function currentDayLabel() {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric"
  }).format(new Date());
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

function defaultWeather() {
  return {
    condition: "Clear",
    temperature: "72 F",
    impact: "Normal operations.",
    level: "Clear",
    updatedAt: new Date().toISOString()
  };
}

function defaultPosts() {
  const now = new Date().toISOString();
  return [
    {
      id: "local-weather",
      type: "Weather",
      priority: "Important",
      title: "Rain expected during evening commute",
      body: "Keep walkways clear and use the south entrance if the front lot becomes congested.",
      audience: "All employees",
      author: "HR",
      createdAt: now,
      expiresAt: ""
    },
    {
      id: "local-news",
      type: "News",
      priority: "Normal",
      title: "Open enrollment reminder",
      body: "Benefits selections are due Friday. HR is available from 10:00 AM to 3:00 PM for questions.",
      audience: "All employees",
      author: "HR",
      createdAt: now,
      expiresAt: ""
    }
  ];
}

function currentRoute() {
  if (window.location.pathname === "/admin" || window.location.hash === "#admin") return "admin";
  return "employee";
}

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function adminPin() {
  return sessionStorage.getItem(ADMIN_PIN_KEY) || "";
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(adminPin() ? { "x-admin-pin": adminPin() } : {}),
      ...(options.headers || {})
    }
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || "Request failed.");
  }

  return body;
}

async function loadBoard() {
  state.loading = true;

  try {
    const [postsResult, weatherResult] = await Promise.all([
      requestJson("/api/posts"),
      requestJson("/api/weather")
    ]);

    state.posts = postsResult.posts || [];
    state.weather = weatherResult.weather || defaultWeather();
    state.mode = "server";
  } catch {
    state.posts = readLocal(LOCAL_POSTS_KEY, defaultPosts());
    state.weather = readLocal(LOCAL_WEATHER_KEY, defaultWeather());
    state.mode = "local";
  } finally {
    state.loading = false;
  }
}

async function createPost(payload) {
  if (state.mode === "server") {
    const result = await requestJson("/api/posts", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.posts.unshift(result.post);
    return;
  }

  if (adminPin() !== LOCAL_DEMO_PIN) throw new Error("Invalid HR PIN.");

  const post = {
    ...payload,
    id: crypto.randomUUID(),
    author: "HR",
    createdAt: new Date().toISOString()
  };
  state.posts.unshift(post);
  writeLocal(LOCAL_POSTS_KEY, state.posts);
}

async function deletePost(id) {
  if (state.mode === "server") {
    await requestJson(`/api/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
  } else {
    if (adminPin() !== LOCAL_DEMO_PIN) throw new Error("Invalid HR PIN.");
  }

  state.posts = state.posts.filter((post) => post.id !== id);
  writeLocal(LOCAL_POSTS_KEY, state.posts);
}

async function updateWeather(payload) {
  if (state.mode === "server") {
    const result = await requestJson("/api/weather", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    state.weather = result.weather;
    return;
  }

  if (adminPin() !== LOCAL_DEMO_PIN) throw new Error("Invalid HR PIN.");

  state.weather = {
    ...payload,
    updatedAt: new Date().toISOString()
  };
  writeLocal(LOCAL_WEATHER_KEY, state.weather);
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

function renderEmployee() {
  const weather = state.weather || defaultWeather();
  const notices = visiblePosts();
  const urgentCount = state.posts.filter((post) => post.priority === "Urgent" && !isExpired(post)).length;

  return `
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <img class="brand-mark" src="/assets/logo.svg" alt="">
          <div>
            <h1>Company Board</h1>
            <p>${escapeHtml(currentDayLabel())}</p>
          </div>
        </div>
        <div class="top-actions">
          <button class="button install-text" type="button" data-install title="Install app">
            ${icon("install")}<span>Install</span>
          </button>
          <button class="icon-button" type="button" data-route="admin" title="HR admin">
            ${icon("lock")}
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
            <h2>${escapeHtml(weather.condition)} · ${escapeHtml(weather.temperature)}</h2>
            <p>${escapeHtml(weather.impact)}</p>
          </div>
          <div class="quick-stats">
            <div class="quick-stat"><strong>${state.posts.filter((post) => !isExpired(post)).length}</strong><span>Active posts</span></div>
            <div class="quick-stat"><strong>${urgentCount}</strong><span>Urgent</span></div>
            <div class="quick-stat"><strong>${escapeHtml(state.mode === "server" ? "Live" : "Local")}</strong><span>Status</span></div>
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
  return `
    <main class="auth-shell">
      <section class="auth-card">
        <div class="brand">
          <img class="brand-mark" src="/assets/logo.svg" alt="">
          <div>
            <h1>Company Board</h1>
            <p>HR publishing</p>
          </div>
        </div>
        <h2>HR access</h2>
        <form data-login-form>
          <label class="field full">
            <span>PIN</span>
            <input name="pin" type="password" inputmode="numeric" autocomplete="current-password" required>
          </label>
          <div class="form-actions">
            <button class="ghost-button" type="button" data-route="employee">${icon("home")} Board</button>
            <button class="button" type="submit">${icon("lock")} Unlock</button>
          </div>
          <div class="message">${escapeHtml(state.message)}</div>
        </form>
      </section>
    </main>
  `;
}

function renderAdmin() {
  if (!state.adminAuthed) return renderAuth();

  const weather = state.weather || defaultWeather();
  const activeCount = state.posts.filter((post) => !isExpired(post)).length;
  const urgentCount = state.posts.filter((post) => post.priority === "Urgent" && !isExpired(post)).length;
  const latest = state.posts[0]?.createdAt ? formatDate(state.posts[0].createdAt) : "None";

  return `
    <main class="admin-shell">
      <section class="admin-layout">
        <aside class="admin-sidebar">
          <div class="brand">
            <img class="brand-mark" src="/assets/logo.svg" alt="">
            <div>
              <h1>Company Board</h1>
              <p>HR dashboard</p>
            </div>
          </div>
          <nav class="admin-nav" aria-label="Admin actions">
            <button class="ghost-button" type="button" data-route="employee">${icon("home")} Employee board</button>
            <button class="ghost-button" type="button" data-refresh>${icon("refresh")} Refresh</button>
            <button class="ghost-button" type="button" data-logout>${icon("logOut")} Sign out</button>
          </nav>
        </aside>

        <section class="admin-main">
          <section class="admin-summary" aria-label="Board summary">
            <div class="metric"><strong>${activeCount}</strong><span>Active posts</span></div>
            <div class="metric"><strong>${urgentCount}</strong><span>Urgent posts</span></div>
            <div class="metric"><strong>${escapeHtml(weather.level)}</strong><span>Weather level</span></div>
            <div class="metric"><strong>${escapeHtml(latest)}</strong><span>Latest post</span></div>
          </section>

          <section class="tool-grid">
            <section class="tool-panel">
              <div class="panel-title">
                <div>
                  <p class="eyebrow">${icon("megaphone")} Publish</p>
                  <h2>New update</h2>
                </div>
                <span class="sync-pill">${escapeHtml(state.mode === "server" ? "Live server" : "Local demo")}</span>
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

function routeTo(route) {
  const nextPath = route === "admin" ? "/admin" : "/employee";
  window.history.pushState({}, "", nextPath);
  render();
}

function render() {
  const route = currentRoute();
  document.body.dataset.route = route;
  app.innerHTML = state.loading ? '<main class="auth-shell"><section class="empty-state">Loading board...</section></main>' : route === "admin" ? renderAdmin() : renderEmployee();
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.target;
  const pin = new FormData(form).get("pin");
  sessionStorage.setItem(ADMIN_PIN_KEY, String(pin || ""));

  if (state.mode === "local" && pin !== LOCAL_DEMO_PIN) {
    sessionStorage.removeItem(ADMIN_PIN_KEY);
    state.adminAuthed = false;
    setMessage("Invalid HR PIN.");
    render();
    return;
  }

  try {
    if (state.mode === "server") {
      await requestJson("/api/admin/check");
    }

    state.adminAuthed = true;
    setMessage("");
  } catch {
    sessionStorage.removeItem(ADMIN_PIN_KEY);
    state.adminAuthed = false;
    setMessage("Invalid HR PIN.");
  }

  render();
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

async function installApp() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
}

app.addEventListener("click", async (event) => {
  const routeButton = event.target.closest("[data-route]");
  const filterButton = event.target.closest("[data-filter]");
  const deleteButton = event.target.closest("[data-delete-post]");

  if (routeButton) {
    routeTo(routeButton.dataset.route);
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
    await loadBoard();
    render();
    return;
  }

  if (event.target.closest("[data-logout]")) {
    sessionStorage.removeItem(ADMIN_PIN_KEY);
    state.adminAuthed = false;
    setMessage("");
    render();
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

  if (event.target.matches("[data-post-form]")) {
    await handlePostSubmit(event);
    return;
  }

  if (event.target.matches("[data-weather-form]")) {
    await handleWeatherSubmit(event);
  }
});

window.addEventListener("hashchange", render);
window.addEventListener("popstate", render);

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

await loadBoard();
render();
