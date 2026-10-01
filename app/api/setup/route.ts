export const runtime = "nodejs";

const WEBHOOK_URL = "https://anya-telegram-agent.vercel.app/api/telegram";

export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return Response.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN is missing" },
      { status: 500 }
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: WEBHOOK_URL }),
    }
  );

  const data = await response.json();

  return Response.json({
    ok: response.ok && data?.ok === true,
    webhook_url: WEBHOOK_URL,
    telegram: data,
  });
}
