(function registerServiceWorkerRouting(globalScope) {
  const APP_BASE_PATH = "/palzivalerts";
  const EMPLOYEE_PATH = `${APP_BASE_PATH}/employee`;
  const LAUNCHER_PATH = APP_BASE_PATH;
  const APPLE_LAUNCHER_PATH = `${APP_BASE_PATH}/`;

  function normalizeRelativeNotificationUrl(value, fallbackPath) {
    const fallback = typeof fallbackPath === "string" && fallbackPath.startsWith("/") ? fallbackPath : EMPLOYEE_PATH;
    const text = String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);

    if (!text || !text.startsWith("/") || text.startsWith("//") || text.includes("\\")) {
      return fallback;
    }

    try {
      const parsed = new URL(text, "https://palziv.invalid");

      if (parsed.origin !== "https://palziv.invalid") {
        return fallback;
      }

      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return fallback;
    }
  }

  function normalizePortalUrl(rawUrl, origin, fallbackPath) {
    return new URL(normalizeRelativeNotificationUrl(rawUrl, fallbackPath), origin).href;
  }

  function pageKind(href, origin) {
    try {
      const parsed = new URL(href);

      if (parsed.origin !== origin) {
        return "external";
      }

      if (parsed.pathname === LAUNCHER_PATH || parsed.pathname === APPLE_LAUNCHER_PATH) {
        return "launcher";
      }

      if (parsed.pathname === EMPLOYEE_PATH) {
        return "employee";
      }

      if (parsed.pathname === `${APP_BASE_PATH}/hr` || parsed.pathname === `${APP_BASE_PATH}/admin`) {
        return "hr";
      }

      if (parsed.pathname === `${APP_BASE_PATH}/webmaster`) {
        return "webmaster";
      }

      if (parsed.pathname.startsWith(`${APP_BASE_PATH}/`)) {
        return "app";
      }

      return "other";
    } catch {
      return "other";
    }
  }

  function sameDocument(a, b) {
    try {
      const left = new URL(a);
      const right = new URL(b);
      return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search;
    } catch {
      return false;
    }
  }

  function reusableKindsForTarget(kind) {
    if (kind === "launcher" || kind === "employee") {
      return new Set(["launcher", "employee"]);
    }

    if (kind === "hr" || kind === "webmaster") {
      return new Set([kind]);
    }

    return new Set();
  }

  function chooseNotificationClient(clients, targetHref, origin) {
    const targetKind = pageKind(targetHref, origin);
    const reusableKinds = reusableKindsForTarget(targetKind);

    if (!reusableKinds.size) {
      return null;
    }

    const candidates = clients.filter((client) => reusableKinds.has(pageKind(client?.url || "", origin)));

    if (!candidates.length) {
      return null;
    }

    return candidates.find((client) => sameDocument(client.url, targetHref)) || candidates[0];
  }

  globalScope.__palzivSwRouting = {
    normalizePortalUrl,
    chooseNotificationClient
  };
})(self);
