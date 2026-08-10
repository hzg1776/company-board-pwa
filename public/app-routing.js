function installProfileForRoute(route = "launcher") {
  return route === "hr" ? "hr" : "employee";
}

function installProfileForManifestUrl(manifestUrl = "") {
  try {
    const manifestPath = new URL(String(manifestUrl), "https://app.invalid").pathname;
    return manifestPath === "/manifest-hr.webmanifest" ? "hr" : "employee";
  } catch {
    return "employee";
  }
}

export function requiresInstallProfileReload(currentRoute, nextRoute) {
  return installProfileForRoute(currentRoute) !== installProfileForRoute(nextRoute);
}

export function requiresDocumentProfileReload(manifestUrl, route) {
  return installProfileForManifestUrl(manifestUrl) !== installProfileForRoute(route);
}
