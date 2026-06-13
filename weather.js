const OPEN_METEO_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const WEATHER_LEVELS = new Set(["Clear", "Watch", "Warning"]);

const WEATHER_LOOKUP = new Map([
  [0, { condition: "Clear sky", level: "Clear", impact: "Normal operations." }],
  [1, { condition: "Mainly clear", level: "Clear", impact: "Normal operations." }],
  [2, { condition: "Partly cloudy", level: "Watch", impact: "Changing conditions may affect outdoor work." }],
  [3, { condition: "Overcast", level: "Watch", impact: "Keep an eye on changing conditions." }],
  [45, { condition: "Fog", level: "Watch", impact: "Reduced visibility near roads and entrances." }],
  [48, { condition: "Rime fog", level: "Watch", impact: "Reduced visibility near roads and entrances." }],
  [51, { condition: "Light drizzle", level: "Watch", impact: "Wet floors possible near entrances." }],
  [53, { condition: "Drizzle", level: "Watch", impact: "Wet floors possible near entrances." }],
  [55, { condition: "Dense drizzle", level: "Watch", impact: "Wet floors possible near entrances." }],
  [56, { condition: "Freezing drizzle", level: "Warning", impact: "Slippery surfaces likely." }],
  [57, { condition: "Dense freezing drizzle", level: "Warning", impact: "Slippery surfaces likely." }],
  [61, { condition: "Light rain", level: "Watch", impact: "Wet floors possible near entrances." }],
  [63, { condition: "Rain", level: "Watch", impact: "Wet floors possible near entrances." }],
  [65, { condition: "Heavy rain", level: "Warning", impact: "Outdoor work and travel may be disrupted." }],
  [66, { condition: "Freezing rain", level: "Warning", impact: "Slippery surfaces likely." }],
  [67, { condition: "Heavy freezing rain", level: "Warning", impact: "Slippery surfaces likely." }],
  [71, { condition: "Light snow", level: "Watch", impact: "Slippery surfaces possible." }],
  [73, { condition: "Snow", level: "Watch", impact: "Slippery surfaces possible." }],
  [75, { condition: "Heavy snow", level: "Warning", impact: "Slippery surfaces likely." }],
  [77, { condition: "Snow grains", level: "Watch", impact: "Slippery surfaces possible." }],
  [80, { condition: "Rain showers", level: "Watch", impact: "Wet surfaces and brief interruptions possible." }],
  [81, { condition: "Heavy rain showers", level: "Watch", impact: "Wet surfaces and brief interruptions possible." }],
  [82, { condition: "Violent rain showers", level: "Warning", impact: "Outdoor work and travel may be disrupted." }],
  [85, { condition: "Snow showers", level: "Watch", impact: "Slippery surfaces possible." }],
  [86, { condition: "Heavy snow showers", level: "Warning", impact: "Slippery surfaces likely." }],
  [95, { condition: "Thunderstorm", level: "Warning", impact: "Outdoor work should pause during lightning." }],
  [96, { condition: "Thunderstorm with hail", level: "Warning", impact: "Outdoor work should pause during lightning." }],
  [99, { condition: "Thunderstorm with heavy hail", level: "Warning", impact: "Outdoor work should pause during lightning." }]
]);

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanLongText(value, maxLength) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function nowIso() {
  return new Date().toISOString();
}

function buildLocationSearchTerms(location) {
  const compact = cleanText(location, 120);
  const withoutCommas = compact.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const firstSegment = compact.split(",")[0]?.trim();

  return [...new Set([compact, withoutCommas, firstSegment].filter(Boolean))];
}

function createDefaultWeather() {
  return {
    location: "",
    resolvedName: "",
    condition: "Weather not configured",
    temperature: "--",
    impact: "Enter a location in Admin to fetch live weather.",
    level: "Clear",
    updatedAt: ""
  };
}

function normalizeStoredWeather(input) {
  if (!input || typeof input !== "object") {
    return createDefaultWeather();
  }

  const level = WEATHER_LEVELS.has(input.level) ? input.level : "Clear";

  return {
    location: cleanText(input.location, 120),
    resolvedName: cleanText(input.resolvedName, 120),
    condition: cleanText(input.condition, 80) || "Weather not configured",
    temperature: cleanText(input.temperature, 24) || "--",
    impact: cleanLongText(input.impact, 300) || "Enter a location in Admin to fetch live weather.",
    level,
    updatedAt: cleanText(input.updatedAt, 40)
  };
}

function formatResolvedName(result) {
  return [result.name, result.admin1, result.country]
    .filter(Boolean)
    .map((part) => String(part).trim())
    .join(", ");
}

function weatherDetailsForCode(code) {
  return WEATHER_LOOKUP.get(Number(code)) || {
    condition: "Current conditions",
    level: "Watch",
    impact: "Review local travel and outdoor work conditions."
  };
}

function formatTemperature(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "--";
  }

  return `${Math.round(number)}°F`;
}

function buildImpact(code, windSpeed) {
  const details = weatherDetailsForCode(code);
  const parts = [details.impact];

  const windValue = Number(windSpeed);
  if (Number.isFinite(windValue) && windValue >= 18) {
    parts.push(`Wind around ${Math.round(windValue)} mph may affect outdoor work.`);
  }

  return parts.join(" ");
}

async function fetchJson(fetchImpl, url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });

    const raw = await response.text();
    let data = {};

    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("Weather service returned invalid JSON.");
      }
    }

    if (!response.ok) {
      const reason = cleanText(data.reason || data.error || response.statusText, 160);
      throw new Error(reason || `Weather service returned ${response.status}.`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveLiveWeather(locationInput, fetchImpl = globalThis.fetch) {
  const location = cleanText(locationInput, 120);

  if (!location) {
    throw new Error("Location is required.");
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("Weather lookup is not available in this runtime.");
  }

  let match = null;

  for (const searchTerm of buildLocationSearchTerms(location)) {
    const geocodeUrl = new URL(OPEN_METEO_GEOCODING_URL);
    geocodeUrl.search = new URLSearchParams({
      name: searchTerm,
      count: "5",
      language: "en",
      format: "json"
    }).toString();

    const geocode = await fetchJson(fetchImpl, geocodeUrl);
    match = geocode.results?.[0];

    if (match) {
      break;
    }
  }

  if (!match) {
    throw new Error(`No weather location found for "${location}".`);
  }

  const forecastUrl = new URL(OPEN_METEO_FORECAST_URL);
  forecastUrl.search = new URLSearchParams({
    latitude: String(match.latitude),
    longitude: String(match.longitude),
    current_weather: "true",
    timezone: "auto",
    temperature_unit: "fahrenheit",
    windspeed_unit: "mph"
  }).toString();

  const forecast = await fetchJson(fetchImpl, forecastUrl);
  const current = forecast.current_weather;

  if (!current) {
    throw new Error(`Open-Meteo did not return current weather for "${location}".`);
  }

  const details = weatherDetailsForCode(current.weathercode);

  return {
    location,
    resolvedName: formatResolvedName(match),
    condition: details.condition,
    temperature: formatTemperature(current.temperature),
    impact: buildImpact(current.weathercode, current.windspeed),
    level: details.level,
    updatedAt: nowIso()
  };
}

export {
  buildImpact,
  createDefaultWeather,
  formatResolvedName,
  formatTemperature,
  normalizeStoredWeather,
  resolveLiveWeather,
  weatherDetailsForCode
};
