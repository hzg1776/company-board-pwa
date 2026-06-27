import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = String(process.env.MANUAL_BASE_URL || "http://localhost:3116").replace(/\/+$/, "");
const shotDir = process.env.MANUAL_SCREENSHOT_DIR;

if (!shotDir) {
  throw new Error("MANUAL_SCREENSHOT_DIR is required.");
}

const roles = [
  {
    role: "employee",
    endpoint: "/api/employee/login",
    username: process.env.MANUAL_EMPLOYEE_USERNAME || "",
    password: process.env.MANUAL_EMPLOYEE_PASSWORD || ""
  },
  {
    role: "hr",
    endpoint: "/api/hr/login",
    username: process.env.MANUAL_HR_USERNAME || "",
    password: process.env.MANUAL_HR_PASSWORD || ""
  },
  {
    role: "webmaster",
    endpoint: "/api/webmaster/login",
    username: process.env.MANUAL_WEBMASTER_USERNAME || "",
    password: process.env.MANUAL_WEBMASTER_PASSWORD || ""
  },
  {
    role: "it",
    endpoint: "/api/it/login",
    username: process.env.MANUAL_IT_USERNAME || "",
    password: process.env.MANUAL_IT_PASSWORD || ""
  }
];

function parseSetCookie(header, origin) {
  const url = new URL(origin);
  const parts = String(header || "").split(";").map((value) => value.trim()).filter(Boolean);
  const [nameValue, ...attrs] = parts;
  const eqIndex = nameValue.indexOf("=");
  const name = nameValue.slice(0, eqIndex);
  const value = nameValue.slice(eqIndex + 1);

  const cookie = {
    name,
    value,
    domain: url.hostname,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: url.protocol === "https:",
    sameSite: "Lax"
  };

  for (const attr of attrs) {
    const [rawKey, rawVal = ""] = attr.split("=");
    const key = rawKey.toLowerCase();
    const valueText = rawVal.trim();
    if (key === "path" && valueText) cookie.path = valueText;
    if (key === "domain" && valueText) cookie.domain = valueText.replace(/^\./, "");
    if (key === "max-age" && valueText) cookie.expires = Math.floor(Date.now() / 1000) + Number(valueText);
    if (key === "expires" && valueText) cookie.expires = Math.floor(new Date(valueText).getTime() / 1000);
    if (key === "httponly") cookie.httpOnly = true;
    if (key === "secure") cookie.secure = true;
    if (key === "samesite" && valueText) {
      const normalized = valueText.toLowerCase();
      cookie.sameSite = normalized === "strict" ? "Strict" : normalized === "none" ? "None" : "Lax";
    }
  }

  return cookie;
}

await fs.mkdir(shotDir, { recursive: true });

for (const role of roles) {
  if (!role.username || !role.password) {
    throw new Error(`Missing credentials for ${role.role}.`);
  }

  const response = await fetch(`${baseUrl}${role.endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl
    },
    body: JSON.stringify({
      username: role.username,
      password: role.password
    })
  });

  if (!response.ok) {
    throw new Error(`Could not log in as ${role.role}. Status ${response.status}.`);
  }

  const setCookies = response.headers.getSetCookie();
  if (!setCookies.length) {
    throw new Error(`No session cookie returned for ${role.role}.`);
  }

  const state = {
    cookies: setCookies.map((header) => parseSetCookie(header, baseUrl)),
    origins: []
  };

  await fs.writeFile(
    path.join(shotDir, `${role.role}-storage.json`),
    JSON.stringify(state, null, 2)
  );
}
