import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAnalyticsStore } from "../analytics.js";

test("createAnalyticsStore records request traffic", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "company-board-analytics-"));
  const dataFile = path.join(tempDir, "analytics.json");
  const store = createAnalyticsStore({ dataFile });

  try {
    await store.init();

    await store.recordRequest({
      at: "2026-06-14T12:00:00.000Z",
      method: "GET",
      pathname: "/palzivalerts/employee",
      kind: "page",
      statusCode: 200,
      durationMs: 24,
      userAgent: "Test Agent"
    });

    await store.recordRequest({
      at: "2026-06-14T12:01:00.000Z",
      method: "POST",
      pathname: "/api/posts",
      kind: "api",
      statusCode: 500,
      durationMs: 61,
      error: "Boom"
    });

    const data = await store.readData();

    assert.equal(data.totals.requests, 2);
    assert.equal(data.totals.pageViews, 1);
    assert.equal(data.totals.apiRequests, 1);
    assert.equal(data.totals.successfulRequests, 1);
    assert.equal(data.totals.serverErrors, 1);
    assert.equal(data.recentRequests[0].pathname, "/api/posts");
    assert.equal(data.recentErrors[0].error, "Boom");
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
