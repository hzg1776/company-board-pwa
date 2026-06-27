import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function loadStylesheet() {
  return readFile(path.join(process.cwd(), "public", "styles.css"), "utf8");
}

async function loadClientApp() {
  return readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
}

function hasSelectorDeclaration(css, selector, property, valuePattern) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rulePattern = new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, "gi");
  let match;

  while ((match = rulePattern.exec(css)) !== null) {
    const body = match.groups?.body || "";
    const declarationPattern = new RegExp(`${property}\\s*:\\s*${valuePattern}`, "i");

    if (declarationPattern.test(body)) {
      return true;
    }
  }

  return false;
}

function getLastSelectorBody(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rulePattern = new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, "gi");
  let body = "";
  let match;

  while ((match = rulePattern.exec(css)) !== null) {
    body = match.groups?.body || "";
  }

  return body;
}

function getLastRuleBody(css, selectorPattern) {
  const rulePattern = new RegExp(`${selectorPattern}\\s*\\{(?<body>[^}]*)\\}`, "gi");
  let body = "";
  let match;

  while ((match = rulePattern.exec(css)) !== null) {
    body = match.groups?.body || "";
  }

  return body;
}

function getDeclarationValue(ruleBody, property) {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escapedProperty}\\s*:\\s*(?<value>[^;]+)`, "i").exec(ruleBody);

  return match?.groups?.value?.trim() || "";
}

test("auth login surfaces define readable text colors on light cards", async () => {
  const css = await loadStylesheet();

  assert.equal(hasSelectorDeclaration(css, ".auth-shell", "color", "var\\(--ink\\)"), true);
  assert.equal(hasSelectorDeclaration(css, ".auth-gate-card", "color", "var\\(--ink\\)"), true);
  assert.equal(hasSelectorDeclaration(css, ".auth-frame-title h2", "color", "var\\(--ink\\)"), true);
  assert.equal(hasSelectorDeclaration(css, ".admin-auth-shell", "color", "var\\(--ink\\)"), true);
  assert.equal(hasSelectorDeclaration(css, ".admin-auth-card", "color", "var\\(--ink\\)"), true);
  assert.equal(hasSelectorDeclaration(css, ".admin-auth-brand-copy h1", "color", "var\\(--ink\\)"), true);
});

test("auth login shells scroll from the top instead of centering oversized cards off-screen", async () => {
  const css = await loadStylesheet();
  const authShellBody = getLastRuleBody(css, "\\.auth-shell,\\s*\\.admin-auth-shell");

  assert.equal(getDeclarationValue(authShellBody, "align-items"), "start");
  assert.equal(getDeclarationValue(authShellBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(authShellBody, "overflow-y"), "auto");
  assert.notEqual(getDeclarationValue(authShellBody, "place-items"), "center");
});

test("weather and status UI remains visible in the operational portal", async () => {
  const css = await loadStylesheet();
  const hiddenWeatherSelectors = [
    ".weather-copy",
    ".weather-card",
    ".weather-location",
    ".weather-updated",
    ".employee-weather-line"
  ];

  for (const selector of hiddenWeatherSelectors) {
    assert.equal(
      hasSelectorDeclaration(css, selector, "display", "none\\s*!important"),
      false,
      `${selector} must not be hidden by global design overrides.`
    );
  }
});

test("employee status strip keeps each icon paired with its label", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const statusItemBody = getLastSelectorBody(css, ".employee-status-ribbon .employee-status-pill");
  const statusIconBody = getLastSelectorBody(css, ".employee-status-ribbon .icon");

  assert.match(app, /class="employee-status-ribbon"/);
  assert.match(app, /class="employee-status-pill"/);
  assert.equal(getDeclarationValue(statusItemBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(statusItemBody, "align-items"), "center");
  assert.equal(getDeclarationValue(statusItemBody, "gap"), "6px");
  assert.equal(getDeclarationValue(statusIconBody, "flex"), "0 0 16px");
  assert.equal(getDeclarationValue(statusIconBody, "width"), "16px");
  assert.equal(getDeclarationValue(statusIconBody, "height"), "16px");
});

test("employee weather renders as a full isolated detail card", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const weatherCardBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-card");
  const weatherPrimaryBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-primary");
  const weatherDetailsBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-details");

  assert.match(app, /function renderEmployeeWeatherCard/);
  assert.match(app, /class="employee-weather-card"/);
  assert.match(app, /class="employee-weather-temperature"/);
  assert.match(app, /class="employee-weather-details"/);
  assert.match(app, />Current weather</);
  assert.match(app, />High</);
  assert.match(app, />Low</);
  assert.match(app, />Local time</);
  assert.match(app, />Last refreshed</);
  assert.match(app, />Sunrise</);
  assert.match(app, />Sunset</);
  assert.doesNotMatch(app, /const weatherLevel = String\(weather\.level/);

  assert.equal(getDeclarationValue(weatherCardBody, "display"), "grid");
  assert.equal(getDeclarationValue(weatherCardBody, "width"), "min(860px, 100%)");
  assert.equal(getDeclarationValue(weatherCardBody, "background"), "var(--surface) !important");
  assert.equal(getDeclarationValue(weatherPrimaryBody, "display"), "flex");
  assert.equal(getDeclarationValue(weatherDetailsBody, "display"), "grid");
});

test("employee feed page centers a large brand header and gives cards more breathing room", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const employeeShellBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.page-shell\\.employee-shell");
  const brandBannerBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-brand-banner");
  const brandHeadBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-brand-banner-head");
  const brandLogoBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-brand-banner-logo");
  const brandTitleBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-brand-banner-kicker");
  const mobileBrandTitleBody = getLastRuleBody(css, "\\.employee-shell\\s+\\.employee-brand-banner-kicker");
  const feedColumnBody = getLastRuleBody(
    css,
    "\\.employee-subscription-banner,\\s*\\.employee-status-strip,\\s*\\.feed-shell,\\s*\\.feed-list,\\s*\\.employee-signout-floor"
  );
  const employeeSubscriptionBody = getLastRuleBody(css, "\\.employee-shell\\s+\\.employee-subscription-banner");
  const feedListBody = getLastRuleBody(css, "\\.feed-list,\\s*\\.feed-list-quiet");
  const feedItemBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.feed-item");

  assert.match(app, /class="employee-brand-banner"/);
  assert.equal(getDeclarationValue(employeeShellBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(brandBannerBody, "display"), "grid");
  assert.equal(getDeclarationValue(brandBannerBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(brandBannerBody, "text-align"), "center");
  assert.equal(getDeclarationValue(brandHeadBody, "grid-template-columns"), "1fr !important");
  assert.equal(getDeclarationValue(brandHeadBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(brandLogoBody, "width"), "clamp(132px, 16vw, 178px)");
  assert.equal(getDeclarationValue(brandLogoBody, "height"), "clamp(132px, 16vw, 178px)");
  assert.equal(getDeclarationValue(brandTitleBody, "font-size"), "3.35rem");
  assert.equal(getDeclarationValue(brandTitleBody, "letter-spacing"), "0");
  assert.equal(getDeclarationValue(mobileBrandTitleBody, "font-size"), "2.2rem");
  assert.equal(getDeclarationValue(feedColumnBody, "width"), "min(760px, calc(100% - 32px))");
  assert.equal(getDeclarationValue(employeeSubscriptionBody, "padding"), "24px 28px");
  assert.equal(getDeclarationValue(employeeSubscriptionBody, "gap"), "14px");
  assert.equal(getDeclarationValue(feedListBody, "gap"), "22px");
  assert.equal(getDeclarationValue(feedItemBody, "padding"), "28px 32px");
});

test("stylesheet uses one consolidated operational theme layer", async () => {
  const css = await loadStylesheet();
  const primaryRoot = css.match(/:root\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const obsoleteThemeLabels = [
    "iOS visual theme override",
    "Accessibility contrast tuning",
    "Light-mode global baseline",
    "Final release theme: brightened baseline"
  ];

  assert.match(primaryRoot, /--bg:\s*#f4f8ff/);
  assert.match(primaryRoot, /--surface:\s*#ffffff/);
  assert.match(primaryRoot, /--ink:\s*#141f2f/);
  assert.match(primaryRoot, /--steel:\s*#1f7ae8/);

  for (const label of obsoleteThemeLabels) {
    assert.equal(css.includes(label), false, `${label} should be consolidated into the primary theme.`);
  }

  assert.equal(
    css.includes("@media (prefers-color-scheme: dark)"),
    false,
    "The operational portal should not auto-flip component colors into dark mode."
  );
  assert.doesNotMatch(css, /letter-spacing:\s*-/i);
});

test("client app keeps employee weather and status surfaces wired", async () => {
  const app = await loadClientApp();

  assert.match(app, /requestJson\("\/api\/weather"\)/);
  assert.match(app, /function renderEmployeeStatusStrip/);
  assert.match(app, /employee-status-strip/);
  assert.match(app, /data-weather-form/);
});
