import {
  buildWardrobeMoodboardSearch,
  buildWardrobeOutfitSearch,
} from "@/app/lib/wardrobe-image-rules";
import { defineSkill } from "./types";
import type { SkillContext, SkillResult } from "./types";

function isContextualImageRequest(text: string) {
  return /(?:этих|эти|этого|таких|вариант|подбор|пример|выше|предыдущ)/i.test(
    text
  );
}

function isWardrobeImageContext(text: string) {
  return /(?:гардероб|одежд|образ|лук|наряд|капсул|аутфит|вещ|стил.{0,12}одеж)/i.test(
    text
  );
}

function isWardrobeMoodboardContext(text: string) {
  return /(?:подбор|сочетан.{0,14}цвет|цветов.{0,14}сочетан|палитр|цветов.{0,10}гардероб|мудборд|moodboard|коллаж|pantone)/i.test(
    text
  );
}

function extractContextListItems(content: string) {
  const normalized = content
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();

  const cleanItem = (value: string) =>
    value
      .split(/(?:Если хочешь|Источники:)/i)[0]
      .replace(/\s+/g, " ")
      .trim();

  const numberedItems = Array.from(
    normalized.matchAll(
      /(?:^|\n|\s)(\d+)[.)]\s*([\s\S]*?)(?=(?:\n|\s)\d+[.)]\s|$)/g
    ),
    (match) => cleanItem(match[2])
  ).filter(Boolean);

  if (numberedItems.length >= 2) {
    return numberedItems.slice(0, 7);
  }

  const lineItems = normalized
    .split("\n")
    .map(
      (line) =>
        line.match(/^\s*(?:[-•])\s+(.+?)\s*$/)?.[1]?.trim() || ""
    )
    .filter(Boolean);

  return lineItems.length >= 2 ? lineItems.slice(0, 7) : [];
}

function latestHistoryMessage(
  history: NonNullable<SkillContext["history"]>,
  role: "user" | "assistant"
) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === role) {
      return history[index].content;
    }
  }

  return "";
}

function contextItemLabel(item: string, index: number) {
  const compact = item.replace(/\s+/g, " ").trim();
  const short =
    compact.match(/^(.{2,70}?)(?::|\s[-–—]\s)/)?.[1]?.trim() ||
    compact.slice(0, 70).trim();

  return short
    ? `Вариант ${index + 1}: ${short}`
    : `Вариант ${index + 1}`;
}

function recentContext(context: SkillContext) {
  return [
    context.text,
    context.replyText || "",
    ...(context.history || []).slice(-10).map((message) => message.content),
  ]
    .filter(Boolean)
    .join("\n");
}

export function isWardrobeContextualImageRequest(context: SkillContext) {
  if (!isContextualImageRequest(context.text)) return false;

  return isWardrobeImageContext(recentContext(context));
}

function buildWardrobeQueries(context: SkillContext) {
  const history = context.history || [];
  const directContext = context.replyText?.trim() || "";
  let assistantContext = directContext;
  let listItems = directContext ? extractContextListItems(directContext) : [];

  // Direct reply/quote wins. Never replace it with an older Redis list.
  if (directContext && listItems.length < 2) {
    return [];
  }

  if (!directContext) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message?.role !== "assistant") continue;

      const items = extractContextListItems(message.content);
      if (items.length >= 2) {
        assistantContext = message.content;
        listItems = items;
        break;
      }
    }

    if (!assistantContext) {
      assistantContext = latestHistoryMessage(history, "assistant");
    }
  }

  if (!assistantContext) return [];

  const moodboardContext =
    isWardrobeMoodboardContext(context.text);

  let userContext = "";
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== "user") continue;

    if (isWardrobeImageContext(message.content)) {
      userContext = message.content;
      break;
    }
  }

  if (!userContext) {
    userContext = latestHistoryMessage(history, "user");
  }

  const baseContext = userContext
    .replace(/\s+/g, " ")
    .slice(0, 160)
    .trim();

  if (listItems.length > 0) {
    return listItems.map((item, index) =>
      moodboardContext
        ? buildWardrobeMoodboardSearch(item, index)
        : buildWardrobeOutfitSearch(
            [item, baseContext].filter(Boolean).join(" "),
            index
          )
    );
  }

  if (directContext) return [];

  const compactAssistant = assistantContext
    .replace(/\s+/g, " ")
    .slice(0, 260)
    .trim();

  if (moodboardContext) {
    const moodboard = buildWardrobeMoodboardSearch(compactAssistant, 0);

    return [
      {
        ...moodboard,
        label: "Фото по предыдущей подборке",
      },
    ];
  }

  const query = [
    "женская одежда готовый образ гардероб",
    baseContext,
    compactAssistant,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 320)
    .trim();

  return query
    ? [
        {
          label: "Фото по предыдущей подборке",
          query,
          fallbackQuery:
            `женская одежда образ ${compactAssistant}`
              .slice(0, 320)
              .trim(),
        },
      ]
    : [];
}

async function runWardrobe(
  context: SkillContext
): Promise<SkillResult> {
  return {
    handled: true,
    imageQueries: buildWardrobeQueries(context),
  };
}

export const wardrobeSkill = defineSkill({
  id: "wardrobe",
  title: "Гардероб и визуальный подбор",
  description:
    "Понимает контекст гардеробных подборок и формирует точные запросы для визуальных референсов и moodboard.",
  status: "native",
  costProfile: "existing-yandex-services",
  triggerHints: [
    "покажи фото этих вариантов",
    "подбери картинки к образам",
    "покажи предыдущие сочетания",
    "сделай визуальную подборку",
  ],
  dependencies: [
    "Yandex Image Search",
    "Telegram reply context",
    "Wardrobe image rules",
  ],
  handler: {
    match(context: SkillContext) {
      const matched = isWardrobeContextualImageRequest(context);

      return {
        matched,
        confidence: matched ? 0.98 : 0,
        reason: matched
          ? "wardrobe contextual image intent"
          : "no wardrobe contextual image intent",
      };
    },
    run: runWardrobe,
  },
});
