import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { createDefaultWeather, normalizeStoredWeather } from "./weather.js";

const BOARD_STATE_ID = 1;

const allowedTypes = new Set(["News", "Weather", "Shift", "Safety", "HR"]);
const allowedPriorities = new Set(["Normal", "Important", "Urgent"]);

function nowIso() {
  return new Date().toISOString();
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

function isValidIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isValidExpiry(value) {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function createSeedData() {
  const now = nowIso();

  return {
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
      ...createDefaultWeather()
    }
  };
}

function normalizeStoredPost(post = {}) {
  const title = cleanText(post.title, 90);
  const body = cleanLongText(post.body, 700);
  const expiresAt = cleanText(post.expiresAt, 10);

  return {
    id: cleanText(post.id, 128) || crypto.randomUUID(),
    type: allowedTypes.has(post.type) ? post.type : "News",
    priority: allowedPriorities.has(post.priority) ? post.priority : "Normal",
    title: title || "Untitled post",
    body,
    audience: cleanText(post.audience || "All employees", 80),
    author: cleanText(post.author || "HR", 80) || "HR",
    createdAt: isValidIsoDate(post.createdAt) ? post.createdAt : nowIso(),
    expiresAt: isValidExpiry(expiresAt) ? expiresAt : ""
  };
}

export function normalizeDataShape(data) {
  if (!data || typeof data !== "object") return createSeedData();

  const normalized = {
    ...data,
    posts: Array.isArray(data.posts) ? data.posts.map((post) => normalizeStoredPost(post)) : [],
    weather: normalizeStoredWeather(data.weather)
  };

  delete normalized.settings;
  return normalized;
}

async function ensureDirectory(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function writeFileAtomic(filePath, data) {
  await ensureDirectory(filePath);
  const tempFile = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

async function readFileSnapshot(dataFile) {
  await ensureDirectory(dataFile);

  try {
    const raw = await readFile(dataFile, "utf8");
    const data = normalizeDataShape(JSON.parse(raw));
    const normalizedRaw = `${JSON.stringify(data, null, 2)}\n`;

    if (normalizedRaw !== raw) {
      await writeFileAtomic(dataFile, data);
    }

    return data;
  } catch {
    const seed = createSeedData();
    await writeFileAtomic(dataFile, seed);
    return seed;
  }
}

async function readSeedSnapshot(dataFile) {
  try {
    const raw = await readFile(dataFile, "utf8");
    return normalizeDataShape(JSON.parse(raw));
  } catch {
    return createSeedData();
  }
}

function isLocalDatabaseUrl(connectionString) {
  try {
    const url = new URL(connectionString);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return /localhost|127\.0\.0\.1|::1/.test(connectionString);
  }
}

function createDatabasePool(connectionString) {
  const options = {
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000
  };

  if (!isLocalDatabaseUrl(connectionString)) {
    options.ssl = { rejectUnauthorized: false };
  }

  return new Pool(options);
}

async function ensureDatabaseSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS board_state (
      id integer PRIMARY KEY CHECK (id = 1),
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureDatabaseSeed(pool, dataFile) {
  await ensureDatabaseSchema(pool);

  const { rows } = await pool.query("SELECT data FROM board_state WHERE id = $1", [BOARD_STATE_ID]);
  if (rows.length > 0) {
    return normalizeDataShape(rows[0].data);
  }

  const seed = await readSeedSnapshot(dataFile);
  await pool.query(
    `
      INSERT INTO board_state (id, data, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (id) DO NOTHING
    `,
    [BOARD_STATE_ID, JSON.stringify(seed)]
  );

  return seed;
}

async function readDatabaseSnapshot(pool, dataFile) {
  return ensureDatabaseSeed(pool, dataFile);
}

async function writeDatabaseSnapshot(pool, dataFile, data) {
  await ensureDatabaseSchema(pool);
  const normalized = normalizeDataShape(data);

  await pool.query(
    `
      INSERT INTO board_state (id, data, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `,
    [BOARD_STATE_ID, JSON.stringify(normalized)]
  );

  return normalized;
}

async function updateDatabaseSnapshot(pool, dataFile, mutator) {
  await ensureDatabaseSchema(pool);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM board_state WHERE id = $1 FOR UPDATE", [BOARD_STATE_ID]);
    let data;

    if (rows.length > 0) {
      data = normalizeDataShape(rows[0].data);
    } else {
      const seed = await readSeedSnapshot(dataFile);
      await client.query(
        `
          INSERT INTO board_state (id, data, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (id) DO NOTHING
        `,
        [BOARD_STATE_ID, JSON.stringify(seed)]
      );

      const seeded = await client.query("SELECT data FROM board_state WHERE id = $1 FOR UPDATE", [BOARD_STATE_ID]);
      data = seeded.rows.length > 0 ? normalizeDataShape(seeded.rows[0].data) : seed;
    }

    const result = await mutator(data);

    await client.query(
      `
        UPDATE board_state
        SET data = $2::jsonb,
            updated_at = NOW()
        WHERE id = $1
      `,
      [BOARD_STATE_ID, JSON.stringify(data)]
    );

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createBoardStore({ dataFile, databaseUrl } = {}) {
  const hasDatabase = Boolean(databaseUrl);
  const pool = hasDatabase ? createDatabasePool(databaseUrl) : null;
  const backend = hasDatabase ? "postgres" : "file";
  let initPromise = null;
  let writeQueue = Promise.resolve();

  async function init() {
    if (!initPromise) {
      initPromise = (async () => {
        if (pool) {
          await ensureDatabaseSeed(pool, dataFile);
          return;
        }

        await readFileSnapshot(dataFile);
      })();
    }

    return initPromise;
  }

  async function readData() {
    await init();
    return pool ? readDatabaseSnapshot(pool, dataFile) : readFileSnapshot(dataFile);
  }

  async function writeData(data) {
    await init();

    const next = writeQueue.then(async () => {
      if (pool) {
        return writeDatabaseSnapshot(pool, dataFile, data);
      }

      const normalized = normalizeDataShape(data);
      await writeFileAtomic(dataFile, normalized);
      return normalized;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function updateData(mutator) {
    await init();

    const next = writeQueue.then(async () => {
      if (pool) {
        return updateDatabaseSnapshot(pool, dataFile, mutator);
      }

      const data = await readFileSnapshot(dataFile);
      const result = await mutator(data);
      await writeFileAtomic(dataFile, data);
      return result;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function close() {
    if (pool) {
      await pool.end();
    }
  }

  return {
    backend,
    init,
    readData,
    writeData,
    updateData,
    close
  };
}
