import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const ADMIN_PIN = process.env.HR_PIN || (isProduction ? "" : "2468");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(__dirname, "data", "board.json");
const DATA_DIR = path.dirname(DATA_FILE);
const MAX_BODY_BYTES = 1_000_000;
const EMPLOYEE_SESSION_DAYS = 14;
const EMPLOYEE_ONLINE_WINDOW_MS = 5 * 60 * 1000;
const MAX_EMPLOYEE_EVENTS = 250;
const MAX_EMPLOYEE_SESSIONS = 1_000;

const allowedTypes = new Set(["News", "Weather", "Shift", "Safety", "HR"]);
const allowedPriorities = new Set(["Normal", "Important", "Urgent"]);
const allowedWeatherLevels = new Set(["Clear", "Watch", "Warning"]);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"]
]);

let writeQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function daysFromNowIso(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
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

function createSeedData() {
  const now = nowIso();

  return {
    settings: defaultSettings(),
    posts: [
      {
        id: "seed-weather-1",
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
        id: "seed-news-1",
        type: "News",
        priority: "Normal",
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
        title: "Loading dock inspection today",
        body: "Dock 2 is closed from 1:00 PM to 4:00 PM. Use Dock 1 for scheduled deliveries.",
        audience: "Operations",
        author: "HR",
        createdAt: now,
        expiresAt: ""
      }
    ],
    weather: {
      condition: "Light rain",
      temperature: "68 F",
      impact: "Wet floors possible near entrances. Use mats and cones where needed.",
      level: "Watch",
      updatedAt: now
    },
    employees: [],
    employeeSessions: [],
    employeeEvents: []
  };
}

function cleanColor(value, fallback) {
  const color = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : fallback;
}

function cleanLogoUrl(value, fallback = "/assets/logo.svg") {
  const logoUrl = cleanText(value, 300);
  if (!logoUrl) return fallback;
  if (logoUrl.startsWith("/") && !logoUrl.startsWith("//")) return logoUrl;

  try {
    const parsed = new URL(logoUrl);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return logoUrl;
  } catch {
    return fallback;
  }

  return fallback;
}

function normalizeSettings(input = {}) {
  const defaults = defaultSettings();
  return {
    companyName: cleanText(input.companyName || defaults.companyName, 70) || defaults.companyName,
    boardSubtitle: cleanText(input.boardSubtitle || defaults.boardSubtitle, 90) || defaults.boardSubtitle,
    logoUrl: cleanLogoUrl(input.logoUrl, defaults.logoUrl),
    primaryColor: cleanColor(input.primaryColor, defaults.primaryColor),
    accentColor: cleanColor(input.accentColor, defaults.accentColor),
    backgroundColor: cleanColor(input.backgroundColor, defaults.backgroundColor)
  };
}

function normalizeDataShape(data) {
  const seed = createSeedData();

  if (!data || typeof data !== "object") return seed;
  if (!Array.isArray(data.posts)) data.posts = [];
  if (!data.weather) data.weather = seed.weather;
  data.settings = normalizeSettings(data.settings || {});
  if (!Array.isArray(data.employees)) data.employees = [];
  if (!Array.isArray(data.employeeSessions)) data.employeeSessions = [];
  if (!Array.isArray(data.employeeEvents)) data.employeeEvents = [];

  data.employees = data.employees.map((employee) => ({
    id: cleanText(employee.id, 80) || crypto.randomUUID(),
    name: cleanText(employee.name, 80) || "Employee",
    username: cleanUsername(employee.username || employee.id || employee.name || "employee"),
    department: cleanText(employee.department, 80),
    active: employee.active !== false,
    pinHash: cleanText(employee.pinHash, 200),
    createdAt: employee.createdAt || nowIso(),
    updatedAt: employee.updatedAt || employee.createdAt || nowIso(),
    revokedAt: employee.revokedAt || "",
    lastLoginAt: employee.lastLoginAt || "",
    lastSeenAt: employee.lastSeenAt || ""
  }));

  data.employeeSessions = data.employeeSessions
    .filter((session) => session && typeof session === "object")
    .map((session) => ({
      id: cleanText(session.id, 80) || crypto.randomUUID(),
      employeeId: cleanText(session.employeeId, 80),
      tokenHash: cleanText(session.tokenHash, 100),
      createdAt: session.createdAt || nowIso(),
      expiresAt: session.expiresAt || daysFromNowIso(EMPLOYEE_SESSION_DAYS),
      lastSeenAt: session.lastSeenAt || session.createdAt || nowIso(),
      revokedAt: session.revokedAt || "",
      device: cleanText(session.device, 160)
    }))
    .slice(0, MAX_EMPLOYEE_SESSIONS);

  data.employeeEvents = data.employeeEvents
    .filter((event) => event && typeof event === "object")
    .map((event) => ({
      id: cleanText(event.id, 80) || crypto.randomUUID(),
      type: cleanText(event.type, 40) || "event",
      success: event.success !== false,
      employeeId: cleanText(event.employeeId, 80),
      employeeName: cleanText(event.employeeName, 80) || "Unknown",
      username: cleanText(event.username, 40),
      createdAt: event.createdAt || nowIso(),
      device: cleanText(event.device, 160)
    }))
    .slice(0, MAX_EMPLOYEE_EVENTS);

  return data;
}

async function ensureDataFile() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    await stat(DATA_FILE);
  } catch {
    await writeFile(DATA_FILE, `${JSON.stringify(createSeedData(), null, 2)}\n`, "utf8");
  }
}

async function readData() {
  await ensureDataFile();
  const raw = await readFile(DATA_FILE, "utf8");
  return normalizeDataShape(JSON.parse(raw));
}

async function writeData(data) {
  await mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${DATA_FILE}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempFile, DATA_FILE);
}

async function updateData(mutator) {
  const next = writeQueue.then(async () => {
    const data = await readData();
    const result = await mutator(data);
    await writeData(data);
    return result;
  });

  writeQueue = next.catch(() => {});
  return next;
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function appBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  }

  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`)
    .split(",")[0]
    .trim();
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim() || (req.socket.encrypted ? "https" : "http");

  return `${proto}://${host}`;
}

async function sendEmployeeQr(req, res) {
  const employeeUrl = `${appBaseUrl(req)}/employee`;
  const svg = await QRCode.toString(employeeUrl, {
    type: "svg",
    margin: 2,
    width: 320,
    color: {
      dark: "#17211f",
      light: "#fffdf8"
    }
  });

  res.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "no-store"
  });
  res.end(svg);
}

function apiError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function hasAdminAccess(req) {
  const providedPin = req.headers["x-admin-pin"];
  return typeof providedPin === "string" && providedPin === ADMIN_PIN;
}

function requireAdmin(req, res) {
  if (!hasAdminAccess(req)) {
    sendError(res, 401, "Invalid HR PIN.");
    return false;
  }

  return true;
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

function cleanUsername(value) {
  const username = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[._-]{2,}/g, ".")
    .slice(0, 32);

  return username || "employee";
}

function uniqueUsername(baseUsername, employees, currentEmployeeId = "") {
  const base = cleanUsername(baseUsername);
  const used = new Set(
    employees
      .filter((employee) => employee.id !== currentEmployeeId)
      .map((employee) => cleanUsername(employee.username))
  );

  if (!used.has(base)) return base;

  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}.${index}`.slice(0, 32);
    if (!used.has(candidate)) return candidate;
  }

  return `${base}.${crypto.randomUUID().slice(0, 6)}`.slice(0, 32);
}

function cleanPin(value) {
  const pin = String(value ?? "").trim();
  if (!/^\d{4,12}$/.test(pin)) {
    throw apiError("Employee PIN must be 4 to 12 numbers.");
  }

  return pin;
}

function createPinHash(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, 32).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPin(pin, pinHash) {
  const parts = String(pinHash || "").split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const [, salt, expectedHash] = parts;
  const actualHash = crypto.scryptSync(String(pin ?? ""), salt, 32);
  const expected = Buffer.from(expectedHash, "hex");

  return expected.length === actualHash.length && crypto.timingSafeEqual(actualHash, expected);
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function clientDevice(req) {
  return cleanText(req.headers["user-agent"], 160) || "Unknown device";
}

function isExpiredSession(session) {
  return Boolean(session.revokedAt) || new Date(session.expiresAt) <= new Date();
}

function isEmployeeOnline(employee) {
  if (!employee.lastSeenAt) return false;
  return Date.now() - new Date(employee.lastSeenAt).getTime() <= EMPLOYEE_ONLINE_WINDOW_MS;
}

function addEmployeeEvent(data, event) {
  data.employeeEvents.unshift({
    id: crypto.randomUUID(),
    type: event.type,
    success: event.success !== false,
    employeeId: event.employeeId || "",
    employeeName: event.employeeName || "Unknown",
    username: event.username || "",
    createdAt: nowIso(),
    device: event.device || ""
  });

  data.employeeEvents = data.employeeEvents.slice(0, MAX_EMPLOYEE_EVENTS);
}

function sanitizeEmployee(employee, data) {
  const activeSessions = data.employeeSessions.filter(
    (session) => session.employeeId === employee.id && !isExpiredSession(session)
  );

  return {
    id: employee.id,
    name: employee.name,
    username: employee.username,
    department: employee.department,
    active: employee.active,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
    revokedAt: employee.revokedAt,
    lastLoginAt: employee.lastLoginAt,
    lastSeenAt: employee.lastSeenAt,
    online: employee.active && isEmployeeOnline(employee),
    activeSessions: activeSessions.length
  };
}

function findEmployeeByIdentifier(data, identifier) {
  const cleanIdentifier = cleanUsername(identifier);
  const rawIdentifier = cleanText(identifier, 80).toLowerCase();

  return data.employees.find(
    (employee) =>
      cleanUsername(employee.username) === cleanIdentifier ||
      String(employee.id).toLowerCase() === rawIdentifier ||
      String(employee.name).toLowerCase() === rawIdentifier
  );
}

function employeeSessionFromRequest(req, data) {
  const token = req.headers["x-employee-session"];
  if (typeof token !== "string" || !token) return null;

  const tokenHash = hashSessionToken(token);
  const session = data.employeeSessions.find((candidate) => candidate.tokenHash === tokenHash);
  if (!session || isExpiredSession(session)) return null;

  const employee = data.employees.find((candidate) => candidate.id === session.employeeId);
  if (!employee || !employee.active) return null;

  return { employee, session };
}

function requireBoardAccess(req, res, data) {
  if (hasAdminAccess(req)) return { type: "admin" };

  const session = employeeSessionFromRequest(req, data);
  if (session) return { type: "employee", ...session };

  sendError(res, 401, "Employee sign-in is required.");
  return null;
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

function isValidExpiry(value) {
  return value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizePost(input) {
  const type = allowedTypes.has(input.type) ? input.type : "News";
  const priority = allowedPriorities.has(input.priority) ? input.priority : "Normal";
  const title = cleanText(input.title, 90);
  const body = cleanLongText(input.body, 700);
  const audience = cleanText(input.audience || "All employees", 80);
  const expiresAt = cleanText(input.expiresAt, 10);

  if (!title) throw new Error("Title is required.");
  if (!body) throw new Error("Message is required.");
  if (!isValidExpiry(expiresAt)) throw new Error("Expiration date must use YYYY-MM-DD.");

  return {
    id: crypto.randomUUID(),
    type,
    priority,
    title,
    body,
    audience,
    author: "HR",
    createdAt: nowIso(),
    expiresAt
  };
}

function normalizeWeather(input) {
  const level = allowedWeatherLevels.has(input.level) ? input.level : "Clear";
  const condition = cleanText(input.condition, 80);
  const temperature = cleanText(input.temperature, 20);
  const impact = cleanLongText(input.impact, 300);

  if (!condition) throw new Error("Weather condition is required.");
  if (!temperature) throw new Error("Temperature is required.");
  if (!impact) throw new Error("Weather impact is required.");

  return {
    condition,
    temperature,
    impact,
    level,
    updatedAt: nowIso()
  };
}

function normalizeEmployeeCreate(input, employees) {
  const name = cleanText(input.name, 80);
  const department = cleanText(input.department, 80);
  const username = uniqueUsername(input.username || name, employees);
  const pin = cleanPin(input.pin);
  const now = nowIso();

  if (!name) throw apiError("Employee name is required.");

  return {
    id: crypto.randomUUID(),
    name,
    username,
    department,
    active: true,
    pinHash: createPinHash(pin),
    createdAt: now,
    updatedAt: now,
    revokedAt: "",
    lastLoginAt: "",
    lastSeenAt: ""
  };
}

function updateEmployeeFromInput(employee, input, employees) {
  const now = nowIso();

  if (Object.hasOwn(input, "name")) {
    const name = cleanText(input.name, 80);
    if (!name) throw apiError("Employee name is required.");
    employee.name = name;
  }

  if (Object.hasOwn(input, "username")) {
    employee.username = uniqueUsername(input.username || employee.username, employees, employee.id);
  }

  if (Object.hasOwn(input, "department")) {
    employee.department = cleanText(input.department, 80);
  }

  if (Object.hasOwn(input, "pin") && String(input.pin ?? "").trim()) {
    employee.pinHash = createPinHash(cleanPin(input.pin));
  }

  if (Object.hasOwn(input, "active")) {
    employee.active = Boolean(input.active);
    employee.revokedAt = employee.active ? "" : now;
  }

  employee.updatedAt = now;
  return employee;
}

function sortedPosts(posts) {
  return [...posts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, now: nowIso() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings") {
      const data = await readData();
      sendJson(res, 200, { settings: data.settings });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings") {
      if (!requireAdmin(req, res)) return;

      const body = await readJsonBody(req);
      const settings = await updateData((data) => {
        data.settings = normalizeSettings({ ...data.settings, ...body });
        return data.settings;
      });

      sendJson(res, 200, { settings });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/check") {
      if (!requireAdmin(req, res)) return;
      const data = await readData();
      sendJson(res, 200, { ok: true, settings: data.settings });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/employees") {
      if (!requireAdmin(req, res)) return;

      const data = await readData();
      sendJson(res, 200, {
        employees: data.employees
          .map((employee) => sanitizeEmployee(employee, data))
          .sort((a, b) => a.name.localeCompare(b.name)),
        events: data.employeeEvents.slice(0, 60)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/employees") {
      if (!requireAdmin(req, res)) return;

      const body = await readJsonBody(req);
      const employee = await updateData((data) => {
        const created = normalizeEmployeeCreate(body, data.employees);
        data.employees.push(created);
        addEmployeeEvent(data, {
          type: "employee_created",
          employeeId: created.id,
          employeeName: created.name,
          username: created.username,
          device: clientDevice(req)
        });
        return sanitizeEmployee(created, data);
      });

      sendJson(res, 201, { employee });
      return;
    }

    const employeeAdminMatch = url.pathname.match(/^\/api\/admin\/employees\/([^/]+)$/);
    if (req.method === "PATCH" && employeeAdminMatch) {
      if (!requireAdmin(req, res)) return;

      const id = decodeURIComponent(employeeAdminMatch[1]);
      const body = await readJsonBody(req);
      const result = await updateData((data) => {
        const employee = data.employees.find((candidate) => candidate.id === id);
        if (!employee) return null;

        const wasActive = employee.active;
        const hadPinReset = Object.hasOwn(body, "pin") && String(body.pin ?? "").trim();
        updateEmployeeFromInput(employee, body, data.employees);

        if (!employee.active) {
          for (const session of data.employeeSessions) {
            if (session.employeeId === employee.id && !session.revokedAt) {
              session.revokedAt = nowIso();
            }
          }
        }

        if (wasActive !== employee.active) {
          addEmployeeEvent(data, {
            type: employee.active ? "employee_restored" : "employee_revoked",
            employeeId: employee.id,
            employeeName: employee.name,
            username: employee.username,
            device: clientDevice(req)
          });
        } else if (hadPinReset) {
          addEmployeeEvent(data, {
            type: "pin_reset",
            employeeId: employee.id,
            employeeName: employee.name,
            username: employee.username,
            device: clientDevice(req)
          });
        }

        return sanitizeEmployee(employee, data);
      });

      if (!result) {
        sendError(res, 404, "Employee not found.");
        return;
      }

      sendJson(res, 200, { employee: result });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/employee/login") {
      const body = await readJsonBody(req);
      const identifier = cleanText(body.identifier, 80);
      const pin = String(body.pin ?? "").trim();

      const result = await updateData((data) => {
        const employee = findEmployeeByIdentifier(data, identifier);
        const failedResult = (message, statusCode, eventEmployee = employee) => {
          addEmployeeEvent(data, {
            type: "login_failed",
            success: false,
            employeeId: eventEmployee?.id || "",
            employeeName: eventEmployee?.name || identifier || "Unknown",
            username: eventEmployee?.username || cleanUsername(identifier),
            device: clientDevice(req)
          });
          return { error: message, statusCode };
        };

        if (!identifier || !pin || !employee || !verifyPin(pin, employee.pinHash)) {
          return failedResult("Invalid employee ID or PIN.", 401);
        }

        if (!employee.active) {
          return failedResult("This employee access has been revoked.", 403, employee);
        }

        const now = nowIso();
        const sessionToken = crypto.randomBytes(32).toString("base64url");
        const session = {
          id: crypto.randomUUID(),
          employeeId: employee.id,
          tokenHash: hashSessionToken(sessionToken),
          createdAt: now,
          expiresAt: daysFromNowIso(EMPLOYEE_SESSION_DAYS),
          lastSeenAt: now,
          revokedAt: "",
          device: clientDevice(req)
        };

        employee.lastLoginAt = now;
        employee.lastSeenAt = now;
        employee.updatedAt = now;
        data.employeeSessions.unshift(session);
        data.employeeSessions = data.employeeSessions.slice(0, MAX_EMPLOYEE_SESSIONS);
        addEmployeeEvent(data, {
          type: "login",
          employeeId: employee.id,
          employeeName: employee.name,
          username: employee.username,
          device: session.device
        });

        return {
          sessionToken,
          employee: sanitizeEmployee(employee, data)
        };
      });

      if (result.error) {
        sendError(res, result.statusCode, result.error);
        return;
      }

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/employee/check") {
      const data = await readData();
      const session = employeeSessionFromRequest(req, data);

      if (!session) {
        sendError(res, 401, "Employee sign-in is required.");
        return;
      }

      sendJson(res, 200, { employee: sanitizeEmployee(session.employee, data) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/employee/presence") {
      const result = await updateData((data) => {
        const auth = employeeSessionFromRequest(req, data);
        if (!auth) return { error: "Employee sign-in is required.", statusCode: 401 };

        const now = nowIso();
        auth.session.lastSeenAt = now;
        auth.employee.lastSeenAt = now;
        auth.employee.updatedAt = now;

        return { employee: sanitizeEmployee(auth.employee, data) };
      });

      if (result.error) {
        sendError(res, result.statusCode, result.error);
        return;
      }

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/employee/logout") {
      const result = await updateData((data) => {
        const auth = employeeSessionFromRequest(req, data);
        if (!auth) return { ok: true };

        auth.session.revokedAt = nowIso();
        addEmployeeEvent(data, {
          type: "logout",
          employeeId: auth.employee.id,
          employeeName: auth.employee.name,
          username: auth.employee.username,
          device: auth.session.device || clientDevice(req)
        });

        return { ok: true };
      });

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/posts") {
      const data = await readData();
      if (!requireBoardAccess(req, res, data)) return;
      sendJson(res, 200, { posts: sortedPosts(data.posts) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/posts") {
      if (!requireAdmin(req, res)) return;

      const body = await readJsonBody(req);
      const post = normalizePost(body);

      await updateData((data) => {
        data.posts.unshift(post);
        return post;
      });

      sendJson(res, 201, { post });
      return;
    }

    const deleteMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      if (!requireAdmin(req, res)) return;

      const id = decodeURIComponent(deleteMatch[1]);
      const deleted = await updateData((data) => {
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
      const data = await readData();
      if (!requireBoardAccess(req, res, data)) return;
      sendJson(res, 200, { weather: data.weather });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/weather") {
      if (!requireAdmin(req, res)) return;

      const body = await readJsonBody(req);
      const weather = normalizeWeather(body);

      await updateData((data) => {
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
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/employee-qr.svg") {
    await sendEmployeeQr(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }

  await serveStatic(req, res, url);
});

await ensureDataFile();

if (!ADMIN_PIN) {
  console.error("HR_PIN is required when NODE_ENV=production.");
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`Company Board running at http://localhost:${PORT}`);
  if (!isProduction) {
    console.log("Default HR PIN is 2468. Set HR_PIN before production use.");
  }
});
