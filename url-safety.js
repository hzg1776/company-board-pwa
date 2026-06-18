function cleanRelativeText(value, maxLength = 200) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeRelativeAppPath(value, fallback = "/palzivalerts/employee") {
  const text = cleanRelativeText(value);
  const fallbackText = cleanRelativeText(fallback) || "/palzivalerts/employee";

  if (!text || !text.startsWith("/") || text.startsWith("//") || text.includes("\\")) {
    return fallbackText;
  }

  try {
    const parsed = new URL(text, "https://palziv.invalid");

    if (parsed.origin !== "https://palziv.invalid") {
      return fallbackText;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallbackText;
  }
}
