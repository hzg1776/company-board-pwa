import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBoardStore, createSeedData, normalizeDataShape } from "../storage.js";

test("createSeedData returns a full board snapshot", () => {
  const seed = createSeedData();

  assert.equal(seed.posts.length, 3);
  assert.equal(seed.weather.condition, "Weather not configured");
  assert.equal(seed.weather.level, "Clear");
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
  assert.equal(normalized.weather.condition, "Light rain");
  assert.equal(normalized.settings, undefined);
});

test("file-backed store persists updates between reads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "company-board-store-"));
  const dataFile = path.join(tempDir, "board.json");
  const store = createBoardStore({ dataFile });

  try {
    await store.init();

    const firstRead = await store.readData();
    assert.equal(firstRead.posts.length, 3);

    await store.updateData((data) => {
      data.posts.unshift({
        id: "test-post",
        type: "News",
        priority: "Normal",
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
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
