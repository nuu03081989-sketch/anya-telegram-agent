import {
  formatKrasnoyarskTraffic,
  getKrasnoyarskTraffic,
} from "@/app/lib/krasnoyarsk-traffic";
import { defineSkill } from "./types";
import type { SkillContext, SkillResult } from "./types";

const YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions";
const YANDEX_SEARCH_API = "https://searchapi.api.cloud.yandex.net/v2/web/search";
const MODEL_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 20_000;
const PUBLIC_APP_URL =
  process.env.PUBLIC_APP_URL || "https://anya-telegram-agent.vercel.app";

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  code: string
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...init, signal: controller.signal })
    .catch((error) => {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(code);
      }
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

function stripMarkup(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTrafficQuery(text: string) {
  return /(пробк|затор|загруженност.{0,12}дорог|дорожн.{0,12}(?:обстанов|ситуац)|трафик.{0,12}(?:дорог|город)|как.{0,12}дорог|дорог.{0,12}загруж)/i.test(
    text
  );
}

export function isNavigationQuery(text: string) {
  return /(пролож(?:и|ить)|маршрут|навигатор|как доехать|как добраться|поехали|ехать до|доехать до)/i.test(
    text
  );
}

async function extractNavigationDestination(userText: string) {
  const apiKey = process.env.YANDEX_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey || !folderId) {
    throw new Error("NAVIGATION_YANDEX_NOT_CONFIGURED");
  }

  const response = await fetchWithTimeout(
    YANDEX_API,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Api-Key ${apiKey}`,
        "x-folder-id": folderId,
      },
      body: JSON.stringify({
        model: `gpt://${folderId}/yandexgpt-5-lite`,
        temperature: 0,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              "Извлеки из запроса только точку назначения для автомобильного маршрута. Верни короткую поисковую фразу без пояснений. Если город не указан и это локальное место, организация, улица или адрес, добавь «Красноярск». Не добавляй Красноярск, если в запросе явно указан другой город или регион.",
          },
          {
            role: "user",
            content: userText,
          },
        ],
      }),
    },
    MODEL_TIMEOUT_MS,
    "NAVIGATION_MODEL_TIMEOUT"
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `NAVIGATION_DESTINATION_FAILED: ${response.status} ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  const destination = String(
    data?.choices?.[0]?.message?.content ??
      data?.result?.alternatives?.[0]?.message?.text ??
      ""
  )
    .trim()
    .replace(/^["'«]|["'»]$/g, "");

  if (!destination) {
    throw new Error("NAVIGATION_DESTINATION_EMPTY");
  }

  return destination;
}

async function searchDestination(destination: string) {
  const apiKey = process.env.YANDEX_SEARCH_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey || !folderId) {
    throw new Error("NAVIGATION_SEARCH_NOT_CONFIGURED");
  }

  const queryText =
    `Найди точные координаты места: ${destination}. Нужны широта и долгота, проверь что место соответствует запросу.`;

  const response = await fetchWithTimeout(
    YANDEX_SEARCH_API,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Api-Key ${apiKey}`,
      },
      body: JSON.stringify({
        query: {
          searchType: "SEARCH_TYPE_RU",
          queryText,
          familyMode: "FAMILY_MODE_STRICT",
          page: "0",
          fixTypoMode: "FIX_TYPO_MODE_ON",
        },
        groupSpec: {
          groupMode: "GROUP_MODE_FLAT",
          groupsOnPage: "8",
          docsInGroup: "1",
        },
        maxPassages: "3",
        region: "225",
        l10n: "LOCALIZATION_RU",
        folderId,
        responseFormat: "FORMAT_XML",
      }),
    },
    SEARCH_TIMEOUT_MS,
    "NAVIGATION_SEARCH_TIMEOUT"
  );

  const data = await response.json();
  if (!response.ok || !data?.rawData) {
    throw new Error(
      `NAVIGATION_SEARCH_FAILED: ${response.status} ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  const xml = Buffer.from(String(data.rawData), "base64").toString("utf8");
  const docs = Array.from(xml.matchAll(/<doc[^>]*>([\s\S]*?)<\/doc>/gi))
    .slice(0, 8)
    .map((match) => {
      const block = match[1];
      const title =
        block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "Источник";
      const url = block.match(/<url>([\s\S]*?)<\/url>/i)?.[1] || "";
      const passages = Array.from(
        block.matchAll(/<passage>([\s\S]*?)<\/passage>/gi),
        (item) => stripMarkup(item[1])
      )
        .filter(Boolean)
        .slice(0, 3);

      return [
        stripMarkup(title),
        stripMarkup(url),
        passages.join(" "),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean);

  if (docs.length === 0) {
    throw new Error("NAVIGATION_SEARCH_EMPTY");
  }

  return docs.join("\n\n").slice(0, 12_000);
}

async function extractCoordinatesFromSearch(
  destination: string,
  searchContext: string
) {
  const apiKey = process.env.YANDEX_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey || !folderId) {
    throw new Error("NAVIGATION_YANDEX_NOT_CONFIGURED");
  }

  const response = await fetchWithTimeout(
    YANDEX_API,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Api-Key ${apiKey}`,
        "x-folder-id": folderId,
      },
      body: JSON.stringify({
        model: `gpt://${folderId}/yandexgpt-5-lite`,
        temperature: 0,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              "По переданным результатам поиска найди координаты именно указанного места. Верни строго одну строку в формате LAT|LON|NAME, где LAT и LON только десятичные числа. Если надёжных координат нет, верни NOT_FOUND. Не придумывай координаты.",
          },
          {
            role: "user",
            content: `Место: ${destination}\n\nРезультаты поиска:\n${searchContext}`,
          },
        ],
      }),
    },
    MODEL_TIMEOUT_MS,
    "NAVIGATION_MODEL_TIMEOUT"
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `NAVIGATION_COORDINATES_FAILED: ${response.status} ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  const line = String(
    data?.choices?.[0]?.message?.content ??
      data?.result?.alternatives?.[0]?.message?.text ??
      "NOT_FOUND"
  ).trim();

  if (line === "NOT_FOUND") return null;

  const match = line.match(
    /^(-?\d{1,2}(?:\.\d+)?)\|(-?\d{1,3}(?:\.\d+)?)\|(.+)$/
  );
  if (!match) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  const name = match[3].trim();

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return null;
  }

  return { lat, lon, name };
}

async function buildNavigatorRoute(userText: string): Promise<SkillResult> {
  const destination = await extractNavigationDestination(userText);
  let coordinates: { lat: number; lon: number; name: string } | null = null;

  try {
    const searchContext = await searchDestination(destination);
    coordinates = await extractCoordinatesFromSearch(
      destination,
      searchContext
    );
  } catch (error) {
    console.error("Navigation coordinate lookup failed", error);
  }

  if (!coordinates) {
    const fallbackUrl =
      `${PUBLIC_APP_URL}/api/navigate?q=${encodeURIComponent(destination)}`;

    return {
      handled: true,
      text:
        `Аня, точные координаты «${destination}» надёжно определить не получилось. Открою поиск этого места в Яндекс Навигаторе.`,
      buttonUrl: fallbackUrl,
      buttonText: "Открыть в Яндекс Навигаторе",
      historyText:
        `Предложил поиск в Яндекс Навигаторе для «${destination}».`,
    };
  }

  const routeUrl =
    `${PUBLIC_APP_URL}/api/navigate?lat=${encodeURIComponent(
      coordinates.lat
    )}&lon=${encodeURIComponent(coordinates.lon)}&name=${encodeURIComponent(
      coordinates.name || destination
    )}`;

  return {
    handled: true,
    text:
      `Аня, нашёл: ${coordinates.name || destination}.\nСтартовая точка будет взята из текущего местоположения телефона.`,
    buttonUrl: routeUrl,
    buttonText: "Открыть в Яндекс Навигаторе",
    historyText:
      `Построил ссылку Яндекс Навигатора до «${coordinates.name || destination}».`,
  };
}

async function buildTrafficAnswer(): Promise<SkillResult> {
  try {
    const traffic = await getKrasnoyarskTraffic();
    const answer = formatKrasnoyarskTraffic(traffic);

    return {
      handled: true,
      text: answer,
      historyText: answer,
    };
  } catch (error) {
    console.error(
      "Krasnoyarsk traffic failed",
      error instanceof Error ? error.message : "unknown error"
    );

    const message = String(error);
    let answer =
      "Аня, сейчас не смог получить live-данные по дорогам Красноярска. Обычными ссылками вместо ответа отделываться не буду.";

    if (message.includes("MAPBOX_ACCESS_TOKEN_MISSING")) {
      answer += " В production не виден MAPBOX_ACCESS_TOKEN.";
    } else if (
      message.includes("MAPBOX_TRAFFIC_UNAUTHORIZED") ||
      message.includes("MAPBOX_TRAFFIC_FORBIDDEN")
    ) {
      answer += " Mapbox не дал доступ к driving-traffic по текущему токену.";
    } else if (message.includes("MAPBOX_TRAFFIC_RATE_LIMIT")) {
      answer += " Mapbox временно ограничил число запросов.";
    } else if (message.includes("MAPBOX_TRAFFIC_TIMEOUT")) {
      answer += " Mapbox не успел ответить вовремя.";
    } else {
      answer += " Источник временно не ответил корректно.";
    }

    return {
      handled: true,
      text: answer,
      historyText: answer,
    };
  }
}

async function runNavigation(
  context: SkillContext
): Promise<SkillResult> {
  if (isTrafficQuery(context.text)) {
    return buildTrafficAnswer();
  }

  if (isNavigationQuery(context.text)) {
    return buildNavigatorRoute(context.text);
  }

  return { handled: false };
}

export const navigationSkill = defineSkill({
  id: "navigation",
  title: "Навигация",
  description:
    "Строит маршруты в Яндекс Навигаторе и показывает live-оценку пробок Красноярска.",
  status: "native",
  costProfile: "no-new-cost",
  triggerHints: [
    "маршрут",
    "навигатор",
    "как доехать",
    "как добраться",
    "пробки",
    "дорожная обстановка",
  ],
  dependencies: [
    "Yandex Search",
    "YandexGPT",
    "Yandex Navigator deep link",
    "Mapbox driving-traffic",
  ],
  handler: {
    match(context: SkillContext) {
      const traffic = isTrafficQuery(context.text);
      const route = isNavigationQuery(context.text);
      const matched = traffic || route;

      return {
        matched,
        confidence: matched ? 0.98 : 0,
        reason: traffic
          ? "traffic intent"
          : route
            ? "navigation intent"
            : "no navigation intent",
      };
    },
    run: runNavigation,
  },
});
