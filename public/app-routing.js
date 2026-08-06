function installProfileForRoute(route = "launcher") {
  return route === "hr" ? "hr" : "employee";
}

export function requiresInstallProfileReload(currentRoute, nextRoute) {
  return installProfileForRoute(currentRoute) !== installProfileForRoute(nextRoute);
}
