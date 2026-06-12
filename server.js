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
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(__dirname, "data", "board.json");
const DATA_DIR = path.dirname(DATA_FILE);
const MAX_BODY_BYTES = 1_000_000;
const MAX_LOGO_DATA_URL_CHARS = 500_000;

const allowedTypes = new Set(["News", "Weather", "Shift", "Safety", "HR"]);
const allowedPriorities = new Set(["Normal", "Important", "Urgent"]);
const allowedWeatherLevels = new Set(["Clear", "Watch", "Warning"]);
const allowedLogoShapes = new Set(["rounded", "square", "circle"]);
const allowedCardStyles = new Set(["soft", "flat", "lifted"]);
const allowedBackgroundPatterns = new Set(["grid", "plain"]);

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

function defaultSettings() {
  return {
    companyName: "Company Board",
    boardSubtitle: "Work updates",
    logoUrl: "/assets/logo.svg",
    primaryColor: "#0f766e",
    accentColor: "#c94f3d",
    backgroundColor: "#f6f1e8",
    surfaceColor: "#fffdf8",
    textColor: "#17211f",
    logoShape: "rounded",
    cardStyle: "soft",
    backgroundPattern: "grid"
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
    }
  };
}

function cleanColor(value, fallback) {
  const color = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : fallback;
}

function cleanChoice(value, allowed, fallback) {
  const choice = String(value ?? "").trim();
  return allowed.has(choice) ? choice : fallback;
}

function cleanLogoUrl(value, fallback = "/assets/logo.svg") {
  const logoUrl = String(value ?? "").trim();
  if (!logoUrl) return fallback;
  if (logoUrl.startsWith("/") && !logoUrl.startsWith("//")) return logoUrl;

  if (logoUrl.startsWith("data:image/")) {
    const isAllowedImage = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(logoUrl);
    return isAllowedImage && logoUrl.length <= MAX_LOGO_DATA_URL_CHARS ? logoUrl : fallback;
  }

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
    backgroundColor: cleanColor(input.backgroundColor, defaults.backgroundColor),
    surfaceColor: cleanColor(input.surfaceColor, defaults.surfaceColor),
    textColor: cleanColor(input.textColor, defaults.textColor),
    logoShape: cleanChoice(input.logoShape, allowedLogoShapes, defaults.logoShape),
    cardStyle: cleanChoice(input.cardStyle, allowedCardStyles, defaults.cardStyle),
    backgroundPattern: cleanChoice(input.backgroundPattern, allowedBackgroundPatterns, defaults.backgroundPattern)
  };
}

function normalizeDataShape(data) {
  const seed = createSeedData();

  if (!data || typeof data !== "object") return seed;
  if (!Array.isArray(data.posts)) data.posts = [];
  if (!data.weather) data.weather = seed.weather;
  data.settings = normalizeSettings(data.settings || {});

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

function hasAdminAccess() {
  return true;
}

function requireAdmin() {
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

    if (req.method === "GET" && url.pathname === "/api/posts") {
      const data = await readData();
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

server.listen(PORT, () => {
  console.log(`Company Board running at http://localhost:${PORT}`);
});
