import { createClient } from "redis";
import { defineSkill } from "./types";
import type { SkillContext, SkillResult } from "./types";

const MORNING_BRIEF_CHAT_KEY = "telegram:morning-brief:chat-id";
const PUBLIC_APP_URL =
  process.env.PUBLIC_APP_URL || "https://anya-telegram-agent.vercel.app";

let redisClient: ReturnType<typeof createClient> | null = null;

async function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is missing");

  if (!redisClient) {
    redisClient = createClient({ url });
    redisClient.on("error", (error) =>
      console.error("Morning brief Redis error", error)
    );
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  return redisClient;
}

async function enableMorningBrief(chatId: number) {
  const redis = await getRedis();
  await redis.set(MORNING_BRIEF_CHAT_KEY, String(chatId));
}

async function disableMorningBrief() {
  const redis = await getRedis();
  await redis.del(MORNING_BRIEF_CHAT_KEY);
}

async function triggerMorningBriefNow() {
  const secret = process.env.MORNING_BRIEF_SECRET;
  if (!secret) throw new Error("MORNING_BRIEF_SECRET is missing");

  const response = await fetch(`${PUBLIC_APP_URL}/api/morning-brief`, {
    method: "POST",
    headers: {
      "x-brief-secret": secret,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `MORNING_BRIEF_TRIGGER_FAILED: ${response.status} ${body.slice(0, 500)}`
    );
  }
}

export type MorningBriefAction = "on" | "off" | "now" | null;

export function morningBriefAction(text: string): MorningBriefAction {
  const normalized = text.trim().toLowerCase();

  if (normalized === "/brief-on") return "on";
  if (normalized === "/brief-off") return "off";
  if (normalized === "/brief-now") return "now";

  return null;
}

async function runMorningBrief(
  context: SkillContext
): Promise<SkillResult> {
  const action = morningBriefAction(context.text);

  if (action === "on") {
    await enableMorningBrief(context.chatId);

    return {
      handled: true,
      text:
        "Аня, этот чат назначил для утреннего брифа. Расписание остаётся на 10:00 по Красноярску.",
      historyText: "Включил утренний бриф для этого Telegram-чата.",
    };
  }

  if (action === "off") {
    await disableMorningBrief();

    return {
      handled: true,
      text: "Аня, ежедневный утренний бриф отключил.",
      historyText: "Отключил ежедневный утренний бриф.",
    };
  }

  if (action === "now") {
    await triggerMorningBriefNow();

    return {
      handled: true,
      historyText: "Запустил утренний бриф вручную.",
    };
  }

  return { handled: false };
}

export const morningBriefSkill = defineSkill({
  id: "morning-brief",
  title: "Утренний бриф",
  description:
    "Управляет ежедневным бизнес-брифом и запускает его вручную, сохраняя проверенный генератор и расписание отдельно.",
  status: "native",
  costProfile: "existing-yandex-services",
  triggerHints: [
    "/brief-on",
    "/brief-off",
    "/brief-now",
    "утренний бриф",
  ],
  dependencies: [
    "Redis",
    "Yandex Cloud scheduled trigger",
    "Morning brief API",
    "Yandex Search",
    "YandexGPT",
  ],
  handler: {
    match(context: SkillContext) {
      const action = morningBriefAction(context.text);

      return {
        matched: action !== null,
        confidence: action ? 1 : 0,
        reason: action ? `brief ${action}` : "no morning brief command",
      };
    },
    run: runMorningBrief,
  },
});
