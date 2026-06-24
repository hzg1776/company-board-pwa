import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBoardStore, createSeedData, normalizeDataShape } from "../storage.js";

test("createSeedData returns a normalized board snapshot", () => {
  const seed = createSeedData();

  assert.equal(Array.isArray(seed.posts), true);
  assert.equal(seed.posts.length > 0, true);
  assert.equal(Array.isArray(seed.acknowledgements), true);
  assert.equal(typeof seed.weather.condition, "string");
  assert.equal(typeof seed.weather.level, "string");
  assert.equal(typeof seed.posts[0].notifyEmployees, "boolean");
});

test("createBoardStore defaults to local file storage", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "company-board-store-default-"));
  const dataFile = path.join(tempDir, "board.json");
  const store = createBoardStore({ dataFile });

  try {
    await store.init();
    assert.equal(store.backend, "file");
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeDataShape repairs legacy board data", () => {
  const normalized = normalizeDataShape({
    posts: [
      {
        id: "legacy-post",
        title: "   Legacy message   ",
        body: "First line\r\n\r\nSecond line",
        createdAt: "2026-06-12T12:00:00.000Z",
        expiresAt: "2026-06-30"
      }
    ],
    weather: {
      condition: "Light rain",
      temperature: "72°F"
    },
    settings: {
      theme: "old"
    }
  });

  assert.equal(normalized.posts.length, 1);
  assert.equal(normalized.posts[0].title, "Legacy message");
  assert.equal(normalized.posts[0].body, "First line\n\nSecond line");
  assert.equal(normalized.posts[0].notifyEmployees, false);
  assert.equal(normalized.weather.condition, "Light rain");
  assert.equal(normalized.settings, undefined);
});

test("normalizeDataShape preserves valid acknowledgement records", () => {
  const normalized = normalizeDataShape({
    posts: [],
    weather: {},
    acknowledgements: [
      {
        postId: "post-123",
        employeeId: "employee-456",
        employeeName: "Maria Lopez",
        username: "maria.lopez",
        acknowledgedAt: "2026-06-22T13:45:00.000Z"
      },
      {
        postId: "",
        employeeId: "employee-789",
        acknowledgedAt: "not-a-date"
      }
    ]
  });

  assert.deepEqual(normalized.acknowledgements, [
    {
      postId: "post-123",
      employeeId: "employee-456",
      employeeName: "Maria Lopez",
      username: "maria.lopez",
      acknowledgedAt: "2026-06-22T13:45:00.000Z"
    }
  ]);
});

test("file-backed store persists updates between reads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "company-board-store-"));
  const dataFile = path.join(tempDir, "board.json");
  const store = createBoardStore({ dataFile });

  try {
    await store.init();

    const firstRead = await store.readData();
    assert.equal(firstRead.posts.length, createSeedData().posts.length);

    await store.updateData((data) => {
      data.posts.unshift({
        id: "test-post",
        type: "News",
        priority: "Normal",
        notifyEmployees: true,
        title: "Database-backed board",
        body: "This post should persist across reads.",
        audience: "All employees",
        author: "HR",
        createdAt: "2026-06-12T15:00:00.000Z",
        expiresAt: ""
      });
      return data.posts[0];
    });

    const secondRead = await store.readData();
    assert.equal(secondRead.posts[0].title, "Database-backed board");
    assert.equal(secondRead.posts[0].body, "This post should persist across reads.");
    assert.equal(secondRead.posts[0].notifyEmployees, true);
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file-backed store seeds runtime data from a separate tracked seed file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "company-board-store-seed-"));
  const seedFile = path.join(tempDir, "board.seed.json");
  const dataFile = path.join(tempDir, "runtime", "data", "board.json");
  const trackedSeed = normalizeDataShape({
    posts: [
      {
        id: "seed-post-1",
        type: "News",
        priority: "Important",
        notifyEmployees: true,
        title: "Tracked seed message",
        body: "This content should initialize the runtime store.",
        audience: "All employees",
        author: "IT",
        createdAt: "2026-06-24T12:00:00.000Z",
        expiresAt: ""
      }
    ],
    weather: {
      condition: "Seeded weather",
      level: "Watch",
      temperature: "80°F"
    },
    acknowledgements: []
  });
  const store = createBoardStore({ dataFile, seedFile });

  try {
    await writeFile(seedFile, `${JSON.stringify(trackedSeed, null, 2)}\n`, "utf8");

    const firstRead = await store.readData();
    assert.deepEqual(firstRead, trackedSeed);

    await store.updateData((data) => {
      data.posts.unshift({
        id: "runtime-post-1",
        type: "HR",
        priority: "Normal",
        notifyEmployees: false,
        title: "Runtime-only update",
        body: "This should not modify the tracked seed file.",
        audience: "All employees",
        author: "HR",
        createdAt: "2026-06-24T13:00:00.000Z",
        expiresAt: ""
      });
      return data.posts[0];
    });

    const seedAfter = JSON.parse(await readFile(seedFile, "utf8"));
    const runtimeAfter = JSON.parse(await readFile(dataFile, "utf8"));

    assert.deepEqual(seedAfter, trackedSeed);
    assert.equal(runtimeAfter.posts[0].title, "Runtime-only update");
    assert.equal(runtimeAfter.posts[1].title, "Tracked seed message");
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
