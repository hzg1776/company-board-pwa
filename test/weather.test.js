import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultWeather,
  normalizeStoredWeather,
  resolveLiveWeather
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
  assert.equal(weather.level, "Clear");
  assert.equal(weather.updatedAt, "");
});

test("normalizeStoredWeather preserves stored weather fields", () => {
  const weather = normalizeStoredWeather({
    location: "Austin, TX",
    resolvedName: "Austin, Texas, United States",
    condition: "Light rain",
    temperature: "68 F",
    impact: "Wet floors possible.",
    level: "Watch",
    updatedAt: "2026-06-12T12:00:00.000Z"
  });

  assert.deepEqual(weather, {
    location: "Austin, TX",
    resolvedName: "Austin, Texas, United States",
    condition: "Light rain",
    temperature: "68 F",
    impact: "Wet floors possible.",
    level: "Watch",
    updatedAt: "2026-06-12T12:00:00.000Z"
  });
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
