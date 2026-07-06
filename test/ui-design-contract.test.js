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

test("entry login shells use compact grid rows on desktop and stay top-safe on mobile", async () => {
  const css = await loadStylesheet();
  const finalGridLayerStart = css.indexOf("/* Final grid row compaction");
  const finalGridMobileStart = css.indexOf("@media (max-width: 720px)", finalGridLayerStart);
  const desktopCss = css.slice(finalGridLayerStart, finalGridMobileStart);
  const mobileCss = css.slice(finalGridMobileStart);
  const authShellBody = getLastRuleBody(desktopCss, "\\.auth-shell,\\s*\\.admin-auth-shell,\\s*\\.page-shell\\.launcher-shell");
  const mobileAuthShellBody = getLastRuleBody(
    mobileCss,
    "\\.auth-shell,\\s*\\.admin-auth-shell,\\s*\\.page-shell\\.launcher-shell"
  );
  const mobileEntrySurfaceBody = getLastRuleBody(
    mobileCss,
    "\\.entry-surface\\.auth-gate-card,\\s*\\.entry-surface\\.admin-auth-card,\\s*\\.launcher-panel\\.entry-surface"
  );

  assert.notEqual(finalGridLayerStart, -1);
  assert.equal(getDeclarationValue(authShellBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(authShellBody, "align-items"), "start !important");
  assert.equal(getDeclarationValue(authShellBody, "align-content"), "start !important");
  assert.equal(getDeclarationValue(authShellBody, "justify-content"), "center !important");
  assert.equal(getDeclarationValue(authShellBody, "justify-items"), "center !important");
  assert.equal(getDeclarationValue(authShellBody, "min-height"), "100dvh !important");
  assert.equal(getDeclarationValue(authShellBody, "padding"), "18px !important");
  assert.equal(getDeclarationValue(mobileAuthShellBody, "align-items"), "start !important");
  assert.equal(getDeclarationValue(mobileAuthShellBody, "align-content"), "start !important");
  assert.equal(getDeclarationValue(mobileAuthShellBody, "justify-content"), "center !important");
  assert.equal(getDeclarationValue(mobileEntrySurfaceBody, "width"), "calc(100vw - 24px) !important");
  assert.equal(getDeclarationValue(mobileEntrySurfaceBody, "max-width"), "calc(100vw - 24px) !important");
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

test("employee masthead omits the alert-count status strip", async () => {
  const app = await loadClientApp();

  assert.doesNotMatch(app, /function renderEmployeeStatusStrip/);
  assert.doesNotMatch(app, /employee-status-strip/);
  assert.doesNotMatch(app, /employee-status-ribbon/);
  assert.doesNotMatch(app, /employee-status-pill/);
  assert.doesNotMatch(app, /Alerts on/);
  assert.doesNotMatch(app, /\$\{notices\.length\} live/);
});

test("global compact rows share consistent text and icon spacing", async () => {
  const css = await loadStylesheet();
  const rootBody = getLastSelectorBody(css, ":root");
  const sharedRowBody = getLastRuleBody(
    css,
    "\\.notice-meta,\\s*\\.notice-footer,\\s*\\.feed-head-meta,\\s*\\.feed-head-side,\\s*\\.employee-status-ribbon,\\s*\\.page-actions,\\s*\\.post-controls,\\s*\\.settings-weather-line,\\s*\\.webmaster-expand-summary-meta"
  );
  const sharedInlineBody = getLastRuleBody(
    css,
    "\\.notice-type,\\s*\\.priority-pill,\\s*\\.sync-pill,\\s*\\.status-chip,\\s*\\.request-status,\\s*\\.feed-type,\\s*\\.tab-button,\\s*\\.page-actions \\.ghost-button,\\s*\\.page-actions \\.button,\\s*\\.employee-status-ribbon \\.employee-status-pill,\\s*\\.settings-weather-current,\\s*\\.settings-weather-range-item,\\s*\\.settings-weather-updated,\\s*\\.settings-collapse-toggle"
  );
  const sharedIconBody = getLastRuleBody(
    css,
    "\\.notice-type \\.icon,\\s*\\.sync-pill \\.icon,\\s*\\.status-chip \\.icon,\\s*\\.feed-type \\.icon,\\s*\\.tab-button \\.icon,\\s*\\.page-actions \\.ghost-button \\.icon,\\s*\\.page-actions \\.button \\.icon,\\s*\\.employee-status-ribbon \\.icon,\\s*\\.settings-weather-updated-symbol \\.icon,\\s*\\.settings-collapse-toggle \\.icon"
  );

  assert.equal(getDeclarationValue(rootBody, "--ui-row-gap"), "8px");
  assert.equal(getDeclarationValue(rootBody, "--ui-icon-gap"), "6px");
  assert.equal(getDeclarationValue(rootBody, "--ui-compact-line-height"), "1.1");
  assert.equal(getDeclarationValue(sharedRowBody, "display"), "flex");
  assert.equal(getDeclarationValue(sharedRowBody, "align-items"), "center");
  assert.equal(getDeclarationValue(sharedRowBody, "flex-wrap"), "wrap");
  assert.equal(getDeclarationValue(sharedRowBody, "gap"), "var(--ui-row-gap)");
  assert.equal(getDeclarationValue(sharedRowBody, "line-height"), "var(--ui-compact-line-height)");
  assert.equal(getDeclarationValue(sharedInlineBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(sharedInlineBody, "align-items"), "center");
  assert.equal(getDeclarationValue(sharedInlineBody, "gap"), "var(--ui-icon-gap)");
  assert.equal(getDeclarationValue(sharedInlineBody, "line-height"), "var(--ui-compact-line-height)");
  assert.equal(getDeclarationValue(sharedIconBody, "flex"), "0 0 1em");
  assert.equal(getDeclarationValue(sharedIconBody, "width"), "1em");
  assert.equal(getDeclarationValue(sharedIconBody, "height"), "1em");
});

test("global operational layout prevents clipping and mobile overflow", async () => {
  const css = await loadStylesheet();
  const rootBody = getLastSelectorBody(css, ":root");
  const sharedChromeBody = getLastRuleBody(
    css,
    "\\.page-actions \\.ghost-button,\\s*\\.page-actions \\.button,\\s*\\.tab-button,\\s*\\.stat-card,\\s*\\.admin-role-checkbox"
  );
  const statStrongBody = getLastSelectorBody(css, ".stat-card strong");
  const tabBarBody = getLastSelectorBody(css, ".tab-bar");
  const mobileTabBarBody = getLastRuleBody(css, "@media \\(max-width: 720px\\)\\s*\\{[\\s\\S]*?\\.tab-bar");
  const mobilePageActionsBody = getLastRuleBody(css, "@media \\(max-width: 720px\\)\\s*\\{[\\s\\S]*?\\.page-actions");
  const mobileHeroStripBody = getLastRuleBody(
    css,
    "@media \\(max-width: 720px\\)\\s*\\{[\\s\\S]*?\\.hero-strip,\\s*\\.hero-strip-admin,\\s*\\.hero-strip-hr,\\s*\\.hero-strip-webmaster,\\s*\\.panel-metrics"
  );
  const roleCheckboxBody = getLastSelectorBody(css, ".admin-role-checkbox");
  const tableWrapBody = getLastSelectorBody(css, ".admin-table-wrap");
  const weatherTempBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-temperature");
  const expandableBody = getLastSelectorBody(css, ".webmaster-expandable");
  const expandableSummaryBody = getLastSelectorBody(css, ".webmaster-expand-summary");
  const expandablePanelBody = getLastSelectorBody(css, ".webmaster-expand-body");

  assert.equal(
    getDeclarationValue(rootBody, "--ui-font-family"),
    "Arial, sans-serif"
  );
  assert.equal(getDeclarationValue(rootBody, "--ui-card-padding"), "10px");
  assert.equal(getDeclarationValue(rootBody, "--ui-control-min-height"), "36px");
  assert.equal(getDeclarationValue(sharedChromeBody, "font-family"), "var(--ui-font-family)");
  assert.equal(getDeclarationValue(sharedChromeBody, "box-sizing"), "border-box");
  assert.equal(getDeclarationValue(statStrongBody, "line-height"), "1.12");
  assert.equal(getDeclarationValue(weatherTempBody, "line-height"), "1.18");
  assert.equal(getDeclarationValue(roleCheckboxBody, "min-width"), "max-content");
  assert.equal(getDeclarationValue(roleCheckboxBody, "box-sizing"), "border-box");
  assert.equal(getDeclarationValue(tableWrapBody, "max-width"), "100%");
  assert.equal(getDeclarationValue(tableWrapBody, "overscroll-behavior-x"), "contain");
  assert.equal(getDeclarationValue(expandableBody, "overflow"), "clip");
  assert.equal(getDeclarationValue(expandableSummaryBody, "padding"), "var(--ui-card-padding)");
  assert.equal(getDeclarationValue(expandablePanelBody, "padding"), "var(--ui-card-padding)");
  assert.equal(getDeclarationValue(tabBarBody, "max-width"), "100%");
  assert.equal(hasSelectorDeclaration(css, ".tab-bar", "margin-bottom", "12px"), true);
  assert.equal(getDeclarationValue(mobileTabBarBody, "display"), "grid");
  assert.equal(getDeclarationValue(mobileTabBarBody, "overflow"), "visible");
  assert.equal(getDeclarationValue(mobileTabBarBody, "margin-bottom"), "10px");
  assert.equal(getDeclarationValue(mobilePageActionsBody, "grid-template-columns"), "repeat(auto-fit, minmax(0, 1fr)) !important");
  assert.equal(getDeclarationValue(mobileHeroStripBody, "grid-template-columns"), "repeat(2, minmax(0, 1fr))");
  assert.equal(getDeclarationValue(mobileHeroStripBody, "gap"), "6px");
  assert.equal(hasSelectorDeclaration(css, ".stat-card", "min-height", "58px"), true);
  assert.equal(hasSelectorDeclaration(css, ".stat-card", "padding", "10px\\s+12px"), true);
});

test("stylesheet rounds visible operational corners", async () => {
  const css = await loadStylesheet();
  const rootBody = getLastSelectorBody(css, ":root");

  assert.equal(getDeclarationValue(rootBody, "--radius-control"), "18px");
  assert.equal(getDeclarationValue(rootBody, "--radius-card"), "24px");
  assert.equal(getDeclarationValue(rootBody, "--radius-panel"), "32px");
  assert.equal(getDeclarationValue(rootBody, "--radius-soft"), "20px");
  assert.match(css, /Final rounded-corner normalization/);
  assert.match(css, /\.panel-card,\s*\.launch-card,\s*\.notice-card,/s);

  assert.doesNotMatch(css, /border-radius:\s*(?:0|2px)\s*!important/i);
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

test("admin page header actions render as horizontal pills on desktop", async () => {
  const css = await loadStylesheet();
  const finalGridLayerStart = css.indexOf("/* Final grid row compaction");
  const finalGridMobileStart = css.indexOf("@media (max-width: 720px)", finalGridLayerStart);
  const desktopCss = css.slice(finalGridLayerStart, finalGridMobileStart);
  const actionRowBody = getLastSelectorBody(desktopCss, ".page-shell:is(.hr-shell, .webmaster-shell, .it-shell) .page-actions");
  const actionButtonBody = getLastRuleBody(
    desktopCss,
    "\\.hr-shell \\.page-actions \\.ghost-button,\\s*\\.webmaster-shell \\.page-actions \\.ghost-button,\\s*\\.it-shell \\.page-actions \\.ghost-button"
  );

  assert.equal(getDeclarationValue(actionRowBody, "display"), "flex !important");
  assert.equal(getDeclarationValue(actionRowBody, "flex-wrap"), "wrap");
  assert.equal(getDeclarationValue(actionRowBody, "justify-content"), "center");
  assert.equal(getDeclarationValue(actionRowBody, "grid-column"), "1 / -1");
  assert.equal(getDeclarationValue(actionRowBody, "grid-row"), "2");
  assert.equal(getDeclarationValue(actionRowBody, "justify-self"), "stretch");
  assert.equal(getDeclarationValue(actionRowBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(actionButtonBody, "flex"), "0 0 auto");
  assert.equal(getDeclarationValue(actionButtonBody, "border-radius"), "999px !important");
});

test("admin page headers keep logo text under the logo mark", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const brandBody = getLastSelectorBody(css, ".page-shell:is(.hr-shell, .webmaster-shell, .it-shell) .page-head > .brand");
  const lockupBody = getLastSelectorBody(css, ".page-shell:is(.hr-shell, .webmaster-shell, .it-shell) .page-head .brand-lockup");
  const brandTextBody = getLastSelectorBody(css, ".page-shell:is(.hr-shell, .webmaster-shell, .it-shell) .page-head .brand-lockup p");
  const logoDiscBody = getLastSelectorBody(css, ".page-shell:is(.hr-shell, .webmaster-shell, .it-shell) .page-head .brand-logo-disc");
  const logoBody = getLastSelectorBody(css, ".page-shell:is(.hr-shell, .webmaster-shell, .it-shell) .page-head .brand-lockup-logo");

  assert.match(app, /brandBlock\("HR Control Center"\)/);
  assert.match(app, /brandBlock\("Systems Command Center"\)/);
  assert.match(app, /brandBlock\("IT Control Center"\)/);
  assert.equal(getDeclarationValue(brandBody, "grid-column"), "1 / -1");
  assert.equal(getDeclarationValue(brandBody, "grid-row"), "1");
  assert.equal(getDeclarationValue(brandBody, "justify-content"), "center !important");
  assert.equal(getDeclarationValue(brandBody, "justify-self"), "center !important");
  assert.equal(getDeclarationValue(lockupBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(lockupBody, "justify-items"), "center !important");
  assert.equal(getDeclarationValue(lockupBody, "text-align"), "center !important");
  assert.equal(getDeclarationValue(brandTextBody, "color"), "#0b4c75 !important");
  assert.equal(getDeclarationValue(brandTextBody, "font-weight"), "950 !important");
  assert.equal(getDeclarationValue(brandTextBody, "text-transform"), "none !important");
  assert.equal(getDeclarationValue(brandTextBody, "white-space"), "normal !important");
  assert.equal(getDeclarationValue(logoDiscBody, "width"), "58px !important");
  assert.equal(getDeclarationValue(logoDiscBody, "height"), "58px !important");
  assert.equal(getDeclarationValue(logoBody, "width"), "42px !important");
  assert.equal(getDeclarationValue(logoBody, "height"), "42px !important");
});

test("all logo surfaces keep compact readable brand geometry", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const finalEntryLayerStart = css.indexOf("/* Final entry shell cleanup");
  const finalEntryMobileStart = css.indexOf("@media (max-width: 720px)", finalEntryLayerStart);
  const desktopCss = css.slice(0, finalEntryMobileStart);
  const allLogoBody = getLastRuleBody(
    css,
    "\\.auth-gate-card\\.entry-surface > \\.entry-brand,\\s*\\.launcher-panel\\.entry-surface \\.launcher-brand,\\s*\\.admin-auth-card\\.entry-surface \\.admin-auth-brand"
  );
  const employeeLogoStackBody = getLastSelectorBody(css, ".employee-shell .employee-brand-banner .employee-brand-identity");
  const belowLogoTitleBody = getLastRuleBody(
    css,
    "\\.auth-gate-card\\.entry-surface \\.auth-frame-title,\\s*\\.launcher-panel\\.entry-surface \\.launcher-title-block"
  );
  const authTitleInnerBody = getLastSelectorBody(css, ".auth-gate-card.entry-surface .auth-frame-title > div");
  const logoCopyBody = getLastRuleBody(
    css,
    "\\.admin-auth-card\\.entry-surface \\.admin-auth-brand-copy,\\s*\\.employee-shell \\.employee-brand-banner \\.employee-brand-banner-copy"
  );
  const logoTextBody = getLastRuleBody(
    css,
    "\\.auth-gate-card\\.entry-surface \\.auth-frame-title h2,\\s*\\.admin-auth-card\\.entry-surface \\.admin-auth-brand-copy h1,\\s*\\.launcher-panel\\.entry-surface \\.launcher-title-block h2,\\s*\\.employee-shell \\.employee-brand-banner \\.employee-brand-banner-kicker,\\s*\\.page-shell:is\\(\\.hr-shell, \\.webmaster-shell, \\.it-shell\\) \\.page-head \\.brand-lockup p"
  );
  const authAdminDiscBody = getLastRuleBody(
    css,
    "\\.auth-gate-card\\.entry-surface \\.brand-logo-disc,\\s*\\.admin-auth-card\\.entry-surface \\.admin-auth-brand-disc"
  );
  const authAdminLogoBody = getLastRuleBody(
    css,
    "\\.auth-gate-card\\.entry-surface \\.brand-lockup-logo,\\s*\\.admin-auth-card\\.entry-surface \\.admin-auth-brand-logo"
  );
  const rawLogoBody = getLastRuleBody(
    css,
    "\\.launcher-panel\\.entry-surface \\.launcher-brand \\.launcher-brand-logo,\\s*\\.employee-shell \\.employee-brand-banner \\.employee-brand-banner-logo"
  );
  const launcherPanelBody = getLastSelectorBody(desktopCss, ".launcher-panel.entry-surface");

  assert.match(app, /brandBlock\("", "entry-brand"\)/);
  assert.match(app, /class="admin-auth-brand entry-brand"/);
  assert.match(app, /class="launcher-brand entry-brand"/);
  assert.match(app, /class="employee-brand-identity"/);

  assert.equal(getDeclarationValue(allLogoBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(allLogoBody, "justify-items"), "center !important");
  assert.equal(getDeclarationValue(allLogoBody, "gap"), "8px !important");
  assert.equal(getDeclarationValue(allLogoBody, "text-align"), "center !important");
  assert.equal(getDeclarationValue(employeeLogoStackBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(employeeLogoStackBody, "justify-items"), "center !important");
  assert.equal(getDeclarationValue(employeeLogoStackBody, "gap"), "4px !important");
  assert.equal(getDeclarationValue(employeeLogoStackBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(launcherPanelBody, "gap"), "14px !important");
  assert.equal(getDeclarationValue(belowLogoTitleBody, "justify-self"), "center !important");
  assert.equal(getDeclarationValue(belowLogoTitleBody, "max-width"), "min(20rem, 100%) !important");
  assert.equal(getDeclarationValue(belowLogoTitleBody, "margin"), "4px 0 6px !important");
  assert.equal(getDeclarationValue(belowLogoTitleBody, "text-align"), "center !important");
  assert.equal(getDeclarationValue(authTitleInnerBody, "gap"), "4px !important");
  assert.equal(getDeclarationValue(logoCopyBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(logoCopyBody, "justify-items"), "center !important");
  assert.equal(getDeclarationValue(logoCopyBody, "gap"), "5px !important");
  assert.equal(getDeclarationValue(logoCopyBody, "max-width"), "min(15rem, 100%) !important");
  assert.equal(getDeclarationValue(logoCopyBody, "text-align"), "center !important");
  assert.equal(getDeclarationValue(logoTextBody, "color"), "#0b4c75 !important");
  assert.equal(getDeclarationValue(logoTextBody, "max-width"), "min(18rem, 100%)");
  assert.equal(getDeclarationValue(logoTextBody, "font-size"), "clamp(0.86rem, 1.2vw, 1.06rem) !important");
  assert.equal(getDeclarationValue(logoTextBody, "font-weight"), "950 !important");
  assert.equal(getDeclarationValue(logoTextBody, "line-height"), "1.16 !important");
  assert.equal(getDeclarationValue(logoTextBody, "text-transform"), "none !important");
  assert.equal(getDeclarationValue(logoTextBody, "white-space"), "normal !important");

  assert.equal(getDeclarationValue(authAdminDiscBody, "width"), "58px !important");
  assert.equal(getDeclarationValue(authAdminDiscBody, "height"), "58px !important");
  assert.equal(getDeclarationValue(authAdminLogoBody, "width"), "42px !important");
  assert.equal(getDeclarationValue(authAdminLogoBody, "height"), "42px !important");
  assert.equal(getDeclarationValue(rawLogoBody, "width"), "58px !important");
  assert.equal(getDeclarationValue(rawLogoBody, "height"), "58px !important");
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
  assert.equal(getLastSelectorDeclarationValue(css, ".admin-table-chip.is-muted", "color"), "var(--tone-muted-text) !important");
});

test("stylesheet forces app text to black globally", async () => {
  const css = await loadStylesheet();
  const whiteTextDeclarations = css
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => /^color\s*:/i.test(line))
    .filter(({ line }) => /#fff(?:fff)?\b|rgba?\(\s*255\s*,\s*255\s*,\s*255/i.test(line));

  assert.equal(getLastSelectorDeclarationValue(css, "body", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "body *", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "body *::before", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "body *::after", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "body *::marker", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "input::placeholder", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "textarea::placeholder", "color"), "#000000 !important");
  assert.equal(getLastSelectorDeclarationValue(css, "input::placeholder", "opacity"), "1");
  assert.equal(getLastSelectorDeclarationValue(css, "textarea::placeholder", "opacity"), "1");
  assert.deepEqual(whiteTextDeclarations, []);
});

test("HR and Systems settings do not render redundant status hero panels", async () => {
  const app = await loadClientApp();

  assert.doesNotMatch(app, /renderRoleSettingsHero\("hr"\)/);
  assert.doesNotMatch(app, /renderRoleSettingsHero\("webmaster"\)/);
});

test("management settings weather card uses a compact control layout", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const finalGridLayerStart = css.indexOf("/* Final grid row compaction");
  const finalGridMobileStart = css.indexOf("@media (max-width: 720px)", finalGridLayerStart);
  const desktopCss = css.slice(0, finalGridMobileStart);
  const weatherCardBody = getLastSelectorBody(desktopCss, ".settings-weather-card");
  const weatherStatusBody = getLastSelectorBody(css, ".settings-weather-status");
  const weatherCurrentBody = getLastSelectorBody(css, ".settings-weather-current");
  const weatherRangeBody = getLastSelectorBody(css, ".settings-weather-range");
  const weatherUpdatedBody = getLastSelectorBody(css, ".settings-weather-updated");
  const weatherFormBody = getLastSelectorBody(css, ".settings-weather-form");

  assert.match(app, /class="panel-card weather-card settings-weather-card"/);
  assert.match(app, /class="settings-weather-status"/);
  assert.match(app, /class="settings-weather-line settings-weather-line-primary"/);
  assert.match(app, /class="settings-weather-line settings-weather-line-secondary"/);
  assert.match(app, /class="settings-weather-current"/);
  assert.match(app, /const temperatureToneClass = getWeatherTemperatureToneClass\(temperatureLabel\)/);
  assert.match(app, /class="settings-weather-temperature \$\{temperatureToneClass\}"/);
  assert.match(app, /class="settings-weather-condition"/);
  assert.match(app, /class="settings-weather-range"/);
  assert.match(app, /class="settings-weather-range-item settings-weather-range-high" aria-label="High temperature"><span class="settings-weather-range-label" aria-hidden="true">[^<]+<\/span>/);
  assert.match(app, /class="settings-weather-range-item settings-weather-range-low" aria-label="Low temperature"><span class="settings-weather-range-label" aria-hidden="true">[^<]+<\/span>/);
  assert.match(app, /formatCompactWeatherLocation\(weather\.resolvedName \|\| weather\.location/);
  assert.match(app, /class="settings-weather-updated" aria-label="\$\{escapeHtml\(updatedAriaLabel\)\}"/);
  assert.match(app, /class="settings-weather-updated-symbol" aria-hidden="true">\$\{icon\("clock"\)\}<\/span>/);
  assert.match(app, /class="settings-weather-form"/);
  assert.doesNotMatch(app, /Live weather source/);
  assert.doesNotMatch(app, /<p class="eyebrow">\$\{icon\("cloud"\)\} Weather<\/p>/);
  assert.doesNotMatch(app, /<section class="panel-card weather-card">[\s\S]*?<form class="auth-form" data-weather-form>/);

  assert.equal(getDeclarationValue(weatherCardBody, "display"), "grid");
  assert.equal(getDeclarationValue(weatherCardBody, "grid-template-columns"), "minmax(0, 1fr) minmax(220px, 0.8fr) !important");
  assert.equal(getDeclarationValue(weatherCardBody, "gap"), "10px 12px !important");
  assert.equal(getDeclarationValue(weatherCardBody, "padding"), "12px 14px !important");
  assert.equal(getDeclarationValue(weatherStatusBody, "display"), "grid");
  assert.equal(getDeclarationValue(weatherStatusBody, "gap"), "6px");
  assert.equal(hasSelectorDeclaration(css, ".settings-weather-line", "display", "flex"), true);
  assert.equal(hasSelectorDeclaration(css, ".settings-weather-line", "flex-wrap", "wrap"), true);
  assert.equal(hasSelectorDeclaration(css, ".settings-weather-line", "gap", "var\\(--ui-row-gap\\)"), true);
  assert.equal(hasSelectorDeclaration(css, ".settings-weather-line", "line-height", "var\\(--ui-compact-line-height\\)"), true);
  assert.equal(getDeclarationValue(weatherCurrentBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(weatherCurrentBody, "align-items"), "center");
  assert.equal(getDeclarationValue(weatherCurrentBody, "gap"), "var(--ui-icon-gap)");
  assert.equal(getDeclarationValue(weatherRangeBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(weatherRangeBody, "gap"), "10px");
  assert.equal(getDeclarationValue(weatherUpdatedBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(weatherUpdatedBody, "gap"), "var(--ui-icon-gap)");
  assert.equal(hasSelectorDeclaration(css, ".settings-weather-form", "display", "grid"), true);
  assert.equal(
    hasSelectorDeclaration(css, ".settings-weather-form", "grid-template-columns", "minmax\\(180px,\\s*1fr\\)\\s+auto"),
    true
  );
  assert.equal(hasSelectorDeclaration(css, ".settings-weather-form", "gap", "8px"), true);
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
  const finalGridLayerStart = css.indexOf("/* Final grid row compaction");
  const finalGridMobileStart = css.indexOf("@media (max-width: 720px)", finalGridLayerStart);
  const desktopCss = css.slice(0, finalGridMobileStart);
  const mobileCss = css.slice(finalGridMobileStart);
  const launcherShellBody = getLastRuleBody(desktopCss, "\\.auth-shell,\\s*\\.admin-auth-shell,\\s*\\.page-shell\\.launcher-shell");
  const launcherStageBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.page-shell\\.launcher-shell\\s+\\.launcher-stage");
  const launcherPanelBody = getLastSelectorBody(desktopCss, ".launcher-panel.entry-surface");
  const launcherShellAliasBody = getLastSelectorBody(css, ".launcher-shell.page-shell");
  const launcherLogoBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.launcher-brand-logo");
  const launcherTitleBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.launcher-title-block h2");
  const launcherGridBody = getLastSelectorBody(desktopCss, ".launcher-panel.entry-surface .launcher-grid.launcher-grid-logins");
  const mobileLauncherGridBody = getLastSelectorBody(mobileCss, ".launcher-panel.entry-surface .launcher-grid.launcher-grid-logins");
  const launchCardBody = getLastSelectorBody(desktopCss, ".launcher-panel.entry-surface .launch-card");
  const launchCardLabelBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.launch-card-label");

  for (const label of ["Employee Login", "HR Login", "Systems and Analytics Login", "IT Login"]) {
    assert.match(app, new RegExp(`"${label}"`));
  }

  assert.equal(getDeclarationValue(launcherShellBody, "padding"), "18px !important");
  assert.equal(getDeclarationValue(launcherShellAliasBody, "width"), "min(760px, 100%) !important");
  assert.equal(getDeclarationValue(launcherShellAliasBody, "overflow-x"), "hidden !important");
  assert.equal(getDeclarationValue(launcherStageBody, "width"), "min(720px, 100%) !important");
  assert.equal(getDeclarationValue(launcherStageBody, "gap"), "6px");
  assert.equal(getDeclarationValue(launcherLogoBody, "width"), "clamp(60px, 7vw, 76px)");
  assert.equal(getDeclarationValue(launcherLogoBody, "height"), "clamp(60px, 7vw, 76px)");
  assert.equal(getDeclarationValue(launcherTitleBody, "font-size"), "clamp(1rem, 1.4vw, 1.12rem)");
  assert.equal(getDeclarationValue(launcherTitleBody, "letter-spacing"), "0");
  assert.equal(getDeclarationValue(launcherPanelBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(launcherPanelBody, "grid-template-columns"), "1fr");
  assert.equal(getDeclarationValue(launcherPanelBody, "row-gap"), "9px !important");
  assert.equal(getDeclarationValue(launcherPanelBody, "padding"), "16px !important");
  assert.equal(getDeclarationValue(launcherPanelBody, "justify-items"), "center !important");
  assert.equal(getDeclarationValue(launcherGridBody, "gap"), "8px !important");
  assert.equal(getDeclarationValue(launcherGridBody, "grid-template-columns"), "repeat(2, minmax(0, 1fr)) !important");
  assert.equal(getDeclarationValue(mobileLauncherGridBody, "grid-template-columns"), "1fr !important");
  assert.equal(getDeclarationValue(launchCardBody, "display"), "flex");
  assert.equal(getDeclarationValue(launchCardBody, "align-items"), "center");
  assert.equal(getDeclarationValue(launchCardBody, "justify-content"), "center");
  assert.equal(getDeclarationValue(launchCardBody, "min-height"), "46px !important");
  assert.equal(getDeclarationValue(launchCardBody, "padding"), "8px 10px !important");
  assert.equal(getDeclarationValue(launchCardLabelBody, "font-size"), "0.84rem");
});

test("entry surfaces keep relocated logo, labels, casing, and touch targets", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const finalEntryLayerStart = css.indexOf("/* Final entry shell cleanup");
  const finalEntryMobileStart = css.indexOf("@media (max-width: 720px)", finalEntryLayerStart);
  const desktopCss = css.slice(0, finalEntryMobileStart);
  const entryCardBody = getLastRuleBody(
    css,
    "\\.entry-surface\\.auth-gate-card,\\s*\\.entry-surface\\.admin-auth-card"
  );
  const launcherEntryBody = getLastSelectorBody(desktopCss, ".launcher-panel.entry-surface");
  const launcherEntryLogoBody = getLastSelectorBody(css, ".launcher-panel.entry-surface .launcher-brand-logo");
  const entryCasingBody = getLastRuleBody(
    css,
    "\\.entry-surface \\.launch-card-label,\\s*\\.entry-surface \\.auth-frame-title h2,\\s*\\.entry-surface \\.admin-auth-brand-copy h1,\\s*\\.entry-surface \\.launcher-title-block h2,\\s*\\.entry-surface \\.auth-frame-eyebrow,\\s*\\.entry-surface \\.admin-auth-brand-copy \\.eyebrow,\\s*\\.entry-surface \\.field > span,\\s*\\.entry-surface \\.button,\\s*\\.entry-surface \\.ghost-button,\\s*\\.entry-surface \\.auth-inline-action,\\s*\\.entry-surface \\.employee-banner"
  );
  const entryTitleBody = getLastRuleBody(
    css,
    "\\.entry-surface \\.auth-frame-title h2,\\s*\\.entry-surface \\.admin-auth-brand-copy h1,\\s*\\.entry-surface \\.launcher-title-block h2"
  );
  const entryControlTextBody = getLastRuleBody(
    css,
    "\\.entry-surface \\.auth-frame-eyebrow,\\s*\\.entry-surface \\.admin-auth-brand-copy \\.eyebrow,\\s*\\.entry-surface \\.field > span,\\s*\\.entry-surface \\.button,\\s*\\.entry-surface \\.ghost-button,\\s*\\.entry-surface \\.auth-inline-action,\\s*\\.entry-surface input"
  );
  const employeeLoginActionsBody = getLastSelectorBody(
    css,
    ".auth-gate-card.entry-surface .auth-form .auth-form-actions"
  );
  const employeeLoginButtonBody = getLastSelectorBody(
    css,
    ".auth-gate-card.entry-surface .auth-form .auth-form-actions .button"
  );
  const entryFooterActionBody = getLastRuleBody(
    css,
    "\\.entry-surface \\.auth-inline-action,\\s*\\.entry-surface \\.admin-auth-footer \\.auth-inline-action"
  );
  const entryLabelBody = getLastSelectorBody(css, ".entry-surface .field > span");
  const employeeLaunchBody = getLastSelectorBody(css, ".launcher-panel.entry-surface .launch-card[data-route=\"employee\"]");
  const hrLaunchBody = getLastSelectorBody(css, ".launcher-panel.entry-surface .launch-card[data-route=\"hr\"]");
  const webmasterLaunchBody = getLastSelectorBody(css, ".launcher-panel.entry-surface .launch-card[data-route=\"webmaster\"]");
  const itLaunchBody = getLastSelectorBody(css, ".launcher-panel.entry-surface .launch-card[data-route=\"it\"]");

  assert.match(app, /const cardClasses = \["auth-gate-card", "panel-card", "entry-surface", className\]/);
  assert.match(app, /brandBlock\("", "entry-brand"\)/);
  assert.match(app, /class="admin-auth-card panel-card entry-surface"/);
  assert.match(app, /class="admin-auth-brand entry-brand"/);
  assert.match(app, /<input name="username" maxlength="80" required autocomplete="username" aria-label="Username">/);
  assert.match(app, /aria-label="\$\{escapeHtml\(canSetup \? "Create username" : "Username"\)\}"/);
  assert.match(app, /<div class="launcher-panel entry-surface">[\s\S]*?<div class="launcher-brand entry-brand"/);
  assert.doesNotMatch(app, /<section class="launcher-stage">\s*<div class="launcher-brand" aria-label/);

  assert.equal(getDeclarationValue(entryCardBody, "width"), "min(520px, calc(100vw - 36px)) !important");
  assert.equal(getDeclarationValue(entryCardBody, "max-width"), "520px !important");
  assert.equal(getDeclarationValue(entryCardBody, "gap"), "14px !important");
  assert.equal(getDeclarationValue(entryCardBody, "padding"), "20px !important");
  assert.equal(getDeclarationValue(entryCardBody, "border-radius"), "var(--radius-soft) !important");
  assert.equal(getDeclarationValue(launcherEntryBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(launcherEntryBody, "width"), "min(660px, calc(100vw - 36px)) !important");
  assert.equal(getDeclarationValue(launcherEntryBody, "max-width"), "660px !important");
  assert.equal(getDeclarationValue(launcherEntryBody, "gap"), "14px !important");
  assert.equal(getDeclarationValue(launcherEntryBody, "padding"), "20px !important");
  assert.equal(getDeclarationValue(launcherEntryBody, "border-radius"), "var(--radius-control) !important");
  assert.equal(getDeclarationValue(launcherEntryLogoBody, "width"), "clamp(48px, 6vw, 64px)");
  assert.equal(getDeclarationValue(launcherEntryLogoBody, "height"), "clamp(48px, 6vw, 64px)");
  assert.equal(getDeclarationValue(entryCasingBody, "letter-spacing"), "0 !important");
  assert.equal(getDeclarationValue(entryCasingBody, "text-transform"), "none !important");
  assert.equal(getDeclarationValue(entryTitleBody, "font-size"), "clamp(1.2rem, 2vw, 1.45rem) !important");
  assert.equal(getDeclarationValue(entryControlTextBody, "font-size"), "1rem !important");
  assert.equal(getDeclarationValue(employeeLoginActionsBody, "grid-column"), "1 / -1");
  assert.equal(getDeclarationValue(employeeLoginActionsBody, "grid-template-columns"), "minmax(0, 1fr)");
  assert.equal(getDeclarationValue(employeeLoginActionsBody, "justify-content"), "stretch !important");
  assert.equal(getDeclarationValue(employeeLoginActionsBody, "justify-items"), "stretch !important");
  assert.equal(getDeclarationValue(employeeLoginActionsBody, "width"), "100%");
  assert.equal(getDeclarationValue(employeeLoginButtonBody, "justify-self"), "stretch !important");
  assert.equal(getDeclarationValue(employeeLoginButtonBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(employeeLoginButtonBody, "justify-content"), "center !important");
  assert.equal(getDeclarationValue(entryLabelBody, "display"), "block");
  assert.equal(getDeclarationValue(entryLabelBody, "font-weight"), "700 !important");
  assert.equal(getDeclarationValue(entryFooterActionBody, "min-height"), "44px !important");
  assert.equal(getDeclarationValue(employeeLaunchBody, "color"), "var(--tone-info-text) !important");
  assert.equal(getDeclarationValue(hrLaunchBody, "color"), "var(--tone-success-text) !important");
  assert.equal(getDeclarationValue(webmasterLaunchBody, "color"), "var(--tone-warning-text) !important");
  assert.equal(getDeclarationValue(itLaunchBody, "color"), "var(--tone-status-text) !important");
});

test("semantic color polish uses shared tone tokens for weather and pills", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const toneBody = getLastRuleBody(css, "(?:^|\\r?\\n)body");
  const hotBody = getLastSelectorBody(css, ".weather-temperature-hot");
  const coldBody = getLastSelectorBody(css, ".weather-temperature-cold");
  const highLowBody = getLastRuleBody(
    css,
    "\\.employee-weather-range-item:first-child,\\s*\\.settings-weather-range-item:first-child"
  );
  const pillSizeBody = getLastRuleBody(
    css,
    "\\.notice-type,\\s*\\.feed-type,\\s*\\.priority-pill,\\s*\\.sync-pill,\\s*\\.settings-chip,\\s*\\.count-pill,\\s*\\.status-chip,\\s*\\.admin-table-chip,\\s*\\.request-status,\\s*\\.employee-status-ribbon \\.employee-status-pill"
  );
  const successPillBody = getLastRuleBody(
    css,
    "\\.request-status\\.success,\\s*\\.admin-table-chip\\.is-positive,\\s*\\.employee-status-ribbon \\.employee-status-pill:first-child"
  );
  const urgentPillBody = getLastRuleBody(
    css,
    "\\.priority-pill\\.urgent,\\s*\\.request-status\\.danger,\\s*\\.employee-status-ribbon \\.employee-status-pill:nth-child\\(2\\)"
  );
  const employeeUrgentPillBody = getLastSelectorBody(css, ".page-shell.employee-shell .priority-pill.urgent");

  assert.match(app, /const weatherTemperatureTones = Object\.freeze\(\[/);
  assert.match(app, /function getWeatherTemperatureToneClass\(value\)/);
  assert.match(app, /return "weather-temperature-neutral"/);
  assert.match(toneBody, /--tone-info-bg:\s*#dbeafe/);
  assert.match(toneBody, /--tone-success-text:\s*#166534/);
  assert.match(toneBody, /--tone-danger-text:\s*#b42318/);
  assert.match(toneBody, /--weather-hot:\s*#dc2626/);
  assert.equal(getDeclarationValue(hotBody, "color"), "var(--weather-hot) !important");
  assert.equal(getDeclarationValue(coldBody, "color"), "var(--weather-cold) !important");
  assert.equal(getDeclarationValue(highLowBody, "color"), "var(--tone-danger-text)");
  assert.equal(getDeclarationValue(pillSizeBody, "font-size"), "0.9rem !important");
  assert.equal(getDeclarationValue(pillSizeBody, "font-weight"), "850 !important");
  assert.equal(getDeclarationValue(successPillBody, "background"), "var(--tone-success-bg) !important");
  assert.equal(getDeclarationValue(urgentPillBody, "background"), "var(--tone-danger-bg) !important");
  assert.equal(getDeclarationValue(employeeUrgentPillBody, "color"), "var(--danger) !important");
  assert.equal(getDeclarationValue(employeeUrgentPillBody, "background"), "var(--danger-soft) !important");
  assert.equal(getDeclarationValue(employeeUrgentPillBody, "border-color"), "var(--danger) !important");
});

test("all operational pages share final readable controls, pills, and card geometry", async () => {
  const css = await loadStylesheet();
  const allPageLayerStart = css.indexOf("/* All-page consistency pass. */");
  const allPageLayer = css.slice(allPageLayerStart);
  const activeTabBody = getLastSelectorBody(css, ".page-shell:is(.hr-shell, .webmaster-shell, .it-shell) .tab-button.active");
  const mobileShellBody = getLastRuleBody(
    css,
    "@media \\(max-width: 720px\\)\\s*\\{[\\s\\S]*?\\.page-shell:is\\(\\.employee-shell, \\.hr-shell, \\.webmaster-shell, \\.it-shell\\)"
  );
  const mobilePillBody = getLastRuleBody(
    css,
    "@media \\(max-width: 720px\\)\\s*\\{[\\s\\S]*?\\.page-shell:is\\(\\.employee-shell, \\.hr-shell, \\.webmaster-shell, \\.it-shell\\) :is\\([\\s\\S]*?\\.notice-type,[\\s\\S]*?\\.employee-status-ribbon \\.employee-status-pill[\\s\\S]*?\\)"
  );

  assert.match(css, /\/\* All-page consistency pass\. \*\//);
  assert.notEqual(allPageLayerStart, -1);
  assert.match(allPageLayer, /\.empty-state\s*\)\s*\{[\s\S]*?border-radius:\s*var\(--radius-control\) !important;/);
  assert.match(allPageLayer, /\.settings-collapse-toggle\s*\)\s*\{[\s\S]*?min-height:\s*44px !important;[\s\S]*?text-transform:\s*none !important;/);
  assert.match(allPageLayer, /\.employee-status-ribbon \.employee-status-pill\s*\)\s*\{[\s\S]*?display:\s*inline-flex !important;[\s\S]*?min-height:\s*30px !important;[\s\S]*?border-radius:\s*var\(--radius-control\) !important;[\s\S]*?font-size:\s*0\.9rem !important;/);
  assert.match(allPageLayer, /\.notice-card[\s\S]*?\) :is\(\.feed-type, \.priority-pill, \.notice-type\)\s*\{[\s\S]*?border-radius:\s*var\(--radius-control\) !important;[\s\S]*?text-transform:\s*none !important;/);
  assert.match(allPageLayer, /\.employee-status-ribbon \.employee-status-pill:nth-child\(3\)\s*\)\s*\{[\s\S]*?background:\s*var\(--tone-status-bg\) !important;/);
  assert.match(allPageLayer, /\.employee-status-ribbon \.employee-status-pill:nth-child\(2\)\s*\)\s*\{[\s\S]*?background:\s*var\(--tone-danger-bg\) !important;/);
  assert.match(allPageLayer, /\.request-status\.danger,[\s\S]*?\.employee-status-ribbon \.employee-status-pill:nth-child\(2\)\s*\)\s*\{[\s\S]*?background:\s*var\(--tone-danger-bg\) !important;/);
  assert.equal(getDeclarationValue(activeTabBody, "background"), "var(--tone-info-bg) !important");
  assert.equal(getDeclarationValue(mobileShellBody, "width"), "min(100%, calc(100vw - 16px)) !important");
  assert.equal(getDeclarationValue(mobilePillBody, "font-size"), "0.86rem !important");
});

test("webmaster overview aligns the shell, cards, and snapshot badge", async () => {
  const css = await loadStylesheet();
  const allPageLayerStart = css.indexOf("/* All-page consistency pass. */");
  const allPageLayerMediaStart = css.indexOf("@media (max-width: 720px)", allPageLayerStart);
  const desktopCss = css.slice(allPageLayerStart, allPageLayerMediaStart);
  const finalGridLayerStart = css.indexOf("/* Final grid row compaction");
  const finalGridMobileStart = css.indexOf("@media (max-width: 720px)", finalGridLayerStart);
  const finalGridDesktopCss = css.slice(finalGridLayerStart, finalGridMobileStart);
  const finalGridMobileCss = css.slice(finalGridMobileStart);
  const webmasterShellBody = getLastSelectorBody(css, ".page-shell.webmaster-shell");
  const webmasterContentBody = getLastRuleBody(
    desktopCss,
    "\\.page-shell\\.webmaster-shell \\.page-head,\\s*\\.page-shell\\.webmaster-shell \\.hero-strip,\\s*\\.page-shell\\.webmaster-shell \\.tab-bar,\\s*\\.page-shell\\.webmaster-shell \\.panel-stack"
  );
  const finalWebmasterHeadBody = getLastSelectorBody(finalGridDesktopCss, ".page-shell.webmaster-shell .page-head");
  const webmasterPanelTitleBody = getLastSelectorBody(desktopCss, ".page-shell.webmaster-shell .panel-title-wide");
  const webmasterPanelPillBody = getLastSelectorBody(desktopCss, ".page-shell.webmaster-shell .panel-title-wide .sync-pill");
  const finalMobileWebmasterHeadBody = getLastSelectorBody(finalGridMobileCss, ".page-shell.webmaster-shell .page-head");
  const mobilePanelTitleBody = getLastRuleBody(
    css,
    "@media \\(max-width: 720px\\)\\s*\\{[\\s\\S]*?\\.page-shell\\.webmaster-shell \\.panel-title-wide"
  );
  const mobileActionsBody = getLastRuleBody(
    css,
    "@media \\(max-width: 720px\\)\\s*\\{[\\s\\S]*?\\.page-shell\\.webmaster-shell \\.page-head \\.page-actions"
  );

  assert.equal(getDeclarationValue(webmasterShellBody, "width"), "min(1440px, calc(100vw - 96px)) !important");
  assert.equal(getDeclarationValue(webmasterContentBody, "width"), "min(100%, 1204px)");
  assert.equal(getDeclarationValue(webmasterContentBody, "margin-inline"), "auto");
  assert.equal(getDeclarationValue(finalWebmasterHeadBody, "width"), "fit-content !important");
  assert.equal(getDeclarationValue(finalWebmasterHeadBody, "max-width"), "100% !important");
  assert.equal(getDeclarationValue(finalWebmasterHeadBody, "grid-template-columns"), "max-content auto !important");
  assert.equal(getDeclarationValue(finalWebmasterHeadBody, "justify-self"), "center !important");
  assert.equal(getDeclarationValue(finalWebmasterHeadBody, "margin-inline"), "auto !important");
  assert.equal(getDeclarationValue(webmasterPanelTitleBody, "grid-template-columns"), "minmax(0, 1fr) auto");
  assert.equal(getDeclarationValue(webmasterPanelTitleBody, "width"), "min(100%, 1204px)");
  assert.equal(getDeclarationValue(webmasterPanelPillBody, "justify-self"), "end");
  assert.equal(getDeclarationValue(finalMobileWebmasterHeadBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(finalMobileWebmasterHeadBody, "justify-self"), "stretch !important");
  assert.equal(getDeclarationValue(mobilePanelTitleBody, "grid-template-columns"), "1fr");
  assert.equal(getDeclarationValue(mobileActionsBody, "display"), "grid");
  assert.equal(getDeclarationValue(mobileActionsBody, "grid-template-columns"), "repeat(2, minmax(0, 1fr)) !important");
});

test("hr, webmaster, and it shells share the employee-width content column", async () => {
  const css = await loadStylesheet();
  const finalGridLayerStart = css.indexOf("/* Final grid row compaction");
  const finalGridMobileStart = css.indexOf("@media (max-width: 720px)", finalGridLayerStart);
  const desktopCss = css.slice(finalGridLayerStart, finalGridMobileStart);
  const mobileCss = css.slice(finalGridMobileStart);
  const sharedAdminShellBody = getLastSelectorBody(desktopCss, ".page-shell:is(.hr-shell, .webmaster-shell, .it-shell)");
  const mobileSharedAdminShellBody = getLastSelectorBody(mobileCss, ".page-shell:is(.hr-shell, .webmaster-shell, .it-shell)");
  const sharedAdminContentBody = getLastRuleBody(
    desktopCss,
    "\\.page-shell:is\\(\\.hr-shell, \\.webmaster-shell, \\.it-shell\\) :is\\(\\s*\\.page-head,\\s*\\.hero-strip,\\s*\\.tab-bar,\\s*\\.panel-surface,\\s*\\.panel-stack,\\s*\\.admin-banner,\\s*\\.hr-banner,\\s*\\.webmaster-banner\\s*\\)"
  );

  assert.notEqual(finalGridLayerStart, -1);
  assert.equal(getDeclarationValue(sharedAdminShellBody, "--control-center-column-width"), "min(720px, calc(100vw - 64px))");
  assert.equal(getDeclarationValue(sharedAdminContentBody, "width"), "var(--control-center-column-width) !important");
  assert.equal(getDeclarationValue(sharedAdminContentBody, "max-width"), "var(--control-center-column-width) !important");
  assert.equal(getDeclarationValue(sharedAdminContentBody, "margin-inline"), "auto !important");
  assert.equal(getDeclarationValue(sharedAdminContentBody, "box-sizing"), "border-box");
  assert.equal(getDeclarationValue(mobileSharedAdminShellBody, "--control-center-column-width"), "min(100%, calc(100vw - 24px))");
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

test("HR console keeps publishing and feed control in one workspace", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const hrFeedWorkspaceBody = getLastSelectorBody(css, ".hr-shell .hr-feed-workspace");
  const hrFeedWorkspaceChildrenBody = getLastRuleBody(
    css,
    "\\.hr-shell \\.hr-feed-workspace > \\.composer-panel,\\s*\\.hr-shell \\.hr-feed-workspace > \\.hr-feed-preview"
  );
  const hrFeedPreviewBody = getLastSelectorBody(css, ".hr-shell .hr-feed-preview");
  const hrFeedPreviewListBody = getLastRuleBody(
    css,
    "\\.hr-shell \\.hr-feed-preview \\.feed-list,\\s*\\.hr-shell \\.hr-feed-preview \\.feed-list-quiet"
  );
  const alignedManagedFeedItemBody = getLastSelectorBody(css, ".hr-shell .hr-feed-preview .managed-feed-item");
  const managedFeedItemBody = getLastSelectorBody(css, ".hr-shell .managed-feed-item");
  const managedFeedHeadBody = getLastSelectorBody(css, ".hr-shell .managed-feed-item .feed-head");
  const managedFeedHeadSideBody = getLastSelectorBody(css, ".hr-shell .managed-feed-item .feed-head-side");
  const managedFeedPillBody = getLastRuleBody(
    css,
    "\\.hr-shell \\.managed-feed-item \\.feed-type,\\s*\\.hr-shell \\.managed-feed-item \\.priority-pill"
  );
  const managedFeedTitleBody = getLastSelectorBody(css, ".hr-shell .managed-feed-item .feed-title");
  const hrFeedPanelSource = app.match(/function renderHrFeedPanel\(\) \{[\s\S]*?\n\}\n\nfunction renderSecurityEventCard/)?.[0] || "";

  assert.match(app, /let activeAdminTab = "feed"/);
  assert.match(app, /const adminTabs = \[\s*\{ id: "feed", label: "Feed", icon: "news" \}/);
  assert.match(app, /function renderHrFeedPanel/);
  assert.match(app, /renderHrFeedPanel\(\)/);
  assert.doesNotMatch(hrFeedPanelSource, /<h2>Feed control<\/h2>/);
  assert.doesNotMatch(hrFeedPanelSource, /\$\{notices\.length\} live/);
  assert.match(app, /aria-label="HR feed control center"/);
  assert.match(app, /<form data-post-form>/);
  assert.match(app, /notices\.map\(\(post\) => renderManagedFeedItem\(post\)\)/);
  assert.match(app, /data-delete-post/);
  assert.match(app, /function createPost/);
  assert.match(app, /function handlePostSubmit/);
  assert.match(app, /function handleDeleteAction/);
  assert.doesNotMatch(app, /activeAdminTab = "publish"/);
  assert.doesNotMatch(app, /activeAdminTab === "publish"/);
  assert.doesNotMatch(app, /\{ id: "publish", label: "Publish"/);
  assert.doesNotMatch(app, /renderAdminPublishPanel\(\)[\s\S]*: activeAdminTab === "share"/);
  assert.equal(getDeclarationValue(hrFeedWorkspaceBody, "grid-template-columns"), "minmax(0, 1fr) !important");
  assert.equal(getDeclarationValue(hrFeedWorkspaceBody, "gap"), "12px !important");
  assert.equal(getDeclarationValue(hrFeedWorkspaceChildrenBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(hrFeedWorkspaceChildrenBody, "max-width"), "100% !important");
  assert.equal(getDeclarationValue(hrFeedWorkspaceChildrenBody, "justify-self"), "stretch");
  assert.equal(getDeclarationValue(hrFeedPreviewBody, "align-self"), "start !important");
  assert.equal(getDeclarationValue(hrFeedPreviewBody, "padding"), "0 !important");
  assert.equal(getDeclarationValue(hrFeedPreviewBody, "border"), "0 !important");
  assert.equal(getDeclarationValue(hrFeedPreviewListBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(hrFeedPreviewListBody, "max-width"), "100% !important");
  assert.equal(getDeclarationValue(hrFeedPreviewListBody, "margin"), "0 !important");
  assert.equal(getDeclarationValue(alignedManagedFeedItemBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(alignedManagedFeedItemBody, "max-width"), "100% !important");
  assert.equal(getDeclarationValue(managedFeedItemBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(managedFeedItemBody, "align-items"), "start !important");
  assert.equal(getDeclarationValue(managedFeedHeadBody, "align-items"), "start !important");
  assert.equal(getDeclarationValue(managedFeedHeadSideBody, "align-items"), "start !important");
  assert.equal(getDeclarationValue(managedFeedPillBody, "border-radius"), "var(--radius-control) !important");
  assert.equal(getDeclarationValue(managedFeedPillBody, "text-transform"), "none !important");
  assert.equal(getDeclarationValue(managedFeedTitleBody, "margin"), "0 !important");
});

test("employee weather renders as a compact source-backed card", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const weatherCardBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-card");
  const weatherLineBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-line");
  const weatherPrimaryLineBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-line-primary");
  const weatherSecondaryLineBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-line-secondary");
  const weatherCurrentBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-current");
  const weatherRangeBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-range");
  const weatherRangeItemBody = getLastSelectorBody(css, ".employee-weather-range-item");
  const weatherRangeLabelBody = getLastSelectorBody(css, ".employee-weather-range-label");
  const weatherUpdatedBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-updated");
  const weatherUpdatedSymbolIconBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.employee-weather-updated-symbol \\.icon");

  assert.match(app, /function renderEmployeeWeatherCard/);
  assert.match(app, /<section class="employee-brand-banner"[\s\S]*?\$\{renderEmployeeWeatherCard\(\)\}[\s\S]*?<\/section>/);
  assert.doesNotMatch(app, /\$\{renderEmployeeSubscriptionBanner\(setup\)\}\s*\$\{renderEmployeeWeatherCard\(\)\}/);
  assert.match(app, /function formatWeatherFreshness/);
  assert.match(app, /class="employee-weather-card employee-weather-card-two-line"/);
  assert.match(app, /class="employee-weather-line employee-weather-line-primary"/);
  assert.match(app, /class="employee-weather-line employee-weather-line-secondary"/);
  assert.match(app, /class="employee-weather-current"/);
  assert.match(app, /const temperatureToneClass = getWeatherTemperatureToneClass\(temperature\)/);
  assert.match(app, /class="employee-weather-temperature \$\{temperatureToneClass\}"/);
  assert.match(app, /class="employee-weather-condition"/);
  assert.match(app, /class="employee-weather-range"/);
  assert.match(app, /class="employee-weather-range-item employee-weather-range-high" aria-label="High temperature"><span class="employee-weather-range-label" aria-hidden="true">[^<]+<\/span>/);
  assert.match(app, /class="employee-weather-range-item employee-weather-range-low" aria-label="Low temperature"><span class="employee-weather-range-label" aria-hidden="true">[^<]+<\/span>/);
  assert.match(app, /escapeHtml\(highTemperature\)/);
  assert.match(app, /escapeHtml\(lowTemperature\)/);
  assert.match(app, /function formatCompactWeatherLocation/);
  assert.match(app, /formatCompactWeatherLocation\(weather\.resolvedName \|\| weather\.location/);
  assert.match(app, /"north carolina": "NC"/);
  assert.match(app, /"united states": "US"/);
  assert.match(app, /class="employee-weather-location"/);
  assert.match(app, /class="employee-weather-updated"/);
  assert.match(app, /const updatedAriaLabel = hasWeatherUpdate \? `Updated \$\{updatedLabel\}` : "Not refreshed"/);
  assert.match(app, /class="employee-weather-updated" aria-label="\$\{escapeHtml\(updatedAriaLabel\)\}"/);
  assert.match(app, /class="employee-weather-updated-symbol" aria-hidden="true">\$\{icon\("clock"\)\}<\/span>/);
  assert.match(app, /return "just now"/);
  assert.match(app, /return `\$\{minutes\} min ago`/);
  assert.doesNotMatch(app, /return "Updated just now"/);
  assert.doesNotMatch(app, /return `Updated \$\{minutes\} min ago`/);
  assert.doesNotMatch(app, /function renderEmployeeWeatherMetric/);
  assert.doesNotMatch(app, /class="employee-weather-metrics"/);
  assert.doesNotMatch(app, /class="employee-weather-chip/);
  assert.doesNotMatch(app, /class="employee-weather-impact"/);
  assert.doesNotMatch(app, /class="employee-weather-freshness"/);
  assert.doesNotMatch(app, /Weather details/);
  assert.doesNotMatch(app, /sourceLabel/);
  assert.doesNotMatch(app, /freshnessLabel/);
  assert.doesNotMatch(app, /class="employee-weather-details"/);
  assert.doesNotMatch(app, /renderEmployeeWeatherDetail/);
  assert.doesNotMatch(app, /const weatherLevel = String\(weather\.level/);

  assert.equal(getDeclarationValue(weatherCardBody, "display"), "grid");
  assert.equal(getDeclarationValue(weatherCardBody, "width"), "fit-content");
  assert.equal(getDeclarationValue(weatherCardBody, "max-width"), "calc(100% - 32px)");
  assert.equal(getDeclarationValue(weatherCardBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(weatherCardBody, "gap"), "6px");
  assert.equal(getDeclarationValue(weatherCardBody, "padding"), "4px 0 !important");
  assert.equal(getDeclarationValue(weatherCardBody, "border"), "0 !important");
  assert.equal(getDeclarationValue(weatherCardBody, "background"), "transparent !important");
  assert.equal(getDeclarationValue(weatherCardBody, "box-shadow"), "none !important");
  assert.equal(getDeclarationValue(weatherLineBody, "justify-content"), "center");
  assert.equal(getDeclarationValue(weatherLineBody, "display"), "flex");
  assert.equal(getDeclarationValue(weatherLineBody, "flex-wrap"), "wrap");
  assert.equal(getDeclarationValue(weatherLineBody, "gap"), "4px 12px");
  assert.equal(getDeclarationValue(weatherLineBody, "line-height"), "1");
  assert.equal(getDeclarationValue(weatherPrimaryLineBody, "align-items"), "baseline");
  assert.equal(getDeclarationValue(weatherPrimaryLineBody, "font-size"), "1rem");
  assert.equal(getDeclarationValue(weatherCurrentBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(weatherCurrentBody, "align-items"), "baseline");
  assert.equal(getDeclarationValue(weatherCurrentBody, "gap"), "6px");
  assert.equal(getDeclarationValue(weatherSecondaryLineBody, "font-size"), "0.82rem");
  assert.equal(getDeclarationValue(weatherRangeBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(weatherRangeBody, "align-items"), "baseline");
  assert.equal(getDeclarationValue(weatherRangeBody, "gap"), "10px");
  assert.equal(getDeclarationValue(weatherRangeBody, "padding-left"), "");
  assert.equal(getDeclarationValue(weatherRangeBody, "border-left"), "");
  assert.equal(getDeclarationValue(weatherRangeBody, "white-space"), "nowrap");
  assert.equal(getDeclarationValue(weatherRangeItemBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(weatherRangeLabelBody, "font-size"), "0.9rem");
  assert.equal(getDeclarationValue(weatherUpdatedBody, "display"), "inline-flex");
  assert.equal(getDeclarationValue(weatherUpdatedSymbolIconBody, "width"), "0.82rem");
  assert.equal(getDeclarationValue(weatherUpdatedSymbolIconBody, "flex"), "0 0 0.82rem");
  assert.match(css, /\.employee-weather-temperature\s*\{[^}]*font-size:\s*1\.65rem;/s);
  assert.match(css, /@media \(max-width: 720px\)\s*\{[\s\S]*?\.employee-weather-temperature\s*\{[^}]*font-size:\s*1\.45rem;/);
  assert.doesNotMatch(css, /\.employee-weather-temperature\s*\{[^}]*font-size:\s*3rem;/s);
  assert.doesNotMatch(css, /\.employee-weather-temperature\s*\{[^}]*font-size:\s*2\.35rem;/s);
});

test("employee feed page uses a static feed/header width with weather in the header", async () => {
  const app = await loadClientApp();
  const css = await loadStylesheet();
  const contentFitLayerStart = css.indexOf("/* Employee content-fit regular-type pass. */");
  const contentFitLayerCss = css.slice(contentFitLayerStart);
  const contentFitDesktopCss = contentFitLayerCss.split("@media (max-width: 720px)")[0];
  const contentFitMobileCss = contentFitLayerCss.slice(contentFitLayerCss.indexOf("@media (max-width: 720px)"));
  const employeeShellBody = getLastRuleBody(css, "(?:^|\\r?\\n)\\.page-shell\\.employee-shell");
  const contentBoxBody = getLastRuleBody(
    contentFitDesktopCss,
    "\\.employee-shell \\.employee-subscription-banner,\\s*\\.employee-shell \\.employee-status-strip,\\s*\\.employee-shell \\.employee-signout-floor"
  );
  const feedAndHeaderStaticBody = getLastRuleBody(
    contentFitDesktopCss,
    "\\.employee-shell \\.employee-brand-banner,\\s*\\.employee-shell \\.feed-shell,\\s*\\.employee-shell \\.feed-list"
  );
  const mobileContentBoxBody = getLastRuleBody(
    contentFitMobileCss,
    "\\.employee-shell \\.employee-subscription-banner,\\s*\\.employee-shell \\.employee-status-strip,\\s*\\.employee-shell \\.employee-signout-floor"
  );
  const mobileFeedAndHeaderStaticBody = getLastRuleBody(
    contentFitMobileCss,
    "\\.employee-shell \\.employee-brand-banner,\\s*\\.employee-shell \\.feed-shell,\\s*\\.employee-shell \\.feed-list"
  );
  const brandBannerBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner");
  const brandHeadBody = getLastRuleBody(
    contentFitDesktopCss,
    "\\.employee-shell \\.employee-brand-banner-head,\\s*\\.employee-shell \\.employee-brand-banner-copy"
  );
  const brandHeadLayoutBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner-head");
  const brandIdentityBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-identity");
  const brandLogoBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner-logo");
  const brandTitleBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner-kicker");
  const brandWeatherBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner .employee-weather-card");
  const brandWeatherLineBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner .employee-weather-line");
  const brandWeatherLineSizeBody = getLastRuleBody(
    contentFitDesktopCss,
    "\\.employee-shell \\.employee-brand-banner \\.employee-weather-line-primary,\\s*\\.employee-shell \\.employee-brand-banner \\.employee-weather-line-secondary"
  );
  const brandWeatherCurrentBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner .employee-weather-current");
  const brandWeatherTemperatureBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner .employee-weather-temperature");
  const brandWeatherTextBody = getLastRuleBody(
    contentFitDesktopCss,
    "\\.employee-shell \\.employee-brand-banner \\.employee-weather-condition,\\s*\\.employee-shell \\.employee-brand-banner \\.employee-weather-range,\\s*\\.employee-shell \\.employee-brand-banner \\.employee-weather-location,\\s*\\.employee-shell \\.employee-brand-banner \\.employee-weather-updated"
  );
  const brandWeatherRangeBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner .employee-weather-range");
  const brandWeatherIconBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .employee-brand-banner .employee-weather-updated-symbol .icon");
  const mobileBrandHeadLayoutBody = getLastSelectorBody(contentFitMobileCss, ".employee-shell .employee-brand-banner-head");
  const mobileBrandIdentityBody = getLastSelectorBody(contentFitMobileCss, ".employee-shell .employee-brand-identity");
  const mobileBrandWeatherBody = getLastSelectorBody(contentFitMobileCss, ".employee-shell .employee-brand-banner .employee-weather-card");
  const mobileBrandWeatherLineBody = getLastSelectorBody(contentFitMobileCss, ".employee-shell .employee-brand-banner .employee-weather-line");
  const feedColumnBody = getLastRuleBody(
    css,
    "\\.employee-subscription-banner,\\s*\\.employee-status-strip,\\s*\\.feed-shell,\\s*\\.feed-list,\\s*\\.employee-signout-floor"
  );
  const employeeSubscriptionBody = getLastRuleBody(css, "\\.employee-shell\\s+\\.employee-subscription-banner");
  const employeeSubscribeButtonBody = getLastSelectorBody(css, ".employee-shell .employee-subscribe-button");
  const feedListBody = getLastRuleBody(contentFitDesktopCss, "\\.employee-shell \\.feed-list,\\s*\\.employee-shell \\.feed-list-quiet");
  const feedItemBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .feed-item");
  const mobileFeedItemBody = getLastSelectorBody(contentFitMobileCss, ".employee-shell .feed-item");
  const employeeFeedHeadBody = getLastSelectorBody(css, ".employee-shell .feed-head");
  const feedTypeBody = getLastRuleBody(contentFitDesktopCss, "\\.employee-shell \\.feed-type,\\s*\\.employee-shell \\.priority-pill");
  const feedTitleBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .feed-title");
  const feedBody = getLastSelectorBody(contentFitDesktopCss, ".employee-shell .feed-body");
  const subscriptionRenderer = app.match(/function renderEmployeeSubscriptionBanner\(setup\) \{[\s\S]*?\n\}\n\nfunction renderEmployeeSetupWizard/)?.[0] || "";
  const setupWizardRenderer = app.match(/function renderEmployeeSetupWizard\(\) \{[\s\S]*?\n\}\n\nfunction renderNotificationDeviceRoster/)?.[0] || "";

  assert.match(app, /class="employee-brand-banner"/);
  assert.match(app, /class="employee-brand-identity"/);
  assert.doesNotMatch(app, /class="employee-brand-utility"/);
  assert.match(app, /<div class="employee-brand-identity">\s*<img class="employee-brand-banner-logo"[\s\S]*?<div class="employee-brand-banner-copy">[\s\S]*?Announcements &amp; Alerts[\s\S]*?<\/div>\s*\$\{renderEmployeeWeatherCard\(\)\}\s*<\/div>\s*<\/div>\s*<\/section>/);
  assert.doesNotMatch(app, /renderEmployeeStatusStrip/);
  assert.doesNotMatch(app, /employee-status-strip/);
  assert.doesNotMatch(app, /\$\{renderEmployeeSubscriptionBanner\(setup\)\}\s*\$\{renderEmployeeStatusStrip\(notices, setup\)\}/);
  assert.equal(getDeclarationValue(employeeShellBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(employeeShellBody, "gap"), "8px");
  assert.equal(getDeclarationValue(employeeShellBody, "align-content"), "start");
  assert.equal(getDeclarationValue(employeeShellBody, "padding"), "12px 0 56px");
  assert.equal(getDeclarationValue(employeeShellBody, "--employee-feed-column-width"), "min(720px, calc(100vw - 64px))");
  assert.equal(getDeclarationValue(contentBoxBody, "width"), "fit-content !important");
  assert.equal(getDeclarationValue(contentBoxBody, "max-width"), "min(760px, calc(100% - 32px)) !important");
  assert.equal(getDeclarationValue(feedAndHeaderStaticBody, "width"), "var(--employee-feed-column-width) !important");
  assert.equal(getDeclarationValue(feedAndHeaderStaticBody, "max-width"), "var(--employee-feed-column-width) !important");
  assert.equal(getDeclarationValue(feedAndHeaderStaticBody, "box-sizing"), "border-box");
  assert.equal(getDeclarationValue(mobileContentBoxBody, "max-width"), "calc(100% - 24px) !important");
  assert.equal(getDeclarationValue(mobileFeedAndHeaderStaticBody, "width"), "min(100%, calc(100vw - 24px)) !important");
  assert.equal(getDeclarationValue(mobileFeedAndHeaderStaticBody, "max-width"), "min(100%, calc(100vw - 24px)) !important");
  assert.equal(getDeclarationValue(brandBannerBody, "padding"), "8px 14px !important");
  assert.equal(getDeclarationValue(brandBannerBody, "gap"), "0 !important");
  assert.equal(getDeclarationValue(brandBannerBody, "min-height"), "0 !important");
  assert.equal(getDeclarationValue(brandBannerBody, "block-size"), "auto !important");
  assert.equal(getDeclarationValue(brandBannerBody, "align-self"), "start !important");
  assert.equal(getDeclarationValue(brandBannerBody, "align-content"), "center !important");
  assert.equal(getDeclarationValue(brandBannerBody, "justify-items"), "stretch !important");
  assert.equal(getDeclarationValue(brandBannerBody, "grid-template-columns"), "minmax(0, 1fr)");
  assert.equal(getDeclarationValue(brandHeadBody, "width"), "auto !important");
  assert.equal(getDeclarationValue(brandHeadLayoutBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(brandHeadLayoutBody, "grid-template-columns"), "1fr !important");
  assert.equal(getDeclarationValue(brandHeadLayoutBody, "align-items"), "center");
  assert.equal(getDeclarationValue(brandHeadLayoutBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(brandHeadLayoutBody, "gap"), "4px !important");
  assert.equal(getDeclarationValue(brandHeadLayoutBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(brandHeadLayoutBody, "justify-self"), "stretch");
  assert.equal(getDeclarationValue(brandIdentityBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(brandIdentityBody, "align-items"), "center");
  assert.equal(getDeclarationValue(brandIdentityBody, "justify-items"), "center !important");
  assert.equal(getDeclarationValue(brandIdentityBody, "grid-column"), "1");
  assert.equal(getDeclarationValue(brandIdentityBody, "justify-self"), "stretch");
  assert.equal(getDeclarationValue(brandIdentityBody, "gap"), "4px !important");
  assert.equal(getDeclarationValue(brandIdentityBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(brandLogoBody, "width"), "72px !important");
  assert.equal(getDeclarationValue(brandLogoBody, "height"), "72px !important");
  assert.equal(getDeclarationValue(brandTitleBody, "font-size"), "0.98rem !important");
  assert.equal(getDeclarationValue(brandTitleBody, "font-weight"), "700 !important");
  assert.equal(getDeclarationValue(brandTitleBody, "line-height"), "1.15 !important");
  assert.equal(getDeclarationValue(brandWeatherBody, "border"), "0 !important");
  assert.equal(getDeclarationValue(brandWeatherBody, "background"), "transparent !important");
  assert.equal(getDeclarationValue(brandWeatherBody, "box-shadow"), "none !important");
  assert.equal(getDeclarationValue(brandWeatherBody, "gap"), "2px !important");
  assert.equal(getDeclarationValue(brandWeatherBody, "justify-self"), "center");
  assert.equal(getDeclarationValue(brandWeatherBody, "margin"), "0 !important");
  assert.equal(getDeclarationValue(brandWeatherBody, "text-align"), "center");
  assert.equal(getDeclarationValue(brandWeatherLineBody, "align-items"), "center");
  assert.equal(getDeclarationValue(brandWeatherLineBody, "gap"), "2px 6px !important");
  assert.equal(getDeclarationValue(brandWeatherLineBody, "justify-content"), "center");
  assert.equal(getDeclarationValue(brandWeatherLineSizeBody, "font-size"), "16px !important");
  assert.equal(getDeclarationValue(brandWeatherLineSizeBody, "line-height"), "1.1 !important");
  assert.equal(getDeclarationValue(brandWeatherCurrentBody, "align-items"), "center");
  assert.equal(getDeclarationValue(brandWeatherCurrentBody, "gap"), "4px !important");
  assert.equal(getDeclarationValue(brandWeatherTemperatureBody, "font-size"), "16px !important");
  assert.equal(getDeclarationValue(brandWeatherTemperatureBody, "font-weight"), "700 !important");
  assert.equal(getDeclarationValue(brandWeatherTemperatureBody, "line-height"), "1 !important");
  assert.equal(getDeclarationValue(brandWeatherTextBody, "font-size"), "16px !important");
  assert.equal(getDeclarationValue(brandWeatherTextBody, "line-height"), "1.1 !important");
  assert.equal(getDeclarationValue(brandWeatherRangeBody, "gap"), "6px !important");
  assert.equal(getDeclarationValue(brandWeatherRangeBody, "padding-left"), "6px !important");
  assert.equal(getDeclarationValue(brandWeatherIconBody, "width"), "12px !important");
  assert.equal(getDeclarationValue(brandWeatherIconBody, "height"), "12px !important");
  assert.equal(getDeclarationValue(mobileBrandHeadLayoutBody, "grid-template-columns"), "1fr !important");
  assert.equal(getDeclarationValue(mobileBrandHeadLayoutBody, "justify-items"), "center");
  assert.equal(getDeclarationValue(mobileBrandHeadLayoutBody, "gap"), "6px !important");
  assert.equal(getDeclarationValue(mobileBrandIdentityBody, "justify-content"), "center");
  assert.equal(getDeclarationValue(mobileBrandIdentityBody, "justify-self"), "center");
  assert.equal(getDeclarationValue(mobileBrandWeatherBody, "justify-self"), "center");
  assert.equal(getDeclarationValue(mobileBrandWeatherBody, "text-align"), "center");
  assert.equal(getDeclarationValue(mobileBrandWeatherLineBody, "justify-content"), "center");
  assert.equal(getDeclarationValue(feedColumnBody, "width"), "min(760px, calc(100% - 32px))");
  assert.ok(subscriptionRenderer);
  assert.ok(setupWizardRenderer);
  assert.match(subscriptionRenderer, /<section class="employee-subscription-banner warning" aria-label="Subscribe to alerts">/);
  assert.match(subscriptionRenderer, /\$\{renderEmployeeSetupWizard\(\)\}/);
  assert.match(setupWizardRenderer, /class="button employee-subscribe-button"/);
  assert.match(setupWizardRenderer, /aria-label="\$\{escapeHtml\(setup\.primaryAction\.label\)\}"/);
  assert.doesNotMatch(setupWizardRenderer, /title="\$\{escapeHtml\(setup\.primaryAction\.label\)\}"/);
  assert.doesNotMatch(subscriptionRenderer, /employee-subscription-banner-head/);
  assert.doesNotMatch(subscriptionRenderer, /employee-subscription-banner-copy/);
  assert.doesNotMatch(subscriptionRenderer, /employee-subscription-banner-checklist/);
  assert.doesNotMatch(subscriptionRenderer, /Not subscribed/);
  assert.doesNotMatch(subscriptionRenderer, /Finish alert setup for this phone/);
  assert.doesNotMatch(subscriptionRenderer, /Finish phone install to receive alerts/);
  assert.doesNotMatch(subscriptionRenderer, /renderDeviceChecklistItem\(item, true\)/);
  assert.doesNotMatch(setupWizardRenderer, /\$\{escapeHtml\(setup\.primaryAction\.label\)\}\s*<\/button>/);
  assert.equal(getDeclarationValue(employeeSubscriptionBody, "padding"), "0");
  assert.equal(getDeclarationValue(employeeSubscriptionBody, "gap"), "0");
  assert.equal(getDeclarationValue(employeeSubscriptionBody, "background"), "transparent !important");
  assert.equal(getDeclarationValue(employeeSubscriptionBody, "border"), "0 !important");
  assert.equal(getDeclarationValue(employeeSubscriptionBody, "box-shadow"), "none !important");
  assert.equal(getDeclarationValue(employeeSubscribeButtonBody, "width"), "auto");
  assert.equal(getDeclarationValue(employeeSubscribeButtonBody, "height"), "48px");
  assert.equal(getDeclarationValue(employeeSubscribeButtonBody, "padding"), "0 14px");
  assert.equal(getDeclarationValue(feedListBody, "justify-items"), "stretch");
  assert.equal(getDeclarationValue(feedItemBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(feedItemBody, "min-width"), "0");
  assert.equal(getDeclarationValue(feedItemBody, "max-width"), "100%");
  assert.equal(getDeclarationValue(mobileFeedItemBody, "width"), "100% !important");
  assert.equal(getDeclarationValue(mobileFeedItemBody, "min-width"), "0");
  assert.equal(getDeclarationValue(employeeFeedHeadBody, "display"), "grid !important");
  assert.equal(getDeclarationValue(feedTypeBody, "letter-spacing"), "0.02em !important");
  assert.equal(getDeclarationValue(feedTypeBody, "text-transform"), "none !important");
  assert.equal(getDeclarationValue(feedTitleBody, "font-weight"), "700 !important");
  assert.equal(getDeclarationValue(feedBody, "font-weight"), "400 !important");
  assert.match(css, /\.employee-shell \.feed-item\s*\{[^}]*border-left:\s*6px solid var\(--steel\) !important;/s);
  assert.match(css, /\.employee-shell \.feed-item\.priority-important\s*\{[^}]*border-left-color:\s*var\(--signal\) !important;/s);
  assert.match(css, /\.employee-shell \.feed-type,\s*\.employee-shell \.priority-pill,\s*\.employee-shell \.notice-type\s*\{[^}]*border-radius:\s*var\(--radius-control\) !important;/s);
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
    "\\.panel-title h3,\\s*\\.notice-card h2,\\s*\\.notice-card h3,\\s*\\.feed-title,\\s*\\.employee-weather-condition"
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

test("client app keeps employee weather and alert setup surfaces wired", async () => {
  const app = await loadClientApp();

  assert.match(app, /requestJson\("\/api\/weather"\)/);
  assert.match(app, /function renderEmployeeSubscriptionBanner/);
  assert.doesNotMatch(app, /function renderEmployeeStatusStrip/);
  assert.doesNotMatch(app, /employee-status-strip/);
  assert.match(app, /data-weather-form/);
});
