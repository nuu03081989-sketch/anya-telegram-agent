import { defineSkill } from "./types";
import type { SkillContext, SkillResult } from "./types";

const YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions";
const YANDEX_SEARCH_API = "https://searchapi.api.cloud.yandex.net/v2/web/search";
const SEARCH_TIMEOUT_MS = 16_000;
const MODEL_TIMEOUT_MS = 35_000;

type SearchHit = {
  title: string;
  url: string;
  snippet: string;
};

type FashionPeriod = {
  season: "весна" | "лето" | "осень" | "зима";
  year: number;
};

const LOW_VALUE_HOSTS = [
  "dzen.ru",
  "zen.yandex.ru",
  "pinterest.com",
  "pinterest.ru",
  "avito.ru",
  "wildberries.ru",
  "ozon.ru",
] as const;

const HIGH_VALUE_HOSTS = [
  "pantone.com",
  "vogue.com",
  "vogue.co.uk",
  "harpersbazaar.com",
  "elle.com",
  "wgsn.com",
  "fashionunited.com",
  "whowhatwear.com",
  "glamour.com",
  "marieclaire.com",
] as const;

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

function decodeXmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripMarkup(value: string) {
  return decodeXmlEntities(value)
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTelegramText(value: string) {
  return value
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/—/g, "-")
    .trim();
}

function krasnoyarskNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Krasnoyarsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function seasonByMonth(month: number): FashionPeriod["season"] {
  if (month >= 3 && month <= 5) return "весна";
  if (month >= 6 && month <= 8) return "лето";
  if (month >= 9 && month <= 11) return "осень";
  return "зима";
}

function requestedPeriod(text: string): FashionPeriod {
  const now = krasnoyarskNow();
  let season = seasonByMonth(now.month);

  if (/(?:весн|spring)/i.test(text)) season = "весна";
  else if (/(?:лет|summer)/i.test(text)) season = "лето";
  else if (/(?:осен|autumn|fall)/i.test(text)) season = "осень";
  else if (/(?:зим|winter)/i.test(text)) season = "зима";

  const explicitYear = text.match(/\b(20\d{2})\b/)?.[1];
  let year = explicitYear ? Number(explicitYear) : now.year;

  if (!explicitYear && /следующ/i.test(text)) {
    year += 1;
  }

  return { season, year };
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function sourceScore(hit: SearchHit, year: number) {
  const host = hostOf(hit.url);
  if (!host) return -100;

  if (LOW_VALUE_HOSTS.some((domain) => hostMatches(host, domain))) {
    return -100;
  }

  let score = 1;

  if (HIGH_VALUE_HOSTS.some((domain) => hostMatches(host, domain))) {
    score += 7;
  }

  const text = `${hit.title} ${hit.snippet}`;
  if (new RegExp(`\\b${year}\\b`).test(text)) score += 4;
  if (/(pantone|runway|fashion week|collection|trend|color)/i.test(text)) {
    score += 2;
  }

  return score;
}

function isFashionTrendRequest(text: string) {
  const fashion =
    /(?:модн|мода|fashion|гардероб|одежд|образ|лук|наряд|стил|цвет)/i.test(
      text
    );
  const trend =
    /(?:тренд|актуальн|сейчас|сезон|осен|зим|весн|лет|202\d|какие\s+цвет|что\s+носят|в\s+моде|модн\w*\s+цвет)/i.test(
      text
    );

  return fashion && trend;
}

async function searchOne(queryText: string): Promise<SearchHit[]> {
  const apiKey = process.env.YANDEX_SEARCH_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey) throw new Error("YANDEX_SEARCH_API_KEY is missing");
  if (!folderId) throw new Error("YANDEX_FOLDER_ID is missing");

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
          groupsOnPage: "7",
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
    "FASHION_TRENDS_SEARCH_TIMEOUT"
  );

  const data = await response.json();

  if (!response.ok || !data?.rawData) {
    throw new Error(
      `FASHION_TRENDS_SEARCH_FAILED: ${response.status} ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  const xml = Buffer.from(String(data.rawData), "base64").toString("utf8");

  return Array.from(xml.matchAll(/<doc[^>]*>([\s\S]*?)<\/doc>/gi))
    .slice(0, 7)
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

      return {
        title: stripMarkup(title),
        url: stripMarkup(url),
        snippet: passages.join(" "),
      };
    })
    .filter((item) => /^https?:\/\//i.test(item.url));
}

async function collectSources(text: string, period: FashionPeriod) {
  const office =
    /(?:делов|офис|работ|руковод|business|office)/i.test(text);

  const queries = [
    `${period.season} ${period.year} fashion color trends Pantone runway womenswear`,
    `модные цвета ${period.season} ${period.year} женская одежда тренды`,
    office
      ? `деловой женский гардероб ${period.season} ${period.year} модные цвета сочетания`
      : `women outfit color combinations ${period.season} ${period.year} fashion trends`,
  ];

  const hits: SearchHit[] = [];

  for (let index = 0; index < queries.length; index += 1) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 650));
    }

    try {
      hits.push(...(await searchOne(queries[index])));
    } catch (error) {
      console.error(`Fashion trends search ${index + 1} failed`, error);
    }
  }

  const unique = new Map<string, SearchHit>();

  for (const hit of hits) {
    if (sourceScore(hit, period.year) < 0) continue;
    if (!unique.has(hit.url)) unique.set(hit.url, hit);
  }

  return [...unique.values()]
    .sort(
      (a, b) =>
        sourceScore(b, period.year) - sourceScore(a, period.year)
    )
    .slice(0, 9);
}

function sourcePack(hits: SearchHit[]) {
  return hits
    .map(
      (hit, index) =>
        `Источник ${index + 1}: ${hit.title}\nURL: ${hit.url}\nФрагмент: ${hit.snippet || "нет фрагмента"}`
    )
    .join("\n\n")
    .slice(0, 18_000);
}

async function synthesizeFashionTrends(
  context: SkillContext,
  period: FashionPeriod,
  hits: SearchHit[]
) {
  const apiKey = process.env.YANDEX_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey) throw new Error("YANDEX_API_KEY is missing");
  if (!folderId) throw new Error("YANDEX_FOLDER_ID is missing");

  const current = krasnoyarskNow();
  const currentDate =
    `${String(current.day).padStart(2, "0")}.${String(current.month).padStart(2, "0")}.${current.year}`;

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
        model: `gpt://${folderId}/yandexgpt/latest`,
        temperature: 0.2,
        max_tokens: 1300,
        messages: [
          {
            role: "system",
            content: [
              "Ты Саня, персональный ассистент Ани.",
              `Сегодня по Красноярскому времени ${currentDate}. Не называй ${current.year} год далёким будущим.`,
              "Ты отвечаешь на запрос о моде и гардеробе только по переданным результатам свежего веб-поиска.",
              "Не выдумывай тренды, цвета, показы, прогнозы и цитаты.",
              "Отличай факт из источника от своей практической адаптации.",
              "Если источники слабые или противоречат друг другу, прямо скажи об этом.",
              "Не отвечай фразами «у меня нет доступа к тенденциям» или «следите за публикациями», если веб-поиск вернул пригодные данные.",
              "Дай 5–7 конкретных сочетаний цветов или направлений. Каждый вариант ОБЯЗАТЕЛЬНО отдельным нумерованным пунктом 1., 2., 3. и т.д. Это нужно для следующего визуального Skill.",
              "В каждом пункте сначала короткое название сочетания, затем 1–2 предложения: почему оно актуально и как носить.",
              "Если запрос про деловой/офисный гардероб, делай варианты носибельными и уместными для работы, а не подиумными ради подиума.",
              "В конце одной строкой предложи: «Если хочешь, покажу фото этих вариантов».",
              "Не добавляй URL в текст ответа: список источников будет добавлен программно.",
              "Пиши по-русски, без эмодзи и длинного тире.",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `Запрос Ани: ${context.text}`,
              `Целевой сезон: ${period.season} ${period.year}`,
              context.replyText
                ? `Сообщение, на которое отвечает Аня: ${context.replyText}`
                : "",
              "",
              "РЕЗУЛЬТАТЫ ВЕБ-ПОИСКА:",
              sourcePack(hits),
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      }),
    },
    MODEL_TIMEOUT_MS,
    "FASHION_TRENDS_MODEL_TIMEOUT"
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `FASHION_TRENDS_MODEL_FAILED: ${response.status} ${JSON.stringify(data).slice(0, 700)}`
    );
  }

  const answer = String(
    data?.choices?.[0]?.message?.content ??
      data?.result?.alternatives?.[0]?.message?.text ??
      ""
  ).trim();

  if (!answer) {
    throw new Error("FASHION_TRENDS_EMPTY_ANSWER");
  }

  const sources = hits
    .slice(0, 6)
    .map((hit) => `- ${hit.title}\n${hit.url}`)
    .join("\n")
    .slice(0, 1500);

  return cleanTelegramText(
    `${answer}\n\nИсточники:\n${sources}`
  ).slice(0, 3900);
}

async function runFashionTrends(
  context: SkillContext
): Promise<SkillResult> {
  const period = requestedPeriod(context.text);
  const hits = await collectSources(context.text, period);

  if (hits.length < 2) {
    return {
      handled: true,
      text:
        `Аня, я понял запрос про тренды на ${period.season} ${period.year}, но свежих пригодных источников сейчас слишком мало. Не буду сочинять модные тенденции из воздуха. Попробуй ещё раз позже или сформулируй запрос чуть шире.`,
    };
  }

  return {
    handled: true,
    text: await synthesizeFashionTrends(context, period, hits),
  };
}

export const fashionTrendsSkill = defineSkill({
  id: "fashion-trends",
  title: "Тренды гардероба",
  description:
    "Ищет актуальные модные цвета и сезонные тренды, превращая их в практичные сочетания для гардероба.",
  status: "native",
  costProfile: "existing-yandex-services",
  triggerHints: [
    "какие цвета сейчас в моде",
    "модные цвета осень 2026",
    "тренды гардероба",
    "что сейчас носят",
    "актуальные сочетания цветов",
  ],
  dependencies: ["Yandex Search", "YandexGPT"],
  handler: {
    match(context: SkillContext) {
      const matched = isFashionTrendRequest(context.text);

      return {
        matched,
        confidence: matched ? 0.96 : 0,
        reason: matched
          ? "fashion trends intent"
          : "no fashion trends intent",
      };
    },
    run: runFashionTrends,
  },
});
