import { createClient } from "redis";

export const runtime = "nodejs";

const TELEGRAM_API = "https://api.telegram.org";
const YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions";
const WEBHOOK_URL = "https://anya-telegram-agent.vercel.app/api/telegram";
const HISTORY_LIMIT = 30;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 14;

const SYSTEM_PROMPT = [
  "Тебя зовут Саня. Ты мужского пола и работаешь как персональный ИИ-ассистент Ани.",
  "Обращайся к пользователю только по имени Аня.",
  "Пиши по-русски живо, дружелюбно и по делу, с лёгкой иронией, без сухости и официоза.",
  "Не используй эмодзи.",
  "Не используй длинное тире. Для пауз и пояснений используй запятые, двоеточия, скобки или короткий дефис.",
  "Без запроса не используй markdown-разметку, звёздочки и подчёркивания.",
  "Никогда не выдумывай факты. Если не уверен, прямо скажи: «не уверен, но можем попробовать».",
  "Если Аня просит оценку по факту, отвечай кратко, прагматично и критично, отмечай риски и слабые места логики.",
  "В технических инструкциях учитывай, что уровень программирования у Ани низкий. Давай действия строго по шагам, желательно по одному действию за раз, без скачков через этапы.",
  "Для сервисов, API и регистраций учитывай, что Аня живёт в России. Если доступность сервиса, оплата или ограничения могут зависеть от страны и ты не уверен в актуальности, прямо скажи об этом и не выдавай догадку за факт.",
  "Не используй конструкцию «это не x это y».",
  "Отвечай достаточно кратко, если Аня не просит подробностей.",
  "У тебя есть краткосрочная память последних сообщений этого Telegram-чата. Используй её, чтобы понимать контекст и не просить Аню повторять то, что уже было сказано недавно.",
].join("\n");

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type TelegramUpdate = {
  message?: {
    chat?: { id?: number };
    text?: string;
  };
};

let redisClient: ReturnType<typeof createClient> | null = null;

async function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is missing");

  if (!redisClient) {
    redisClient = createClient({ url });
    redisClient.on("error", (error) => console.error("Redis error", error));
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  return redisClient;
}

function historyKey(chatId: number) {
  return `telegram:history:${chatId}`;
}

async function loadHistory(chatId: number): Promise<ChatMessage[]> {
  try {
    const redis = await getRedis();
    const items = await redis.lRange(historyKey(chatId), -HISTORY_LIMIT, -1);

    return items.flatMap((item) => {
      try {
        const parsed = JSON.parse(item) as ChatMessage;
        if (
          (parsed.role === "user" || parsed.role === "assistant") &&
          typeof parsed.content === "string"
        ) {
          return [parsed];
        }
      } catch {}

      return [];
    });
  } catch (error) {
    console.error("Could not load Redis history", error);
    return [];
  }
}

async function saveExchange(
  chatId: number,
  userText: string,
  assistantText: string
) {
  try {
    const redis = await getRedis();
    const key = historyKey(chatId);

    await redis
      .multi()
      .rPush(key, JSON.stringify({ role: "user", content: userText }))
      .rPush(key, JSON.stringify({ role: "assistant", content: assistantText }))
      .lTrim(key, -HISTORY_LIMIT, -1)
      .expire(key, HISTORY_TTL_SECONDS)
      .exec();
  } catch (error) {
    console.error("Could not save Redis history", error);
  }
}

async function clearHistory(chatId: number) {
  try {
    const redis = await getRedis();
    await redis.del(historyKey(chatId));
    return true;
  } catch (error) {
    console.error("Could not clear Redis history", error);
    return false;
  }
}

async function sendTelegramMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status}`);
  }
}

async function configureWebhookSecret() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is missing");

  const response = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: WEBHOOK_URL,
      secret_token: secret,
    }),
  });

  const data = await response.json();

  if (!response.ok || data?.ok !== true) {
    throw new Error(
      `Telegram setWebhook failed: ${response.status} ${JSON.stringify(data)}`
    );
  }
}

async function askYandex(userText: string, history: ChatMessage[]) {
  const apiKey = process.env.YANDEX_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey) throw new Error("YANDEX_API_KEY is missing");
  if (!folderId) throw new Error("YANDEX_FOLDER_ID is missing");

  const response = await fetch(YANDEX_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Api-Key ${apiKey}`,
      "x-folder-id": folderId,
    },
    body: JSON.stringify({
      model: `gpt://${folderId}/yandexgpt/latest`,
      temperature: 0.4,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        ...history,
        {
          role: "user",
          content: userText,
        },
      ],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Yandex API failed: ${response.status} ${JSON.stringify(data)}`);
  }

  const answer =
    data?.choices?.[0]?.message?.content ??
    data?.result?.alternatives?.[0]?.message?.text ??
    "Не удалось получить ответ от модели.";

  return String(answer).slice(0, 3900);
}

export async function GET() {
  return Response.json({ ok: true, service: "anya-telegram-agent" });
}

export async function POST(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedSecret) {
    console.error("TELEGRAM_WEBHOOK_SECRET is missing");
    return Response.json({ ok: false }, { status: 500 });
  }

  const receivedSecret = request.headers.get(
    "x-telegram-bot-api-secret-token"
  );

  if (receivedSecret !== expectedSecret) {
    if (!receivedSecret) {
      try {
        await configureWebhookSecret();
        return Response.json({ ok: true, webhook_protected: true });
      } catch (error) {
        console.error(error);
        return Response.json({ ok: false }, { status: 500 });
      }
    }

    return Response.json({ ok: false }, { status: 401 });
  }

  let update: TelegramUpdate;

  try {
    update = await request.json();
  } catch {
    return Response.json({ ok: true });
  }

  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim();

  if (!chatId || !text) {
    return Response.json({ ok: true });
  }

  if (text === "/reset" || text === "/forget") {
    const cleared = await clearHistory(chatId);
    await sendTelegramMessage(
      chatId,
      cleared
        ? "Аня, историю этого Telegram-чата очистил."
        : "Аня, не смог очистить историю. Попробуй ещё раз чуть позже."
    );
    return Response.json({ ok: true });
  }

  try {
    await sendTelegramMessage(chatId, "Принял. Думаю...");
    const history = await loadHistory(chatId);
    const answer = await askYandex(text, history);
    await sendTelegramMessage(chatId, answer);
    await saveExchange(chatId, text, answer);
  } catch (error) {
    console.error(error);
    await sendTelegramMessage(
      chatId,
      "Не смог обработать запрос. Проверь настройки Yandex Cloud и попробуй ещё раз."
    );
  }

  return Response.json({ ok: true });
}
