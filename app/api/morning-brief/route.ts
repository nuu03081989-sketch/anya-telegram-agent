import { createClient } from "redis";
import { getExpenseReminders } from "@/app/lib/expense-control";

export const runtime = "nodejs";

const TELEGRAM_API = "https://api.telegram.org";
const YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions";
const YANDEX_SEARCH_API = "https://searchapi.api.cloud.yandex.net/v2/web/search";
const CBR_DAILY_URL = "https://www.cbr.ru/scripts/XML_daily.asp";
const OPEN_METEO_GEOCODING = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const MORNING_BRIEF_CHAT_KEY = "telegram:morning-brief:chat-id";
const MORNING_BRIEF_LAST_KEY = "telegram:morning-brief:last";
const MORNING_BRIEF_RUNNING_KEY = "telegram:morning-brief:running";

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


function krasnoyarskDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Krasnoyarsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dailyPhrase(dateKey: string) {
  const phrases = [
    "Сильная операционка начинается там, где перестают надеяться, что само рассосётся.",
    "Деньги любят скорость, но ещё сильнее они любят контроль.",
    "Если проблема повторилась трижды, это уже не случайность, а процесс.",
    "Хороший план экономит время. Хорошая дисциплина экономит ещё и деньги.",
    "Не всякая срочность важна. Но всякая важная вещь должна иметь срок.",
    "Бизнес растёт быстрее, когда цифры спорят вместо людей.",
    "Сначала считаем последствия, потом нажимаем красивую кнопку.",
    "Запас прочности выглядит скучно ровно до первого кризиса.",
    "Управление начинается с вопроса: кто, что и к какому сроку.",
    "Самая дорогая ошибка часто начинается со слов: да ладно, разберёмся потом.",
    "Не нужно контролировать всё. Нужно контролировать то, что двигает деньги и сроки.",
    "Хороший день начинается не с мотивации, а с ясных приоритетов.",
    "Если узкое место известно и ничего не меняется, это уже управленческое решение.",
    "Иногда лучший способ ускориться - убрать лишнее, а не добавить ещё одну задачу.",
  ];

  const numeric = Number(dateKey.replace(/-/g, ""));
  return phrases[Math.abs(numeric) % phrases.length];
}

function cleanTelegramText(text: string) {
  return text
    .replace(/\*\*/g, "")
    .replace(/^\s*\\?\*\s+/gm, "- ")
    .replace(/^\s*\\?-\s+/gm, "- ")
    .replace(/\\([\-*_[\]()])/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$2")
    .replace(/__/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/—/g, "-")
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

async function sendExpenseReminders(chatId: number) {
  const reminders = getExpenseReminders();
  if (reminders.length === 0) return;

  const redis = await getRedis();

  for (const reminder of reminders) {
    const key = `telegram:expense-reminder:${reminder.id}:${reminder.dueDate}`;
    const reserved = await redis.set(key, "1", {
      NX: true,
      EX: 60 * 60 * 24 * 45,
    });

    if (reserved !== "OK") continue;

    try {
      await sendTelegramMessage(chatId, reminder.message);
    } catch (error) {
      await redis.del(key);
      throw error;
    }
  }
}

let searchQueue: Promise<unknown> = Promise.resolve();

function queuedSearchWeb(queryText: string) {
  const task = searchQueue.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return searchWeb(queryText);
  });

  searchQueue = task.then(
    () => undefined,
    () => undefined
  );

  return task;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripWebSearchMarkup(value: string) {
  return decodeXmlEntities(value)
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  });

  const data = await response.json();

  if (!response.ok || !data?.rawData) {
    throw new Error(
      `Yandex Search API failed: ${response.status} ${JSON.stringify(data).slice(0, 1200)}`
    );
  }

  const xml = Buffer.from(String(data.rawData), "base64").toString("utf8");
  const docs = Array.from(xml.matchAll(/<doc[^>]*>([\s\S]*?)<\/doc>/gi))
    .slice(0, 8)
    .map((match) => {
      const block = match[1];
      const title = block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "Источник";
      const url = block.match(/<url>([\s\S]*?)<\/url>/i)?.[1] || "";
      const passages = Array.from(
        block.matchAll(/<passage>([\s\S]*?)<\/passage>/gi),
        (m) => stripWebSearchMarkup(m[1])
      ).filter(Boolean).slice(0, 3);

      return {
        title: stripWebSearchMarkup(title),
        url: stripWebSearchMarkup(url),
        snippet: passages.join(" "),
      };
    })
    .filter((item) => /^https?:\/\//i.test(item.url));

  if (docs.length === 0) {
    throw new Error("Yandex Search API returned no usable web results");
  }

  return docs
    .map(
      (item, index) =>
        `${index + 1}. ${item.title}\n${item.url}${item.snippet ? `\nФрагмент: ${item.snippet}` : ""}`
    )
    .join("\n\n")
    .slice(0, 3600);
}

async function searchMany(queries: string[], maxChars = 5000) {
  const successful: string[] = [];

  for (let index = 0; index < queries.length; index += 1) {
    try {
      const value = await queuedSearchWeb(queries[index]);
      if (value) {
        successful.push(`Запрос ${index + 1}:\n${value.slice(0, 2200)}`);
      }
    } catch (error) {
      console.error(`Morning brief search query ${index + 1} failed`, error);
    }
  }

  if (successful.length === 0) {
    throw new Error("All searches for morning brief section failed");
  }

  return successful.join("\n\n").slice(0, maxChars);
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
    dateMatch?.[1]
      ? "Примечание: Банк России может заранее публиковать официальный курс на следующую календарную или рабочую дату."
      : "",
    CBR_DAILY_URL,
  ]
    .filter(Boolean)
    .join("\n");
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

function hasUrl(text: string) {
  return /https?:\/\//i.test(text);
}

function hasAnyDomain(text: string, domains: string[]) {
  const normalized = text.toLowerCase();
  return domains.some((domain) => normalized.includes(domain.toLowerCase()));
}

function hasMarketEventSignal(text: string) {
  return /(объяв|открыл|закрыл|запуст|измен|повыс|сниз|подорож|дешев|расшир|сократ|акци|постав|импорт|дефиц|нов(?:ый|ая|ое|ые)|вышел|вышла|начал|начала)/i.test(
    text
  );
}

function validateSearchSection(label: string, value: string) {
  const noVerified =
    "Подтверждённых свежих данных по этому блоку из подходящих источников не найдено.";

  if (!value || !hasUrl(value)) {
    return noVerified;
  }

  if (label === "СТРОЙМАТЕРИАЛЫ И КОНКУРЕНТЫ" && !hasMarketEventSignal(value)) {
    return noVerified;
  }

  if (
    label === "СПРОС И СТРОИТЕЛЬСТВО" &&
    !hasAnyDomain(value, [
      "cbr.ru",
      "minstroyrf.gov.ru",
      "rosstat.gov.ru",
      "government.ru",
      "xn--d1aqf.xn--p1ai",
    ])
  ) {
    return noVerified;
  }

  if (
    label === "НАЛОГИ И КАДРЫ" &&
    !hasAnyDomain(value, [
      "nalog.gov.ru",
      "rostrud.gov.ru",
      "publication.pravo.gov.ru",
      "government.ru",
    ])
  ) {
    return noVerified;
  }

  if (
    label === "ГОСУДАРСТВЕННЫЕ РЕШЕНИЯ" &&
    !hasAnyDomain(value, [
      "government.ru",
      "minfin.gov.ru",
      "minpromtorg.gov.ru",
      "publication.pravo.gov.ru",
      "minstroyrf.gov.ru",
    ])
  ) {
    return noVerified;
  }

  return value;
}

function extractUrls(text: string) {
  return text.match(/https?:\/\/[^\s)]+/g) || [];
}

function urlMatchesAnyDomain(url: string, domains: string[]) {
  try {
    const host = new URL(url.replace(/[.,;]+$/, "")).hostname.toLowerCase();
    return domains.some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function replaceSectionBody(
  text: string,
  heading: string,
  nextHeading: string,
  replacement: string
) {
  const start = text.indexOf(heading);
  if (start < 0) return text;

  const bodyStart = start + heading.length;
  const end = text.indexOf(nextHeading, bodyStart);
  if (end < 0) return text;

  return (
    text.slice(0, bodyStart) +
    "\n\n" +
    replacement.trim() +
    "\n\n" +
    text.slice(end)
  );
}

function getSectionBody(text: string, heading: string, nextHeading: string) {
  const start = text.indexOf(heading);
  if (start < 0) return "";

  const bodyStart = start + heading.length;
  const end = text.indexOf(nextHeading, bodyStart);
  if (end < 0) return text.slice(bodyStart).trim();

  return text.slice(bodyStart, end).trim();
}

function sectionHasVerifiedData(
  text: string,
  heading: string,
  nextHeading: string
) {
  const body = getSectionBody(text, heading, nextHeading);
  if (!body) return false;

  return !/(подтверждённых свежих данных|подтверждённых свежих событий|свежие данные получить не удалось|нет данных)/i.test(
    body
  );
}

function rebuildTodayPriorities(text: string) {
  const verified: string[] = [];

  if (sectionHasVerifiedData(text, "Топливо", "Курсы")) {
    verified.push("топливо и логистика");
  }
  if (
    sectionHasVerifiedData(
      text,
      "Рынок стройматериалов и конкуренты",
      "Спрос: стройка, ипотека, ремонт"
    )
  ) {
    verified.push("рынок стройматериалов и конкуренты");
  }
  if (
    sectionHasVerifiedData(
      text,
      "Спрос: стройка, ипотека, ремонт",
      "Налоги, кадры и законодательство"
    )
  ) {
    verified.push("спрос, стройка и ипотека");
  }
  if (
    sectionHasVerifiedData(
      text,
      "Налоги, кадры и законодательство",
      "Крупные государственные решения, влияющие на бизнес"
    )
  ) {
    verified.push("налоги, кадры и законодательство");
  }
  if (
    sectionHasVerifiedData(
      text,
      "Крупные государственные решения, влияющие на бизнес",
      "Что изменилось со вчера"
    )
  ) {
    verified.push("государственные решения");
  }

  const replacement =
    verified.length > 0
      ? "Сегодня подтверждены значимые данные по следующим направлениям: " +
        verified.join(", ") +
        ". Приоритеты формируй только по ним."
      : "По ключевым бизнес-блокам подтверждённых свежих данных сегодня нет. Не придумываю приоритеты ради заполнения отчёта.";

  const start = text.indexOf("Саня считает важным сегодня");
  if (start < 0) return text;

  return text.slice(0, start) + "Саня считает важным сегодня\n\n" + replacement;
}

function enforceFinalSourcePolicy(text: string) {
  const noData =
    "Подтверждённых свежих данных по этому блоку из подходящих источников не найдено.";

  const rules = [
    {
      heading: "Топливо",
      next: "Курсы",
      domains: [
        "government.ru",
        "rosstat.gov.ru",
        "spimex.com",
        "minenergo.gov.ru",
        "fas.gov.ru",
        "rzd.ru",
      ],
    },
    {
      heading: "Спрос: стройка, ипотека, ремонт",
      next: "Налоги, кадры и законодательство",
      domains: ["cbr.ru", "minstroyrf.gov.ru", "rosstat.gov.ru", "government.ru"],
    },
    {
      heading: "Налоги, кадры и законодательство",
      next: "Крупные государственные решения, влияющие на бизнес",
      domains: [
        "nalog.gov.ru",
        "rostrud.gov.ru",
        "publication.pravo.gov.ru",
        "government.ru",
      ],
    },
    {
      heading: "Крупные государственные решения, влияющие на бизнес",
      next: "Что изменилось со вчера",
      domains: [
        "government.ru",
        "minfin.gov.ru",
        "minpromtorg.gov.ru",
        "publication.pravo.gov.ru",
        "minstroyrf.gov.ru",
      ],
    },
  ];

  let result = text;

  for (const rule of rules) {
    const body = getSectionBody(result, rule.heading, rule.next);
    const urls = extractUrls(body);
    const hasAllowedSource = urls.some((url) =>
      urlMatchesAnyDomain(url, rule.domains)
    );

    if (!hasAllowedSource) {
      result = replaceSectionBody(result, rule.heading, rule.next, noData);
    }
  }

  const marketBody = getSectionBody(
    result,
    "Рынок стройматериалов и конкуренты",
    "Спрос: стройка, ипотека, ремонт"
  );

  if (
    marketBody &&
    (extractUrls(marketBody).length === 0 || !hasMarketEventSignal(marketBody))
  ) {
    result = replaceSectionBody(
      result,
      "Рынок стройматериалов и конкуренты",
      "Спрос: стройка, ипотека, ремонт",
      "Подтверждённых свежих событий по конкурентам и рынку за выбранный период не найдено."
    );
  }

  return result;
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
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: [
            "Ты Саня, персональный ИИ-ассистент Ани, операционного директора компании в Красноярске.",
            "Компания продаёт строительные материалы в среднем и среднем+ сегменте: сантехника, отопление, отделочные материалы, напольные покрытия, плитка, керамогранит и смежные категории.",
            "Сделай плотный утренний управленческий бриф примерно на 3-4 минуты чтения и не более 3300 знаков до блока «Фраза дня».",
            "Фокус: деньги, продажи, спрос, логистика, топливо, поставщики, конкуренты, налоги, кадровый учёт, крупные законы и государственные решения, способные повлиять на бизнес.",
            "Политические события описывай нейтрально и только через документированные решения и возможные экономические последствия. Не давай политических оценок и рекомендаций.",
            "Не заполняй отчёт шумом. Если по разделу существенных изменений нет, так и напиши. Не перечисляй просто существующие магазины или компании: для блока конкурентов нужны только новые действия или изменения. Старые топливные кризисы упоминай только если в свежих данных есть новое развитие.",
            "Различай вступившие в силу нормы, подписанные решения, проекты и обсуждения. Не называй проект действующим законом.",
            "Для каждого непустого блока «Топливо», «Рынок стройматериалов и конкуренты», «Спрос: стройка, ипотека, ремонт», «Налоги, кадры и законодательство» и «Крупные государственные решения, влияющие на бизнес» обязательно укажи хотя бы один URL источника именно из переданного контекста. Для законов, налогов, государственных решений, официальной статистики и топливных ограничений используй только первоисточники. Если первоисточника нет, напиши, что подтверждённых свежих данных нет.",
            "Используй точные заголовки и именно в таком порядке: Погода и логистика; Топливо; Курсы; Рынок стройматериалов и конкуренты; Спрос: стройка, ипотека, ремонт; Налоги, кадры и законодательство; Крупные государственные решения, влияющие на бизнес; Что изменилось со вчера; Саня считает важным сегодня.",
            "Не добавляй раздел «Фраза дня»: он будет добавлен программно после твоего ответа.",
            "Пиши по-русски, без эмодзи, без длинного тире и без markdown-разметки. Заголовки пиши обычным текстом. Отделяй факт от своего вывода. Нельзя писать, что закон, программа, ставка или правило изменились или вступили в силу, если в соответствующем свежем блоке нет официального источника. Предыдущий бриф разрешено использовать только для сравнения в разделе «Что изменилось со вчера». Никогда не используй его как источник текущих фактов, ссылок, законов или новостей и не переноси из него сведения, которых нет в свежих данных.",
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
  const todayKey = krasnoyarskDateKey();
  const storedPrevious = (await redis.get(MORNING_BRIEF_LAST_KEY)) || "";
  let previousBrief = "";

  try {
    const parsed = JSON.parse(storedPrevious) as {
      date?: string;
      brief?: string;
    };

    if (
      parsed?.date &&
      parsed.date !== todayKey &&
      typeof parsed.brief === "string"
    ) {
      previousBrief = parsed.brief;
    }
  } catch {
    // Old plain-text value from the first version is intentionally ignored.
  }

  const results = await Promise.allSettled([
    fetchKrasnoyarskWeather(),
    fetchCbrRates(),

    searchMany([
      "site:government.ru OR site:minenergo.gov.ru OR site:fas.gov.ru топливо бензин дизель экспорт ограничения дефицит последние 7 дней",
      "site:rosstat.gov.ru OR site:spimex.com бензин дизель цены нефтепродукты последние данные",
    ]),

    searchMany([
      "Красноярск и Россия: только новые события последних 7 дней на рынке сантехники, отопления, плитки, керамогранита, напольных и отделочных материалов: цены, акции, открытия, закрытия, бренды, поставщики, импорт, действия конкурентов. Не перечисляй магазины без события.",
    ]),

    searchMany([
      "site:cbr.ru ипотека жилищное кредитование ключевая ставка последние данные 2026",
      "site:minstroyrf.gov.ru OR site:rosstat.gov.ru строительство жилье ввод жилья последние данные 2026",
    ]),

    searchMany([
      "site:nalog.gov.ru с 1 октября 2026 изменения НДС налоги работодатели торговля последние публикации",
      "site:rostrud.gov.ru OR site:publication.pravo.gov.ru с 1 октября 2026 кадровый учет трудовое законодательство работодатели изменения",
    ]),

    searchMany([
      "site:government.ru OR site:minpromtorg.gov.ru торговля импорт маркировка логистика строительные материалы решения последние 14 дней",
      "site:minfin.gov.ru OR site:publication.pravo.gov.ru пошлины налоги торговля строительство решения последние 14 дней",
    ]),
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
        const raw = String(result.value);
        const validated =
          index <= 1 ? raw : validateSearchSection(labels[index], raw);
        return `${labels[index]}:\n${validated}`;
      }

      console.error(`${labels[index]} failed`, result.reason);
      return `${labels[index]}:\nСвежие данные получить не удалось после нескольких попыток.`;
    })
    .join("\n\n");

  const generatedBrief = await askYandexForBrief(
    context.slice(0, 24000),
    previousBrief.slice(0, 3500)
  );

  const verifiedBrief = enforceFinalSourcePolicy(generatedBrief);
  const coreBrief = rebuildTodayPriorities(verifiedBrief);

  const brief = [
    coreBrief.trim(),
    "",
    "Фраза дня",
    dailyPhrase(todayKey),
  ].join("\n");

  await redis.set(
    MORNING_BRIEF_LAST_KEY,
    JSON.stringify({ date: todayKey, brief }),
    { EX: 60 * 60 * 24 * 7 }
  );

  return brief.slice(0, 3900);
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

  let redis: Awaited<ReturnType<typeof getRedis>> | null = null;
  let lockAcquired = false;

  try {
    redis = await getRedis();

    const lock = await redis.set(MORNING_BRIEF_RUNNING_KEY, "1", {
      NX: true,
      EX: 5 * 60,
    });

    if (lock !== "OK") {
      return Response.json({ ok: true, skipped: "already_running" });
    }

    lockAcquired = true;

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

    const chatIdBeforeSend = await redis.get(MORNING_BRIEF_CHAT_KEY);
    if (!chatIdBeforeSend || Number(chatIdBeforeSend) !== chatId) {
      return Response.json({ ok: true, skipped: "brief_disabled_before_send" });
    }

    await sendTelegramMessage(chatId, brief);

    try {
      await sendExpenseReminders(chatId);
    } catch (error) {
      console.error("Expense reminder failed", error);
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Morning brief failed", error);
    return Response.json({ ok: false }, { status: 500 });
  } finally {
    if (redis && lockAcquired) {
      try {
        await redis.del(MORNING_BRIEF_RUNNING_KEY);
      } catch (error) {
        console.error("Could not release morning brief lock", error);
      }
    }
  }
}
