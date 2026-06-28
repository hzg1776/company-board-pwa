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

function getLastSelectorDeclarationValue(css, selector, property) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rulePattern = new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, "gi");
  const declarationPattern = new RegExp(`${escapedProperty}\\s*:\\s*(?<value>[^;]+)`, "i");
  let value = "";
  let match;

  while ((match = rulePattern.exec(css)) !== null) {
    const declaration = declarationPattern.exec(match.groups?.body || "");
    if (declaration?.groups?.value) {
      value = declaration.groups.value.trim();
    }
  }

  return value;
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

test("admin page header action buttons keep text visible in narrow layouts", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const actionButtonBody = getLastRuleBody(
    css,
    "\\.hr-shell \\.page-actions \\.ghost-button,\\s*\\.webmaster-shell \\.page-actions \\.ghost-button,\\s*\\.it-shell \\.page-actions \\.ghost-button"
  );
  const actionIconBody = getLastRuleBody(
    css,
    "\\.hr-shell \\.page-actions \\.ghost-button \\.icon,\\s*\\.webmaster-shell \\.page-actions \\.ghost-button \\.icon,\\s*\\.it-shell \\.page-actions \\.ghost-button \\.icon"
  );

  assert.match(app, /brandBlock\("Systems Command Center"\)/);
  for (const label of ["Launcher", "Employee Feed", "HR Console", "Copy brief", "Refresh"]) {
    assert.match(app, new RegExp(`${label}<\\/button>`));
  }

  assert.equal(getDeclarationValue(actionButtonBody, "white-space"), "normal");
  assert.equal(getDeclarationValue(actionButtonBody, "overflow"), "visible");
  assert.equal(getDeclarationValue(actionButtonBody, "text-align"), "center");
  assert.equal(getDeclarationValue(actionButtonBody, "min-width"), "0");
  assert.equal(getDeclarationValue(actionIconBody, "flex"), "0 0 17px");
});

test("systems summary stat cards keep metrics readable on light cards", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();

  for (const label of ["Requests", "Server errors", "Active updates", "Urgent updates", "Subscriptions", "Avg response"]) {
    assert.match(app, new RegExp(`label: "${label}"`));
  }

  assert.equal(hasSelectorDeclaration(css, ".webmaster-shell .hero-strip .stat-card", "color", "var\\(--ink\\)"), true);
  assert.equal(hasSelectorDeclaration(css, ".webmaster-shell .hero-strip .stat-card strong", "color", "var\\(--ink\\)"), true);
  assert.equal(hasSelectorDeclaration(css, ".webmaster-shell .hero-strip .stat-card span", "color", "var\\(--muted\\)"), true);
});

test("admin role and status chips keep labels readable on light tables", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();

  assert.match(app, /class="admin-table-chip is-info">\$\{escapeHtml\(adminRoleLabel\(role\)\)\}<\/span>/);
  assert.match(app, /adminUser\.credentialsConfigured/);
  assert.match(app, /"Configured"/);
  assert.match(app, /adminUser\.active === false \? "Disabled" : "Active"/);

  assert.equal(getLastSelectorDeclarationValue(css, ".admin-table-chip", "color"), "var(--steel)");
  assert.equal(getLastSelectorDeclarationValue(css, ".admin-table-chip.is-info", "color"), "var(--steel)");
  assert.equal(getLastSelectorDeclarationValue(css, ".admin-table-chip.is-positive", "color"), "#256346");
  assert.equal(getLastSelectorDeclarationValue(css, ".admin-table-chip.is-muted", "color"), "#5c6770");
});

test("stylesheet forces app text to black globally", async () => {
  const css = await loadStylesheet();

  assert.equal(getLastSelectorDeclarationValue(css, "body", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "body *", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "body *::before", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "body *::after", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "body *::marker", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "input::placeholder", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "textarea::placeholder", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "input::placeholder", "opacity"), "1");
  assert.equal(getLastSelectorDeclarationValue(css, "textarea::placeholder", "opacity"), "1");
});

test("stylesheet does not request remote fonts blocked by the app CSP", async () => {
  const css = await loadStylesheet();

  assert.doesNotMatch(css, /@import\s+url\(["']?https:\/\/fonts\.googleapis\.com/i);
  assert.doesNotMatch(css, /fonts\.googleapis\.com/i);
  assert.doesNotMatch(css, /fonts\.gstatic\.com/i);
});

test("launcher login buttons use compact navigation sizing", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const launcherShellBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.page-shell\\.launcher-shell");
  const launcherStageBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.page-shell\\.launcher-shell\\s+\\.launcher-stage");
  const launcherPanelBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.launcher-panel");
  const launcherLogoBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.launcher-brand-logo");
  const launcherTitleBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.launcher-title-block h2");
  const launcherGridBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.launcher-grid\\.launcher-grid-logins");
  const launchCardBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.launch-card");
  const launchCardLabelBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.launch-card-label");

  for (const label of ["Employee Login", "HR Login", "Systems and Analytics Login", "IT Login"]) {
    assert.match(app, new RegExp(`"${label}"`));
  }

  assert.equal(getDeclarationValue(launcherShellBody, "padding"), "8px 0 18px");
  assert.equal(getDeclarationValue(launcherStageBody, "width"), "min(540px, 100%)");
  assert.equal(getDeclarationValue(launcherStageBody, "gap"), "6px");
  assert.equal(getDeclarationValue(launcherLogoBody, "width"), "clamp(60px, 7vw, 76px)");
  assert.equal(getDeclarationValue(launcherLogoBody, "height"), "clamp(60px, 7vw, 76px)");
  assert.equal(getDeclarationValue(launcherTitleBody, "font-size"), "clamp(1rem, 1.4vw, 1.12rem)");
  assert.equal(getDeclarationValue(launcherTitleBody, "letter-spacing"), "0");
  assert.equal(getDeclarationValue(launcherPanelBody, "gap"), "6px");
  assert.equal(getDeclarationValue(launcherPanelBody, "padding"), "10px");
  assert.equal(getDeclarationValue(launcherPanelBody, "border-radius"), "8px");
  assert.equal(getDeclarationValue(launcherGridBody, "gap"), "6px");
  assert.equal(getDeclarationValue(launcherGridBody, "grid-template-columns"), "repeat(2, minmax(0, 1fr))");
  assert.equal(getDeclarationValue(launchCardBody, "display"), "flex");
  assert.equal(getDeclarationValue(launchCardBody, "align-items"), "center");
  assert.equal(getDeclarationValue(launchCardBody, "justify-content"), "center");
  assert.equal(getDeclarationValue(launchCardBody, "min-height"), "44px");
  assert.equal(getDeclarationValue(launchCardBody, "padding"), "6px 10px");
  assert.equal(getDeclarationValue(launchCardBody, "border-radius"), "8px");
  assert.equal(getDeclarationValue(launchCardBody, "box-shadow"), "none");
  assert.equal(getDeclarationValue(launchCardLabelBody, "font-size"), "0.84rem");
});

test("employee feed does not expose mark-as-read controls", async () => {
  const app = await loadClientApp();

  assert.doesNotMatch(app, /data-acknowledge-post/);
  assert.doesNotMatch(app, /Mark update as read/);
  assert.doesNotMatch(app, /function acknowledgePost/);
  assert.doesNotMatch(app, /function handleAcknowledgeAction/);
  assert.doesNotMatch(app, /Marked read/);
  assert.doesNotMatch(app, /Could not mark this update as read/);
});

test("employee weather renders as a compact source-backed card", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const weatherCardBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-card");
  const weatherPrimaryBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-primary");
  const weatherMetricsBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-metrics");
  const weatherChipBody = getLastSelectorBody(css, ".employee-weather-chip");
  const weatherFreshnessBody = getLastSelectorBody(css, ".employee-weather-freshness");

  assert.match(app, /function renderEmployeeWeatherCard/);
  assert.match(app, /function renderEmployeeWeatherMetric/);
  assert.match(app, /function formatWeatherFreshness/);
  assert.match(app, /class="employee-weather-card"/);
  assert.match(app, /class="employee-weather-temperature"/);
  assert.match(app, /class="employee-weather-metrics"/);
  assert.match(app, /class="employee-weather-chip-label"/);
  assert.match(app, /class="employee-weather-chip-label">\$\{escapeHtml\(label\)\}<\/span>/);
  assert.match(app, /class="employee-weather-freshness"/);
  assert.match(app, />Current weather</);
  assert.match(app, /weather\.source/);
  for (const label of ["High", "Low", "Sunrise", "Sunset"]) {
    assert.match(app, new RegExp(`renderEmployeeWeatherMetric\\("[^"]+", "${label}"`));
  }
  assert.doesNotMatch(app, /class="employee-weather-details"/);
  assert.doesNotMatch(app, /renderEmployeeWeatherDetail/);
  assert.doesNotMatch(app, /const weatherLevel = String\(weather\.level/);

  assert.equal(getDeclarationValue(weatherCardBody, "display"), "grid");
  assert.equal(getDeclarationValue(weatherCardBody, "width"), "min(760px, calc(100% - 32px))");
  assert.equal(getDeclarationValue(weatherCardBody, "background"), "var(--surface) !important");
  assert.equal(getDeclarationValue(weatherPrimaryBody, "display"), "grid");
  assert.equal(getDeclarationValue(weatherMetricsBody, "display"), "flex");
  assert.equal(getDeclarationValue(weatherChipBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(weatherFreshnessBody, "display"), "inline-flex");
});

test("employee feed page uses a compact brand header and tighter feed spacing", async () => {
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
  assert.equal(getDeclarationValue(employeeShellBody, "gap"), "12px");
  assert.equal(getDeclarationValue(employeeShellBody, "padding"), "12px 0 56px");
  assert.equal(getDeclarationValue(brandBannerBody, "display"), "grid");
  assert.equal(getDeclarationValue(brandBannerBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(brandBannerBody, "text-align"), "center");
  assert.equal(getDeclarationValue(brandBannerBody, "padding"), "12px 14px");
  assert.equal(getDeclarationValue(brandHeadBody, "grid-template-columns"), "1fr !important");
  assert.equal(getDeclarationValue(brandHeadBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(brandHeadBody, "gap"), "6px");
  assert.equal(getDeclarationValue(brandLogoBody, "width"), "clamp(64px, 8vw, 90px)");
  assert.equal(getDeclarationValue(brandLogoBody, "height"), "clamp(64px, 8vw, 90px)");
  assert.equal(getDeclarationValue(brandTitleBody, "font-size"), "clamp(1.12rem, 1.55vw, 1.35rem)");
  assert.equal(getDeclarationValue(brandTitleBody, "letter-spacing"), "0");
  assert.equal(getDeclarationValue(mobileBrandTitleBody, "font-size"), "1.08rem");
  assert.equal(getDeclarationValue(feedColumnBody, "width"), "min(760px, calc(100% - 32px))");
  assert.equal(getDeclarationValue(employeeSubscriptionBody, "padding"), "12px 14px");
  assert.equal(getDeclarationValue(employeeSubscriptionBody, "gap"), "8px");
  assert.equal(getDeclarationValue(feedListBody, "gap"), "10px");
  assert.equal(getDeclarationValue(feedItemBody, "padding"), "16px 18px");
});

test("global headings and cards use operational density sizing", async () => {
  const css = await loadStylesheet();
  const appTitleBody = getLastRuleBody(
    css,
    "\\.auth-frame-title h2,\\s*\\.admin-auth-brand-copy h1,\\s*\\.launcher-title-block h2"
  );
  const sectionTitleBody = getLastRuleBody(
    css,
    "\\.panel-title h2,\\s*\\.settings-hero-copy h2"
  );
  const secondaryTitleBody = getLastRuleBody(
    css,
    "\\.panel-title h3,\\s*\\.notice-card h2,\\s*\\.notice-card h3,\\s*\\.feed-title,\\s*\\.employee-weather-reading h2"
  );
  const authLogoFrameBody = getLastRuleBody(
    css,
    "\\.admin-auth-brand-disc,\\s*\\.auth-gate-card \\.brand-logo-disc"
  );
  const authLogoBody = getLastRuleBody(
    css,
    "\\.admin-auth-brand-logo,\\s*\\.auth-gate-card \\.brand-lockup-logo"
  );
  const authControlBody = getLastRuleBody(
    css,
    "\\.admin-auth-card \\.field input,\\s*\\.admin-auth-card \\.field select,\\s*\\.admin-auth-card \\.field textarea,\\s*\\.admin-auth-card \\.button,\\s*\\.auth-gate-card \\.field input,\\s*\\.auth-gate-card \\.button"
  );
  const authGateCardBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.auth-gate-card");
  const panelCardBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.panel-card");
  const adminAuthCardBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.admin-auth-card");

  assert.equal(getDeclarationValue(appTitleBody, "font-size"), "clamp(1.08rem, 1.6vw, 1.3rem)");
  assert.equal(getDeclarationValue(sectionTitleBody, "font-size"), "clamp(0.98rem, 1.18vw, 1.1rem)");
  assert.equal(getDeclarationValue(secondaryTitleBody, "font-size"), "0.95rem");
  assert.equal(getDeclarationValue(authLogoFrameBody, "width"), "56px");
  assert.equal(getDeclarationValue(authLogoFrameBody, "height"), "56px");
  assert.equal(getDeclarationValue(authLogoBody, "width"), "36px");
  assert.equal(getDeclarationValue(authLogoBody, "height"), "36px");
  assert.equal(getDeclarationValue(authControlBody, "min-height"), "44px");
  assert.equal(getDeclarationValue(authGateCardBody, "padding"), "14px");
  assert.equal(getDeclarationValue(authGateCardBody, "gap"), "12px");
  assert.equal(getDeclarationValue(panelCardBody, "padding"), "12px");
  assert.equal(getDeclarationValue(adminAuthCardBody, "padding"), "14px");
  assert.equal(getDeclarationValue(adminAuthCardBody, "gap"), "12px");
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
