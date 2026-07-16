import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv";
const ASSESSMENTS_PATH = path.resolve("docs/security/asvs-5.0-level2-assessments.json");
const OUTPUT_PATH = path.resolve("docs/security/ASVS_5.0_LEVEL_2_MATRIX.csv");
const ALLOWED_STATUSES = new Set([
  "Verified",
  "Partial",
  "Not verified",
  "Not applicable",
  "Not assessed"
]);

export function parseCsv(text) {
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

  if (quoted) {
    throw new Error("ASVS source CSV ended inside a quoted field.");
  }

  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  const [headers, ...records] = rows.filter((entry) => entry.some(Boolean));
  if (!headers) {
    throw new Error("ASVS source CSV is empty.");
  }

  return records.map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, record[index] || ""]))
  );
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeCsv(rows) {
  const columns = [
    "requirement_id",
    "chapter",
    "section",
    "requirement",
    "asvs_level",
    "status",
    "evidence",
    "control_owner",
    "notes"
  ];

  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(","))
  ].join("\r\n") + "\r\n";
}

function validateAssessments(assessmentList, requirementIds) {
  const assessments = new Map();

  for (const assessment of assessmentList) {
    const requirementId = String(assessment.requirement_id || "").trim();
    const status = String(assessment.status || "").trim();
    const evidence = String(assessment.evidence || "").trim();

    if (!requirementIds.has(requirementId)) {
      throw new Error(`Assessment references unknown or non-Level-2 requirement ${requirementId || "(blank)"}.`);
    }
    if (assessments.has(requirementId)) {
      throw new Error(`Assessment repeats requirement ${requirementId}.`);
    }
    if (!ALLOWED_STATUSES.has(status)) {
      throw new Error(`Assessment ${requirementId} has invalid status ${status || "(blank)"}.`);
    }
    if (status !== "Not assessed" && !evidence) {
      throw new Error(`Assessment ${requirementId} must cite evidence for status ${status}.`);
    }

    assessments.set(requirementId, {
      status,
      evidence,
      control_owner: String(assessment.control_owner || "").trim(),
      notes: String(assessment.notes || "").trim()
    });
  }

  return assessments;
}

export function buildMatrixRows(sourceRows, assessmentList, notApplicableChapters = []) {
  const levelTwoRows = sourceRows.filter((row) => ["1", "2"].includes(String(row.L)));
  const requirementIds = new Set(levelTwoRows.map((row) => row.req_id));
  const assessments = validateAssessments(assessmentList, requirementIds);
  const availableChapterIds = new Set(levelTwoRows.map((row) => row.chapter_id));
  const chapterDispositions = new Map();

  for (const disposition of notApplicableChapters) {
    const chapterId = String(disposition.chapter_id || "").trim();
    const evidence = String(disposition.evidence || "").trim();

    if (!availableChapterIds.has(chapterId)) {
      throw new Error(`Not-applicable disposition references unknown chapter ${chapterId || "(blank)"}.`);
    }
    if (chapterDispositions.has(chapterId)) {
      throw new Error(`Not-applicable disposition repeats chapter ${chapterId}.`);
    }
    if (!evidence) {
      throw new Error(`Not-applicable chapter ${chapterId} must cite evidence.`);
    }

    chapterDispositions.set(chapterId, {
      status: "Not applicable",
      evidence,
      control_owner: String(disposition.control_owner || "").trim(),
      notes: String(disposition.notes || "").trim()
    });
  }

  for (const row of levelTwoRows) {
    if (chapterDispositions.has(row.chapter_id) && assessments.has(row.req_id)) {
      throw new Error(
        `Requirement ${row.req_id} has both an explicit assessment and a chapter-level not-applicable disposition.`
      );
    }
  }

  if (levelTwoRows.length !== 253 || requirementIds.size !== 253) {
    throw new Error(
      `Pinned ASVS source scope changed: expected 253 unique Level 1/2 requirements, received ${levelTwoRows.length} rows and ${requirementIds.size} unique IDs.`
    );
  }

  return levelTwoRows.map((row) => {
    const assessment = assessments.get(row.req_id) || chapterDispositions.get(row.chapter_id) || {
      status: "Not assessed",
      evidence: "",
      control_owner: "",
      notes: ""
    };

    return {
      requirement_id: row.req_id,
      chapter: `${row.chapter_id} ${row.chapter_name}`,
      section: `${row.section_id} ${row.section_name}`,
      requirement: row.req_description,
      asvs_level: row.L,
      ...assessment
    };
  });
}

export async function buildMatrix() {
  const [sourceResponse, assessmentText] = await Promise.all([
    fetch(SOURCE_URL, {
      headers: {
        "User-Agent": "Project-A-ASVS-Matrix/1.0"
      }
    }),
    readFile(ASSESSMENTS_PATH, "utf8")
  ]);

  if (!sourceResponse.ok) {
    throw new Error(`Unable to download pinned ASVS source: HTTP ${sourceResponse.status}.`);
  }

  const sourceRows = parseCsv(await sourceResponse.text());
  const assessmentDocument = JSON.parse(assessmentText);

  if (assessmentDocument.standard !== "OWASP ASVS 5.0.0" || !Array.isArray(assessmentDocument.assessments)) {
    throw new Error("Assessment document must target OWASP ASVS 5.0.0 and contain an assessments array.");
  }

  const rows = buildMatrixRows(
    sourceRows,
    assessmentDocument.assessments,
    assessmentDocument.not_applicable_chapters || []
  );
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, serializeCsv(rows), "utf8");

  const counts = Object.fromEntries(
    [...ALLOWED_STATUSES].map((status) => [
      status,
      rows.filter((row) => row.status === status).length
    ])
  );
  process.stdout.write(
    `Generated ${path.relative(process.cwd(), OUTPUT_PATH)} with ${rows.length} requirements: ${JSON.stringify(counts)}\n`
  );
}

const isEntrypoint =
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();

if (isEntrypoint) {
  await buildMatrix();
}
