export const runtime = "nodejs";

const TELEGRAM_API = "https://api.telegram.org";
const YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions";
const WEBHOOK_URL = "https://anya-telegram-agent.vercel.app/api/telegram";

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
].join("\n");

type TelegramUpdate = {
  message?: {
    chat?: { id?: number };
    text?: string;
  };
};

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

async function askYandex(userText: string) {
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

  try {
    await sendTelegramMessage(chatId, "Принял. Думаю...");
    const answer = await askYandex(text);
    await sendTelegramMessage(chatId, answer);
  } catch (error) {
    console.error(error);
    await sendTelegramMessage(
      chatId,
      "Не смог обработать запрос. Проверь настройки Yandex Cloud и попробуй ещё раз."
    );
  }

  return Response.json({ ok: true });
}
