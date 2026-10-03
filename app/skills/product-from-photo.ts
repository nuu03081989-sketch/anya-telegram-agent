import { defineSkill } from "./types";
import type { SkillContext, SkillResult } from "./types";

const YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions";
const YANDEX_SEARCH_API = "https://searchapi.api.cloud.yandex.net/v2/web/search";
const YANDEX_VISION_MODEL = "qwen3.6-35b-a3b";
const SEARCH_TIMEOUT_MS = 14_000;
const MODEL_TIMEOUT_MS = 35_000;

type ProductIdentity = {
  productName: string;
  brand: string;
  model: string;
  category: string;
  visibleText: string[];
  visualDetails: string[];
  confidence: "high" | "medium" | "low";
  searchQueries: string[];
};

type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  query: string;
};

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

function extractJsonObject(raw: string) {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function looseIdentityFromText(
  raw: string,
  userText: string
): ProductIdentity {
  const cleaned = cleanTelegramText(raw)
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    throw new Error("PRODUCT_PHOTO_NO_IDENTITY");
  }

  const compact = cleaned.slice(0, 280);
  const visibleText = Array.from(
    compact.matchAll(/[«"“]([^»"”]{2,60})[»"”]/g),
    (match) => String(match[1]).trim()
  ).filter(Boolean).slice(0, 4);

  return {
    productName: compact,
    brand: "",
    model: "",
    category: "",
    visibleText,
    visualDetails: [],
    confidence: "low",
    searchQueries: [],
  };
}

export function isProductShoppingPhotoRequest(text: string) {
  return /(?:где\s+купить|где\s+найти|найди\s+(?:в\s+продаже|где\s+купить|магазин)|купить|цена|по\s+какой\s+цене|сколько\s+стоит|стоимость|в\s+продаже|заказать)/i.test(
    text
  );
}

async function identifyProduct(
  imageBase64: string,
  userText: string
): Promise<ProductIdentity> {
  const apiKey = process.env.YANDEX_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey) throw new Error("YANDEX_API_KEY is missing");
  if (!folderId) throw new Error("YANDEX_FOLDER_ID is missing");

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
        model: `gpt://${folderId}/${YANDEX_VISION_MODEL}`,
        temperature: 0.1,
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content: [
              "Ты распознаёшь товар по фотографии для последующего поиска в магазинах.",
              "Определи предмет, бренд/лицензию, модель или серию только если это реально видно.",
              "Не выдумывай артикул, бренд или модель.",
              "Считай надписи и логотипы на фото важными поисковыми признаками.",
              "Сформируй 3 поисковых запроса: точный, описательный и запасной широкий.",
              "Если пользователь указал город, включи город в запросы.",
              "Верни только JSON без markdown.",
              'Формат: {"productName":"...","brand":"...","model":"...","category":"...","visibleText":["..."],"visualDetails":["..."],"confidence":"high|medium|low","searchQueries":["...","...","..."]}',
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: userText || "Определи товар и подготовь запросы для поиска покупки.",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`,
                },
              },
            ],
          },
        ],
      }),
    },
    MODEL_TIMEOUT_MS,
    "PRODUCT_PHOTO_IDENTIFY_TIMEOUT"
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `PRODUCT_PHOTO_IDENTIFY_FAILED: ${response.status} ${JSON.stringify(data).slice(0, 700)}`
    );
  }

  const raw = String(
    data?.choices?.[0]?.message?.content ??
      data?.result?.alternatives?.[0]?.message?.text ??
      ""
  );

  const parsed = extractJsonObject(raw);

  if (!parsed) {
    console.warn("Product photo identify returned non-JSON, using text fallback");
    return looseIdentityFromText(raw, userText);
  }

  const productName = String(parsed?.productName || "").trim();
  if (!productName) {
    return looseIdentityFromText(raw, userText);
  }

  return {
    productName,
    brand: String(parsed?.brand || "").trim(),
    model: String(parsed?.model || "").trim(),
    category: String(parsed?.category || "").trim(),
    visibleText: Array.isArray(parsed?.visibleText)
      ? parsed.visibleText
          .map((item: unknown) => String(item).trim())
          .filter(Boolean)
          .slice(0, 6)
      : [],
    visualDetails: Array.isArray(parsed?.visualDetails)
      ? parsed.visualDetails
          .map((item: unknown) => String(item).trim())
          .filter(Boolean)
          .slice(0, 6)
      : [],
    confidence:
      parsed?.confidence === "high" || parsed?.confidence === "low"
        ? parsed.confidence
        : "medium",
    searchQueries: Array.isArray(parsed?.searchQueries)
      ? parsed.searchQueries
          .map((item: unknown) => String(item).trim())
          .filter(Boolean)
          .slice(0, 3)
      : [],
  };
}

function fallbackQueries(identity: ProductIdentity, userText: string) {
  const details = [
    identity.brand,
    identity.model,
    identity.productName,
    identity.visibleText.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const city = /красноярск/i.test(userText) ? "Красноярск" : "";

  return [
    `${details} ${city} купить цена`,
    `${identity.productName} ${identity.visibleText.join(" ")} ${city} купить`,
    `${identity.category || identity.productName} ${identity.visualDetails.join(" ")} ${city} цена`,
  ]
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
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
    "PRODUCT_PHOTO_SEARCH_TIMEOUT"
  );

  const data = await response.json();
  if (!response.ok || !data?.rawData) {
    throw new Error(
      `PRODUCT_PHOTO_SEARCH_FAILED: ${response.status} ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  const xml = Buffer.from(String(data.rawData), "base64").toString("utf8");

  return Array.from(xml.matchAll(/<doc[^>]*>([\s\S]*?)<\/doc>/gi))
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

      return {
        title: stripMarkup(title),
        url: stripMarkup(url),
        snippet: passages.join(" "),
        query: queryText,
      };
    })
    .filter((item) => /^https?:\/\//i.test(item.url));
}

function dedupeHits(hits: SearchHit[]) {
  const seen = new Set<string>();
  const result: SearchHit[] = [];

  for (const hit of hits) {
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    result.push(hit);
  }

  return result.slice(0, 12);
}

async function collectHits(queries: string[]) {
  const hits: SearchHit[] = [];

  for (let index = 0; index < queries.length; index += 1) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 650));
    }

    try {
      hits.push(...(await searchOne(queries[index])));
    } catch (error) {
      console.error(`Product photo search ${index + 1} failed`, error);
    }
  }

  return dedupeHits(hits);
}

function searchEvidence(hits: SearchHit[]) {
  return hits
    .map(
      (hit, index) =>
        `[${index + 1}] ${hit.title}\nURL: ${hit.url}\nФрагмент: ${hit.snippet || "нет фрагмента"}`
    )
    .join("\n\n")
    .slice(0, 18_000);
}

function extractVisiblePrice(text: string) {
  const match = text.match(
    /(?:от\s*)?\d[\d\s]{1,8}(?:[.,]\d{1,2})?\s*(?:₽|руб\.?|р\.)/i
  );

  return match?.[0]?.replace(/\s+/g, " ").trim() || "";
}

function deterministicShoppingFallback(
  identity: ProductIdentity,
  hits: SearchHit[]
) {
  const lines = [
    `Аня, на фото похоже на: ${identity.productName}.`,
    identity.brand ? `Бренд/лицензия: ${identity.brand}.` : "",
    `Уверенность распознавания: ${identity.confidence}.`,
    "",
    "Поиск нашёл такие варианты:",
  ].filter(Boolean);

  for (const hit of hits.slice(0, 5)) {
    const price = extractVisiblePrice(`${hit.title} ${hit.snippet}`);
    lines.push(
      [
        hit.title,
        price ? `Цена в выдаче: ${price}` : "Цену в выдаче не вижу.",
        hit.url,
      ].join("\n")
    );
  }

  lines.push(
    "",
    "Точное совпадение модели и наличие лучше проверить по ссылке перед покупкой."
  );

  return cleanTelegramText(lines.join("\n\n")).slice(0, 3900);
}

async function synthesizeShoppingAnswer(
  identity: ProductIdentity,
  userText: string,
  hits: SearchHit[]
) {
  const apiKey = process.env.YANDEX_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey) throw new Error("YANDEX_API_KEY is missing");
  if (!folderId) throw new Error("YANDEX_FOLDER_ID is missing");

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
        temperature: 0.15,
        max_tokens: 1200,
        messages: [
          {
            role: "system",
            content: [
              "Ты Саня, персональный ассистент Ани. Нужно помочь найти товар с фотографии в продаже.",
              "Используй только распознавание и результаты поиска ниже. Не выдумывай магазин, цену, наличие, модель, артикул или доставку.",
              "Различай точное совпадение и похожий товар. Если точность не подтверждена, прямо пиши «похожий вариант».",
              "Цена считается подтверждённой только если она явно есть в названии или фрагменте конкретного результата поиска.",
              "Если цена не видна, пиши «цену в выдаче не вижу», а не оценивай её сам.",
              "Если пользователь просит Красноярск, приоритет: наличие в Красноярске, затем доставка в Красноярск. Не утверждай наличие в городе без подтверждения.",
              "Не выдавай агрегаторную страницу за магазин, если из результата это не ясно.",
              "Ответ короткий и практичный: что на фото; насколько уверен; где нашёл; цены; что лучше проверить перед покупкой.",
              "Для каждого варианта укажи URL обычным текстом.",
              "Без markdown-таблиц, эмодзи и длинного тире.",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `Запрос Ани: ${userText}`,
              `Распознано: ${JSON.stringify(identity)}`,
              "",
              "РЕЗУЛЬТАТЫ ПОИСКА:",
              searchEvidence(hits),
            ].join("\n"),
          },
        ],
      }),
    },
    MODEL_TIMEOUT_MS,
    "PRODUCT_PHOTO_MODEL_TIMEOUT"
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `PRODUCT_PHOTO_MODEL_FAILED: ${response.status} ${JSON.stringify(data).slice(0, 700)}`
    );
  }

  const answer = String(
    data?.choices?.[0]?.message?.content ??
      data?.result?.alternatives?.[0]?.message?.text ??
      ""
  ).trim();

  if (!answer) throw new Error("PRODUCT_PHOTO_EMPTY_ANSWER");

  return cleanTelegramText(answer).slice(0, 3900);
}

async function runProductFromPhoto(
  context: SkillContext
): Promise<SkillResult> {
  if (!context.imageBase64) {
    return {
      handled: false,
    };
  }

  const identity = await identifyProduct(context.imageBase64, context.text);
  const queries =
    identity.searchQueries.length >= 2
      ? identity.searchQueries.slice(0, 3)
      : fallbackQueries(identity, context.text);

  const hits = await collectHits(queries);

  if (hits.length === 0) {
    return {
      handled: true,
      text: [
        `Аня, на фото похоже на: ${identity.productName}.`,
        identity.brand ? `Бренд/лицензия: ${identity.brand}.` : "",
        `Уверенность распознавания: ${identity.confidence}.`,
        "Но по сформированным запросам Yandex Search не вернул пригодных вариантов покупки. Цены выдумывать не буду.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  try {
    return {
      handled: true,
      text: await synthesizeShoppingAnswer(identity, context.text, hits),
    };
  } catch (error) {
    console.error("Product photo synthesis failed, using deterministic fallback", error);

    return {
      handled: true,
      text: deterministicShoppingFallback(identity, hits),
    };
  }
}

export const productFromPhotoSkill = defineSkill({
  id: "product-from-photo",
  title: "Товар по фото",
  description:
    "Распознаёт товар на фотографии, ищет точные и похожие варианты покупки, цены и доступность.",
  status: "native",
  costProfile: "existing-yandex-services",
  triggerHints: [
    "где купить это",
    "сколько стоит",
    "по какой цене",
    "найди в продаже",
    "что это и где купить",
  ],
  dependencies: ["Yandex multimodal model", "Yandex Search", "YandexGPT"],
  handler: {
    match(context: SkillContext) {
      const matched =
        Boolean(context.imageBase64) &&
        isProductShoppingPhotoRequest(context.text);

      return {
        matched,
        confidence: matched ? 1 : 0,
        reason: matched ? "photo shopping intent" : "no photo shopping intent",
      };
    },
    run: runProductFromPhoto,
  },
});
