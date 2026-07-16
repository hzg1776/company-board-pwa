import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const MATRIX_PATH = path.resolve("docs/security/ASVS_5.0_LEVEL_2_MATRIX.csv");
const OPERATIONAL_CONTROLS_PATH = path.resolve("docs/security/OWASP_OPERATIONAL_CONTROLS.md");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  const [headers, ...records] = rows.filter((entry) => entry.some(Boolean));
  return records.map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, record[index] || ""]))
  );
}

test("ASVS 5.0 Level 2 matrix contains the complete pinned requirement scope", async () => {
  assert.equal(existsSync(MATRIX_PATH), true, "ASVS matrix is missing");

  const rows = parseCsv(await readFile(MATRIX_PATH, "utf8"));
  const allowedStatuses = new Set([
    "Verified",
    "Partial",
    "Not verified",
    "Not applicable",
    "Not assessed"
  ]);
  const assessedRows = rows.filter((row) => row.status !== "Not assessed");

  assert.equal(rows.length, 253);
  assert.equal(new Set(rows.map((row) => row.requirement_id)).size, 253);
  assert.ok(rows.every((row) => /^V\d+\.\d+\.\d+$/.test(row.requirement_id)));
  assert.ok(rows.every((row) => ["1", "2"].includes(row.asvs_level)));
  assert.ok(rows.every((row) => allowedStatuses.has(row.status)));
  assert.ok(assessedRows.length > 0, "matrix must contain evidence-backed assessments");
  assert.ok(
    assessedRows.every((row) => row.evidence.trim().length > 0),
    "every assessed row must cite evidence"
  );
  assert.ok(
    rows
      .filter((row) => /^(V9|V10|V17)\./.test(row.requirement_id))
      .every((row) => row.status === "Not applicable"),
    "unused self-contained token, OAuth/OIDC, and WebRTC requirements must have explicit not-applicable dispositions"
  );
});

test("OWASP operational controls assign non-code security responsibilities and evidence", async () => {
  assert.equal(
    existsSync(OPERATIONAL_CONTROLS_PATH),
    true,
    "OWASP operational controls document is missing"
  );

  const document = await readFile(OPERATIONAL_CONTROLS_PATH, "utf8");
  const requiredSections = [
    "Application-enforced controls",
    "Windows host controls",
    "Cloudflare controls",
    "Operator controls",
    "Independent verification controls"
  ];
  const requiredControls = [
    "runtime ACL",
    "TLS",
    "tunnel",
    "backup",
    "restore",
    "secret rotation",
    "log review",
    "time synchronization",
    "patch",
    "penetration test"
  ];

  for (const section of requiredSections) {
    assert.match(document, new RegExp(`^## ${section}$`, "m"));
  }

  for (const control of requiredControls) {
    assert.match(document, new RegExp(control, "i"));
  }

  assert.match(document, /\|\s*Owner\s*\|\s*Enforcement point\s*\|\s*Minimum action\s*\|\s*Evidence\s*\|\s*Frequency\s*\|\s*Failure response\s*\|/);
  assert.match(document, /Source code cannot guarantee/i);
  assert.match(document, /not an OWASP certification/i);
});

test("client templates do not depend on CSP-blocked inline handlers or styles", async () => {
  const client = await readFile(path.resolve("public/app.js"), "utf8");

  assert.doesNotMatch(client, /<[^>]*\son[a-z]+\s*=/i);
  assert.doesNotMatch(client, /<[^>]*\sstyle\s*=/i);
  assert.doesNotMatch(client, /\.style\./);
});
