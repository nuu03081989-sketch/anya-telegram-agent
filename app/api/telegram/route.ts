export const runtime = "nodejs";

const TELEGRAM_API = "https://api.telegram.org";
const YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions";

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
      temperature: 0.3,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content:
            "Ты персональный ИИ-ассистент Ани. Отвечай по-русски, ясно, практично и по делу. Если не уверен в факте, прямо скажи об этом.",
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
