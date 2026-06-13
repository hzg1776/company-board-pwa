import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { createBoardStore } from "./storage.js";
import { resolveLiveWeather } from "./weather.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(__dirname, "data", "board.json");
const MAX_BODY_BYTES = 1_000_000;

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

function nowIso() {
  return new Date().toISOString();
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

function sortedPosts(posts) {
  return [...posts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, now: nowIso() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/check") {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/posts") {
      const data = await boardStore.readData();
      sendJson(res, 200, { posts: sortedPosts(data.posts) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/posts") {
      if (!requireAdmin(req, res)) return;

      const body = await readJsonBody(req);
      const post = normalizePost(body);

      await boardStore.updateData((data) => {
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
      const data = await boardStore.readData();
      sendJson(res, 200, { weather: data.weather });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/weather") {
      if (!requireAdmin(req, res)) return;

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

await boardStore.init();

server.listen(PORT, () => {
  console.log(`Company Board running at http://localhost:${PORT} (${boardStore.backend} storage)`);
});
