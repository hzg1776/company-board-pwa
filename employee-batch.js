import { parse as parseYaml } from "yaml";

export const EMPLOYEE_BATCH_LIMIT = 500;

function cleanText(value, maxLength = 200) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeUsername(value) {
  return cleanText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80);
}

function normalizeEmail(value) {
  return cleanText(value, 200).toLowerCase();
}

function formatNameFromUsername(username) {
  return normalizeUsername(username)
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function usernameFromEmail(email) {
  const [localPart] = normalizeEmail(email).split("@");
  return normalizeUsername(localPart);
}

function parseBooleanish(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function parseJsonContent(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON batch upload: ${error.message}`);
  }
}

function parseYamlContent(content) {
  try {
    return parseYaml(content);
  } catch (error) {
    throw new Error(`Invalid YAML batch upload: ${error.message}`);
  }
}

function parseContent(content, format) {
  const normalizedFormat = cleanText(format || "auto", 20).toLowerCase();

  if (normalizedFormat === "json") {
    return parseJsonContent(content);
  }

  if (normalizedFormat === "yaml" || normalizedFormat === "yml") {
    return parseYamlContent(content);
  }

  try {
    return parseJsonContent(content);
  } catch {
    return parseYamlContent(content);
  }
}

function rowsFromParsedUpload(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && typeof parsed === "object" && Array.isArray(parsed.employees)) {
    return parsed.employees;
  }

  throw new Error("Batch upload must contain an employee array or an object with an employees array.");
}

function normalizeBatchRow(row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`Row ${index + 1} must be an employee object.`);
  }

  const email = normalizeEmail(row.email ?? row.workEmail);
  const username = normalizeUsername(row.username ?? row.userName ?? usernameFromEmail(email));
  const name = cleanText(row.name ?? row.displayName ?? row.employeeName, 120) || formatNameFromUsername(username);

  if (!name) {
    throw new Error(`Row ${index + 1} is missing a name.`);
  }

  if (!username) {
    throw new Error(`Row ${index + 1} is missing a username or email.`);
  }

  return {
    name,
    username,
    password: cleanText(row.password ?? row.temporaryPassword ?? row.tempPassword, 256),
    externalEmployeeId: cleanText(row.externalEmployeeId ?? row.employeeId, 80),
    email,
    recoveryEmail: normalizeEmail(row.recoveryEmail),
    department: cleanText(row.department, 80),
    location: cleanText(row.location, 80),
    identityProvider: cleanText(row.identityProvider, 40).toLowerCase() || "local",
    ssoSubject: cleanText(row.ssoSubject, 160),
    passwordResetRequired: parseBooleanish(row.passwordResetRequired ?? row.requirePasswordReset, true)
  };
}

export function parseEmployeeBatchUpload({ content, format = "auto" } = {}) {
  const rawContent = String(content ?? "").trim();

  if (!rawContent) {
    throw new Error("Batch upload content is required.");
  }

  const parsed = parseContent(rawContent, format);
  const rows = rowsFromParsedUpload(parsed);

  if (!rows.length) {
    throw new Error("Batch upload must include at least one employee.");
  }

  if (rows.length > EMPLOYEE_BATCH_LIMIT) {
    throw new Error(`Batch upload is limited to ${EMPLOYEE_BATCH_LIMIT} employees.`);
  }

  const normalizedRows = rows.map((row, index) => normalizeBatchRow(row, index));
  const usernames = new Set();

  for (const row of normalizedRows) {
    if (usernames.has(row.username)) {
      throw new Error(`Duplicate username in upload: ${row.username}`);
    }

    usernames.add(row.username);
  }

  return normalizedRows;
}
