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

function extractModelText(data: any) {
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((item: any) =>
        typeof item === "string"
          ? item
          : String(item?.text ?? item?.content ?? "")
      )
      .filter(Boolean)
      .join(" ")
      .trim();

    if (joined) return joined;
  }

  return String(
    data?.result?.alternatives?.[0]?.message?.text ?? ""
  ).trim();
}

async function identifyProductPlain(
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
        temperature: 0.2,
        max_tokens: 1000,
        messages: [
          {
            role: "system",
            content:
              "Ты Саня. Определи товар на фотографии максимально конкретно. Назови сам предмет, бренд или лицензию только если они видны, перепиши заметные надписи и укажи цвет/форму. Не выдумывай модель или артикул. Ответь одной короткой фразой без JSON.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  userText ||
                  "Что это за товар? Опиши его так, чтобы затем можно было найти в продаже.",
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
    "PRODUCT_PHOTO_IDENTIFY_RETRY_TIMEOUT"
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `PRODUCT_PHOTO_IDENTIFY_RETRY_FAILED: ${response.status} ${JSON.stringify(data).slice(0, 700)}`
    );
  }

  const raw = extractModelText(data);
  return looseIdentityFromText(raw, userText);
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

  const raw = extractModelText(data);

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

function normalizedWords(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3);
}

function distinctiveIdentityWords(identity: ProductIdentity) {
  const strong = [
    identity.brand,
    identity.model,
    ...identity.visibleText,
  ]
    .flatMap(normalizedWords)
    .filter(
      (word) =>
        ![
          "черный",
          "черная",
          "черное",
          "белый",
          "белая",
          "пенал",
          "товар",
          "набор",
          "фото",
        ].includes(word)
    );

  const productWords = normalizedWords(identity.productName).filter(
    (word) =>
      ![
        "вероятно",
        "похоже",
        "фотографии",
        "черный",
        "черная",
        "овальный",
        "пенал",
        "лицензией",
        "надписью",
        "товар",
      ].includes(word)
  );

  return {
    strong: [...new Set(strong)],
    product: [...new Set(productWords)],
  };
}

function productMatchScore(identity: ProductIdentity, hit: SearchHit) {
  const haystack = `${hit.title} ${hit.snippet} ${hit.url}`
    .toLowerCase()
    .replace(/ё/g, "е");
  const words = distinctiveIdentityWords(identity);

  const strongMatches = words.strong.filter((word) =>
    haystack.includes(word)
  ).length;
  const productMatches = words.product.filter((word) =>
    haystack.includes(word)
  ).length;

  let score = strongMatches * 4 + Math.min(productMatches, 4);

  if (
    identity.category &&
    normalizedWords(identity.category).some((word) => haystack.includes(word))
  ) {
    score += 1;
  }

  return score;
}

function hasStrongProductAnchor(identity: ProductIdentity, hit: SearchHit) {
  const words = distinctiveIdentityWords(identity);
  if (words.strong.length === 0) {
    return productMatchScore(identity, hit) >= 2;
  }

  const haystack = `${hit.title} ${hit.snippet} ${hit.url}`
    .toLowerCase()
    .replace(/ё/g, "е");

  return words.strong.some((word) => haystack.includes(word));
}

function mentionsRequestedCity(userText: string, hit: SearchHit) {
  if (!/красноярск/i.test(userText)) return false;

  return /(?:красноярск|krasnoyarsk)/i.test(
    `${hit.title} ${hit.snippet} ${hit.url}`
  );
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

async function collectHits(
  queries: string[],
  identity: ProductIdentity
) {
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

  return dedupeHits(hits)
    .filter((hit) => hasStrongProductAnchor(identity, hit))
    .sort(
      (a, b) =>
        productMatchScore(identity, b) - productMatchScore(identity, a)
    )
    .slice(0, 10);
}

function searchEvidence(
  identity: ProductIdentity,
  userText: string,
  hits: SearchHit[]
) {
  return hits
    .map((hit, index) => {
      const score = productMatchScore(identity, hit);
      const price =
        score >= 4 && hasStrongProductAnchor(identity, hit)
          ? extractVisiblePrice(`${hit.title} ${hit.snippet}`)
          : "";
      const cityConfirmed = mentionsRequestedCity(userText, hit);

      return [
        `[${index + 1}] ${hit.title}`,
        `URL: ${hit.url}`,
        `Совпадение с фото: ${score >= 8 ? "сильное" : score >= 4 ? "среднее" : "слабое"}`,
        /красноярск/i.test(userText)
          ? `Красноярск явно подтверждён в выдаче: ${cityConfirmed ? "да" : "нет"}`
          : "",
        price ? `Цена, явно видимая в выдаче: ${price}` : "Подтверждённой цены в выдаче нет.",
        `Фрагмент: ${hit.snippet || "нет фрагмента"}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
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
  userText: string,
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
    const score = productMatchScore(identity, hit);
    const price =
      score >= 4 && hasStrongProductAnchor(identity, hit)
        ? extractVisiblePrice(`${hit.title} ${hit.snippet}`)
        : "";
    const cityConfirmed = mentionsRequestedCity(userText, hit);

    lines.push(
      [
        hit.title,
        score >= 8
          ? "Совпадение с фото: сильное."
          : "Совпадение с фото: похожий вариант.",
        price ? `Цена в выдаче: ${price}` : "Подтверждённой цены в выдаче нет.",
        /красноярск/i.test(userText)
          ? cityConfirmed
            ? "Красноярск указан в выдаче."
            : "Наличие или доставка в Красноярск по выдаче не подтверждены."
          : "",
        hit.url,
      ]
        .filter(Boolean)
        .join("\n")
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
              "Не используй цену из результата, который относится к другому товару, даже если он тоже является пеналом или похож по цвету.",
              "Цена считается подтверждённой только если в блоке конкретного результата указана строка «Цена, явно видимая в выдаче». Иначе пиши, что подтверждённой цены нет.",
              "Если пользователь просит Красноярск, не утверждай местное наличие или доставку, пока в блоке результата не указано «Красноярск явно подтверждён в выдаче: да».",
              "Категорийная страница маркетплейса подтверждает только наличие похожих предложений на площадке, но не точную модель, цену или наличие в городе.",
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
              searchEvidence(identity, userText, hits),
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

  let identity: ProductIdentity;

  try {
    identity = await identifyProduct(context.imageBase64, context.text);
  } catch (error) {
    console.error(
      "Structured product identification failed, retrying plain photo analysis",
      error
    );

    try {
      identity = await identifyProductPlain(
        context.imageBase64,
        context.text
      );
    } catch (retryError) {
      console.error("Plain product identification failed", retryError);

      return {
        handled: true,
        text:
          "Аня, фото получил и понял, что нужно найти товар в продаже, но распознавание самого предмета сейчас не ответило даже со второй попытки. Поиск вслепую запускать не буду. Попробуй ещё раз чуть позже.",
      };
    }
  }

  const queries = Array.from(
    new Set([
      ...fallbackQueries(identity, context.text).slice(0, 1),
      ...identity.searchQueries,
      ...fallbackQueries(identity, context.text).slice(1),
    ])
  )
    .filter(Boolean)
    .slice(0, 3);

  const hits = await collectHits(queries, identity);

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
      text: deterministicShoppingFallback(identity, context.text, hits),
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
