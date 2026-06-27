export function resolveDeviceSetupAction({ submitterAction, primaryActionId } = {}) {
  const explicitAction = String(submitterAction || "").trim();

  if (explicitAction === "push" || explicitAction === "profile") {
    return explicitAction;
  }

  const fallbackAction = String(primaryActionId || "").trim();
  if (fallbackAction === "push" || fallbackAction === "profile") {
    return fallbackAction;
  }

  return "profile";
}

export function resolveDeviceSetupSecondaryAction({ hasCurrentDevice } = {}) {
  return hasCurrentDevice ? "disable-alerts" : null;
}
