import { createClient } from "redis";

export const runtime = "nodejs";

const TELEGRAM_API = "https://api.telegram.org";
const YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions";
const YANDEX_SEARCH_API = "https://searchapi.api.cloud.yandex.net/v2/gen/search";
const CBR_DAILY_URL = "https://www.cbr.ru/scripts/XML_daily.asp";
const OPEN_METEO_GEOCODING = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const MORNING_BRIEF_CHAT_KEY = "telegram:morning-brief:chat-id";
const MORNING_BRIEF_LAST_KEY = "telegram:morning-brief:last";

let redisClient: ReturnType<typeof createClient> | null = null;

async function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is missing");

  if (!redisClient) {
    redisClient = createClient({ url });
    redisClient.on("error", (error) => console.error("Redis error", error));
  }

  if (!redisClient.isOpen) await redisClient.connect();
  return redisClient;
}

function cleanTelegramText(text: string) {
  return text
    .replace(/\\*\\*/g, "")
    .replace(/__/g, "")
    .replace(/^#{1,6}\\s+/gm, "")
    .trim();
}

async function sendTelegramMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: cleanTelegramText(text).slice(0, 4090),
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status}`);
  }
}

async function searchWeb(queryText: string) {
  const apiKey = process.env.YANDEX_SEARCH_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey) throw new Error("YANDEX_SEARCH_API_KEY is missing");
  if (!folderId) throw new Error("YANDEX_FOLDER_ID is missing");

  const response = await fetch(YANDEX_SEARCH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Api-Key ${apiKey}`,
    },
    body: JSON.stringify({
      messages: [{ content: queryText, role: "ROLE_USER" }],
      folderId,
      fixMisspell: true,
      getPartialResults: false,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `Yandex Search API failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  const result = Array.isArray(data) ? data[data.length - 1] : data;
  const answer = result?.message?.content || "";
  const sources = Array.isArray(result?.sources) ? result.sources : [];

  const sourceLines = sources
    .filter((source: { url?: string }) => source?.url)
    .slice(0, 6)
    .map(
      (source: { title?: string; url?: string }, index: number) =>
        `${index + 1}. ${source.title || "Источник"}: ${source.url}`
    )
    .join("\n");

  return [
    answer ? String(answer) : "",
    sourceLines ? `Источники:\n${sourceLines}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 5000);
}

function readXmlTag(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1]?.trim() || "";
}

async function fetchCbrRates() {
  const response = await fetch(CBR_DAILY_URL, {
    headers: { "User-Agent": "anya-telegram-agent/1.0" },
  });
  if (!response.ok) throw new Error(`CBR failed: ${response.status}`);

  const xml = await response.text();
  const dateMatch = xml.match(/<ValCurs[^>]*Date="([^"]+)"/i);
  const blocks = xml
    .split("<Valute")
    .slice(1)
    .map((part) => "<Valute" + part.split("</Valute>")[0] + "</Valute>");

  const result = ["USD", "EUR", "CNY"].map((code) => {
    const block = blocks.find(
      (item) => readXmlTag(item, "CharCode").toUpperCase() === code
    );
    if (!block) return `${code}: нет данных`;

    const nominal = Number(readXmlTag(block, "Nominal") || "1");
    const value = Number(readXmlTag(block, "Value").replace(",", "."));
    const perUnit = value / nominal;
    return `${code}: ${perUnit.toFixed(4).replace(".", ",")} руб.`;
  });

  return [
    `Официальный курс Банка России на ${dateMatch?.[1] || "текущую дату"}:`,
    ...result,
    CBR_DAILY_URL,
  ].join("\n");
}

async function fetchKrasnoyarskWeather() {
  const geoUrl = new URL(OPEN_METEO_GEOCODING);
  geoUrl.searchParams.set("name", "Красноярск");
  geoUrl.searchParams.set("count", "1");
  geoUrl.searchParams.set("language", "ru");
  geoUrl.searchParams.set("format", "json");

  const geoResponse = await fetch(geoUrl);
  const geo = await geoResponse.json();
  const place = geo?.results?.[0];
  if (!geoResponse.ok || !place) throw new Error("Krasnoyarsk geocoding failed");

  const url = new URL(OPEN_METEO_FORECAST);
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m"
  );
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  );
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "Asia/Krasnoyarsk");

  const weatherResponse = await fetch(url);
  const weather = await weatherResponse.json();
  if (!weatherResponse.ok || !weather?.current) {
    throw new Error("Open-Meteo forecast failed");
  }

  return [
    `Красноярск, ${weather.current.time}.`,
    `Температура ${weather.current.temperature_2m} °C, ощущается как ${weather.current.apparent_temperature} °C.`,
    `Ветер ${weather.current.wind_speed_10m} км/ч, осадки ${weather.current.precipitation} мм.`,
    `Сегодня: ${weather.daily?.temperature_2m_min?.[0]}...${weather.daily?.temperature_2m_max?.[0]} °C, вероятность осадков до ${weather.daily?.precipitation_probability_max?.[0]}%.`,
    "Источник: Open-Meteo.",
  ].join("\n");
}

async function askYandexForBrief(context: string, previousBrief: string) {
  const apiKey = process.env.YANDEX_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!apiKey || !folderId) throw new Error("Yandex credentials are missing");

  const today = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Krasnoyarsk",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

  const response = await fetch(YANDEX_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Api-Key ${apiKey}`,
      "x-folder-id": folderId,
    },
    body: JSON.stringify({
      model: `gpt://${folderId}/yandexgpt/latest`,
      temperature: 0.35,
      max_tokens: 1600,
      messages: [
        {
          role: "system",
          content: [
            "Ты Саня, персональный ИИ-ассистент Ани, операционного директора компании в Красноярске.",
            "Компания продаёт строительные материалы в среднем и среднем+ сегменте: сантехника, отопление, отделочные материалы, напольные покрытия, плитка, керамогранит и смежные категории.",
            "Сделай короткий утренний управленческий бриф на 4-6 минут чтения.",
            "Фокус: деньги, продажи, спрос, логистика, топливо, поставщики, конкуренты, налоги, кадровый учёт, крупные законы и государственные решения, способные повлиять на бизнес.",
            "Политические события описывай нейтрально и только через документированные решения и возможные экономические последствия. Не давай политических оценок и рекомендаций.",
            "Не заполняй отчёт шумом. Если по разделу существенных изменений нет, так и напиши.",
            "Различай вступившие в силу нормы, подписанные решения, проекты и обсуждения. Не называй проект действующим законом.",
            "Для важных утверждений по возможности указывай короткую ссылку на источник из переданного контекста.",
            "Структура: 1) Погода и логистика. 2) Топливо. 3) Курсы. 4) Рынок стройматериалов и конкуренты. 5) Спрос: стройка, ипотека, ремонт. 6) Налоги, кадры и законодательство. 7) Крупные государственные решения, влияющие на бизнес. 8) Что изменилось со вчера. 9) Саня считает важным сегодня: 2-3 конкретных пункта. 10) Фраза дня.",
            "Фраза дня должна быть короткой, живой, деловой или слегка ироничной. Если это твоя фраза, не приписывай её известному человеку. Чужую цитату используй только если авторство надёжно известно.",
            "Пиши по-русски, без эмодзи, без длинного тире, без markdown-звёздочек.",
          ].join("\n"),
        },
        {
          role: "user",
          content:
            `Дата в Красноярске: ${today}.\n\nСвежие данные:\n${context}\n\nПредыдущий бриф для сравнения:\n${previousBrief || "Предыдущего брифа пока нет."}`,
        },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `Yandex brief synthesis failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  const answer =
    data?.choices?.[0]?.message?.content ??
    data?.result?.alternatives?.[0]?.message?.text;

  if (!answer) throw new Error("Yandex returned empty brief");
  return cleanTelegramText(String(answer)).slice(0, 4090);
}

async function buildMorningBrief() {
  const redis = await getRedis();
  const previousBrief = (await redis.get(MORNING_BRIEF_LAST_KEY)) || "";

  const results = await Promise.allSettled([
    fetchKrasnoyarskWeather(),
    fetchCbrRates(),
    searchWeb(
      "Россия Красноярский край топливо бензин дизель НПЗ дефицит оптовые цены логистика грузоперевозки железная дорога важные изменения за последние сутки"
    ),
    searchWeb(
      "Россия Красноярск рынок строительных материалов сантехника отопление керамогранит плитка напольные покрытия отделочные материалы конкуренты цены акции новые магазины поставщики важные новости за последние сутки"
    ),
    searchWeb(
      "Россия строительство жилья ипотека ключевая ставка спрос на ремонт строительные материалы застройщики важные изменения за последние сутки"
    ),
    searchWeb(
      "site:nalog.gov.ru OR site:rostrud.gov.ru налоги страховые взносы кадровый учет трудовое законодательство работодатели важные изменения 2026 последние дни"
    ),
    searchWeb(
      "site:government.ru OR site:minfin.gov.ru OR site:minpromtorg.gov.ru OR site:publication.pravo.gov.ru торговля импорт логистика строительство пошлины маркировка крупные решения последние дни 2026"
    ),
  ]);

  const labels = [
    "ПОГОДА",
    "КУРСЫ",
    "ТОПЛИВО И ЛОГИСТИКА",
    "СТРОЙМАТЕРИАЛЫ И КОНКУРЕНТЫ",
    "СПРОС И СТРОИТЕЛЬСТВО",
    "НАЛОГИ И КАДРЫ",
    "ГОСУДАРСТВЕННЫЕ РЕШЕНИЯ",
  ];

  const context = results
    .map((result, index) => {
      if (result.status === "fulfilled") {
        return `${labels[index]}:\n${result.value}`;
      }
      console.error(`${labels[index]} failed`, result.reason);
      return `${labels[index]}:\nСвежие данные получить не удалось.`;
    })
    .join("\n\n");

  const brief = await askYandexForBrief(context, previousBrief.slice(0, 3500));
  await redis.set(MORNING_BRIEF_LAST_KEY, brief, { EX: 60 * 60 * 24 * 7 });
  return brief;
}

export async function GET() {
  return Response.json({ ok: true, service: "morning-brief" });
}

export async function POST(request: Request) {
  const expectedSecret = process.env.MORNING_BRIEF_SECRET;
  const receivedSecret = request.headers.get("x-brief-secret");

  if (!expectedSecret) {
    console.error("MORNING_BRIEF_SECRET is missing");
    return Response.json({ ok: false, error: "not_configured" }, { status: 500 });
  }

  if (receivedSecret !== expectedSecret) {
    return Response.json({ ok: false }, { status: 401 });
  }

  try {
    const redis = await getRedis();
    const rawChatId = await redis.get(MORNING_BRIEF_CHAT_KEY);

    if (!rawChatId) {
      return Response.json(
        { ok: false, error: "brief_chat_not_enabled" },
        { status: 409 }
      );
    }

    const chatId = Number(rawChatId);
    if (!Number.isFinite(chatId)) {
      throw new Error("Stored morning brief chat id is invalid");
    }

    const brief = await buildMorningBrief();
    await sendTelegramMessage(chatId, brief);

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Morning brief failed", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
