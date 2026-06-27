import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultWeather,
  DEFAULT_AUTO_WEATHER_LOCATION,
  normalizeStoredWeather,
  resolveAutoWeatherLocation,
  resolveLiveWeather,
  shouldAutoRefreshWeather
} from "../weather.js";

function jsonResponse(body, status = 200, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return JSON.stringify(body);
    }
  };
}

test("createDefaultWeather returns a placeholder snapshot", () => {
  const weather = createDefaultWeather();

  assert.equal(weather.location, "");
  assert.equal(weather.resolvedName, "");
  assert.equal(weather.condition, "Weather not configured");
  assert.equal(weather.temperature, "--");
  assert.equal(weather.highTemperature, "--");
  assert.equal(weather.lowTemperature, "--");
  assert.equal(weather.sunrise, "");
  assert.equal(weather.sunset, "");
  assert.equal(weather.level, "Clear");
  assert.equal(weather.updatedAt, "");
});

test("normalizeStoredWeather preserves stored weather fields", () => {
  const weather = normalizeStoredWeather({
    location: "Austin, TX",
    resolvedName: "Austin, Texas, United States",
    condition: "Light rain",
    temperature: "68 F",
    highTemperature: "74 F",
    lowTemperature: "61 F",
    sunrise: "6:14 AM",
    sunset: "8:31 PM",
    impact: "Wet floors possible.",
    level: "Watch",
    updatedAt: "2026-06-12T12:00:00.000Z"
  });

  assert.deepEqual(weather, {
    location: "Austin, TX",
    resolvedName: "Austin, Texas, United States",
    condition: "Light rain",
    temperature: "68 F",
    highTemperature: "74 F",
    lowTemperature: "61 F",
    sunrise: "6:14 AM",
    sunset: "8:31 PM",
    impact: "Wet floors possible.",
    level: "Watch",
    updatedAt: "2026-06-12T12:00:00.000Z"
  });
});

test("resolveAutoWeatherLocation prefers stored weather location and falls back to Palziv North America default", () => {
  assert.equal(resolveAutoWeatherLocation({ location: "Dallas, TX" }), "Dallas, TX");
  assert.equal(resolveAutoWeatherLocation({ location: "" }), DEFAULT_AUTO_WEATHER_LOCATION);
  assert.equal(resolveAutoWeatherLocation(null), DEFAULT_AUTO_WEATHER_LOCATION);
});

test("shouldAutoRefreshWeather refreshes missing or stale weather snapshots", () => {
  const nowMs = Date.parse("2026-06-25T20:00:00.000Z");

  assert.equal(
    shouldAutoRefreshWeather({ location: "27549", updatedAt: "" }, 60 * 60 * 1000, nowMs),
    true
  );
  assert.equal(
    shouldAutoRefreshWeather({ location: "27549", updatedAt: "2026-06-25T19:15:00.000Z" }, 60 * 60 * 1000, nowMs),
    false
  );
  assert.equal(
    shouldAutoRefreshWeather({ location: "27549", updatedAt: "2026-06-25T18:30:00.000Z" }, 60 * 60 * 1000, nowMs),
    true
  );
  assert.equal(
    shouldAutoRefreshWeather({ location: "", updatedAt: "2026-06-25T18:30:00.000Z" }, 60 * 60 * 1000, nowMs),
    true
  );
});

test("resolveLiveWeather looks up geocoding and current weather", async () => {
  const calls = [];

  const fetchMock = async (input) => {
    const url = new URL(String(input));
    calls.push(url);

    if (url.hostname === "geocoding-api.open-meteo.com") {
      return jsonResponse({
        results: [
          {
            name: "Dallas",
            admin1: "Texas",
            country: "United States",
            latitude: 32.7767,
            longitude: -96.797
          }
        ]
      });
    }

    if (url.hostname === "api.open-meteo.com") {
      return jsonResponse({
        current_weather: {
          temperature: 84.2,
          weathercode: 61,
          windspeed: 11.8
        },
        daily: {
          temperature_2m_max: [91.4],
          temperature_2m_min: [73.6],
          sunrise: ["2026-06-25T06:21"],
          sunset: ["2026-06-25T20:34"]
        }
      });
    }

    throw new Error(`Unexpected request for ${url.href}`);
  };

  const weather = await resolveLiveWeather("Dallas, TX", fetchMock);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].hostname, "geocoding-api.open-meteo.com");
  assert.equal(calls[1].hostname, "api.open-meteo.com");
  assert.equal(weather.location, "Dallas, TX");
  assert.equal(weather.resolvedName, "Dallas, Texas, United States");
  assert.equal(weather.condition, "Light rain");
  assert.equal(weather.temperature, "84°F");
  assert.equal(weather.highTemperature, "91°F");
  assert.equal(weather.lowTemperature, "74°F");
  assert.equal(weather.sunrise, "6:21 AM");
  assert.equal(weather.sunset, "8:34 PM");
  assert.equal(weather.level, "Watch");
  assert.match(weather.impact, /Wet floors possible/);
  assert.match(weather.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("resolveLiveWeather retries simplified location terms", async () => {
  const geocodeTerms = [];

  const fetchMock = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "geocoding-api.open-meteo.com") {
      geocodeTerms.push(url.searchParams.get("name"));

      if (geocodeTerms.length === 1) {
        return jsonResponse({ results: [] });
      }

      return jsonResponse({
        results: [
          {
            name: "Dallas",
            admin1: "Texas",
            country: "United States",
            latitude: 32.7767,
            longitude: -96.797
          }
        ]
      });
    }

    if (url.hostname === "api.open-meteo.com") {
      return jsonResponse({
        current_weather: {
          temperature: 84.2,
          weathercode: 3,
          windspeed: 8
        },
        daily: {
          temperature_2m_max: [90],
          temperature_2m_min: [72],
          sunrise: ["2026-06-25T06:21"],
          sunset: ["2026-06-25T20:34"]
        }
      });
    }

    throw new Error(`Unexpected request for ${url.href}`);
  };

  const weather = await resolveLiveWeather("Dallas, TX", fetchMock);

  assert.deepEqual(geocodeTerms, ["Dallas, TX", "Dallas TX"]);
  assert.equal(weather.resolvedName, "Dallas, Texas, United States");
  assert.equal(weather.condition, "Overcast");
});

test("resolveLiveWeather falls back to wttr when Open-Meteo is rate limited", async () => {
  const calls = [];

  const fetchMock = async (input) => {
    const url = new URL(String(input));
    calls.push(url);

    if (url.hostname === "geocoding-api.open-meteo.com") {
      return jsonResponse({
        results: [
          {
            name: "Austin",
            admin1: "Texas",
            country: "United States",
            latitude: 30.2672,
            longitude: -97.7431
          }
        ]
      });
    }

    if (url.hostname === "api.open-meteo.com") {
      return jsonResponse(
        { error: "Daily API request limit exceeded. Please try again tomorrow." },
        429,
        "Too Many Requests"
      );
    }

    if (url.hostname === "wttr.in") {
      return jsonResponse({
        nearest_area: [
          {
            areaName: [{ value: "Austin" }],
            region: [{ value: "Texas" }],
            country: [{ value: "United States of America" }]
          }
        ],
        current_condition: [
          {
            weatherDesc: [{ value: "Clear" }],
            temp_F: "89",
            weatherCode: "113",
            windspeedMiles: "9"
          }
        ],
        weather: [
          {
            maxtempF: "96",
            mintempF: "77",
            astronomy: [
              {
                sunrise: "06:33 AM",
                sunset: "08:29 PM"
              }
            ]
          }
        ]
      });
    }

    throw new Error(`Unexpected request for ${url.href}`);
  };

  const weather = await resolveLiveWeather("Austin, TX", fetchMock);

  assert.deepEqual(calls.map((call) => call.hostname), [
    "geocoding-api.open-meteo.com",
    "api.open-meteo.com",
    "wttr.in"
  ]);
  assert.equal(weather.location, "Austin, TX");
  assert.equal(weather.resolvedName, "Austin, Texas, United States of America");
  assert.equal(weather.condition, "Clear");
  assert.equal(weather.temperature, "89°F");
  assert.equal(weather.highTemperature, "96°F");
  assert.equal(weather.lowTemperature, "77°F");
  assert.equal(weather.sunrise, "6:33 AM");
  assert.equal(weather.sunset, "8:29 PM");
  assert.equal(weather.level, "Clear");
  assert.equal(weather.impact, "Normal operations.");
});

test("resolveLiveWeather fails when the location cannot be found", async () => {
  const fetchMock = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "geocoding-api.open-meteo.com") {
      return jsonResponse({ results: [] });
    }

    throw new Error(`Unexpected request for ${url.href}`);
  };

  await assert.rejects(
    () => resolveLiveWeather("Nowhere Place", fetchMock),
    /No weather location found/
  );
});
