param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$RuntimeRoot = "",
    [string]$DataDirectory = "",
    [switch]$SkipBackup
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "runtime-state.ps1")

$runtimeLayout = Initialize-BoardRuntimeLayout -ProjectRoot $ProjectRoot -RuntimeRoot $RuntimeRoot

if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
    $DataDirectory = $runtimeLayout.DataDirectory
}

if (-not (Test-Path -LiteralPath $DataDirectory)) {
    New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
}

if (-not $SkipBackup) {
    $backupScript = Join-Path $PSScriptRoot "backup-data.ps1"
    $backupArgs = @(
        "-ExecutionPolicy", "Bypass",
        "-File", $backupScript,
        "-ProjectRoot", $ProjectRoot,
        "-DataDirectory", $DataDirectory
    )

    if (-not [string]::IsNullOrWhiteSpace($runtimeLayout.RuntimeRoot)) {
        $backupArgs += @("-RuntimeRoot", $runtimeLayout.RuntimeRoot)
    }

    & powershell @backupArgs
}

$env:PALZIV_RESET_PROJECT_ROOT = $ProjectRoot
$env:PALZIV_RESET_DATA_DIR = $DataDirectory

@'
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(process.env.PALZIV_RESET_PROJECT_ROOT || process.cwd());
const dataDir = path.resolve(process.env.PALZIV_RESET_DATA_DIR || path.join(projectRoot, "data"));

const storageModule = await import(pathToFileURL(path.join(projectRoot, "storage.js")).href);
const notificationsModule = await import(pathToFileURL(path.join(projectRoot, "notifications.js")).href);
const securityModule = await import(pathToFileURL(path.join(projectRoot, "security.js")).href);

const { createSeedData, normalizeDataShape } = storageModule;
const { normalizeNotificationState } = notificationsModule;
const { normalizeSecurityState } = securityModule;

const roleOrder = ["it", "hr", "webmaster"];
const emptyLoginBucket = () => ({ byIp: [], byAccount: [] });
const emptyRecovery = () => ({
  codeSalt: "",
  codeHash: "",
  email: "",
  requestedAt: "",
  expiresAt: "",
  consumedAt: "",
  failedAttempts: 0,
  lastFailedAt: "",
  lockedUntil: ""
});

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function clean(value) {
  return String(value ?? "").trim();
}

function userHasRole(user, role) {
  return Array.isArray(user?.roles) && user.roles.includes(role);
}

function hasAdminCredentials(user) {
  return Boolean(clean(user?.username) && clean(user?.passwordSalt) && clean(user?.passwordHash));
}

function isRecoveryOnly(user) {
  return user?.recoveryOnly === true;
}

function pickRoleUser(adminUsers, role) {
  return adminUsers.find((user) => (
    userHasRole(user, role) &&
    user.active !== false &&
    !isRecoveryOnly(user) &&
    hasAdminCredentials(user)
  )) || adminUsers.find((user) => (
    userHasRole(user, role) &&
    !isRecoveryOnly(user) &&
    hasAdminCredentials(user)
  )) || null;
}

const now = new Date().toISOString();
const securityPath = path.join(dataDir, "security.json");
const pushPath = path.join(dataDir, "push.json");
const analyticsPath = path.join(dataDir, "analytics.json");
const boardPath = path.join(dataDir, "board.json");

const existingSecurity = normalizeSecurityState(await readJson(securityPath, {}));
const adminUsers = roleOrder
  .map((role) => {
    const user = pickRoleUser(existingSecurity.adminUsers, role);

    if (!user) {
      return null;
    }

    return {
      ...user,
      roles: [role],
      active: true,
      lastLoginAt: "",
      updatedAt: now,
      disabledAt: "",
      mfaSecret: "",
      pendingMfaSecret: "",
      pendingMfaCreatedAt: "",
      mfaEnabledAt: "",
      mfaGraceUntil: "",
      recoveryOnly: false,
      recoveryIssuedAt: "",
      recoveryExpiresAt: "",
      inviteTokenHash: "",
      inviteSentAt: "",
      inviteExpiresAt: "",
      inviteAcceptedAt: ""
    };
  })
  .filter(Boolean);

const securityState = normalizeSecurityState({
  adminUsers,
  adminSessions: [],
  employees: [],
  employeeSessions: [],
  loginGuards: {
    it: emptyLoginBucket(),
    hr: emptyLoginBucket(),
    webmaster: emptyLoginBucket(),
    employee: emptyLoginBucket()
  },
  recovery: {
    hr: emptyRecovery()
  },
  securityEvents: []
});
await writeJson(securityPath, securityState);

const existingPush = await readJson(pushPath, {});
const normalizedPush = normalizeNotificationState(existingPush);
const pushState = normalizeNotificationState({
  vapid: normalizedPush.vapid,
  subscriptions: []
});
await writeJson(pushPath, pushState);

const analyticsState = {
  startedAt: now,
  updatedAt: now,
  totals: {
    requests: 0,
    pageViews: 0,
    apiRequests: 0,
    successfulRequests: 0,
    clientErrors: 0,
    serverErrors: 0,
    durationMs: 0
  },
  byMethod: {},
  byStatus: {},
  byRoute: {},
  recentRequests: [],
  recentErrors: []
};
await writeJson(analyticsPath, analyticsState);

const seed = createSeedData();
const boardState = normalizeDataShape({
  posts: seed.posts,
  weather: seed.weather,
  acknowledgements: []
});
await writeJson(boardPath, boardState);

const missingRoles = roleOrder.filter((role) => !adminUsers.some((user) => user.roles.includes(role)));

console.log(JSON.stringify({
  dataDirectory: dataDir,
  adminUsers: adminUsers.map((user) => ({
    username: user.username,
    role: user.roles[0],
    email: user.email || ""
  })),
  missingRoles,
  employeeCount: securityState.employees.length,
  adminSessionCount: securityState.adminSessions.length,
  employeeSessionCount: securityState.employeeSessions.length,
  pushSubscriptionCount: pushState.subscriptions.length,
  analyticsRequestCount: analyticsState.totals.requests,
  boardPostCount: boardState.posts.length,
  boardWeather: boardState.weather.condition
}, null, 2));
'@ | node --input-type=module -
