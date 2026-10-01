export const runtime = "nodejs";

export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return Response.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN is missing" },
      { status: 500 }
    );
  }

  const [meResponse, webhookResponse] = await Promise.all([
    fetch(`https://api.telegram.org/bot${token}/getMe`),
    fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`),
  ]);

  const me = await meResponse.json();
  const webhook = await webhookResponse.json();

  return Response.json({
    ok: meResponse.ok && webhookResponse.ok && me?.ok === true && webhook?.ok === true,
    bot: me?.result
      ? {
          id: me.result.id,
          username: me.result.username,
          first_name: me.result.first_name,
        }
      : me,
    webhook: webhook?.result
      ? {
          url: webhook.result.url,
          pending_update_count: webhook.result.pending_update_count,
          last_error_date: webhook.result.last_error_date ?? null,
          last_error_message: webhook.result.last_error_message ?? null,
          max_connections: webhook.result.max_connections,
        }
      : webhook,
  });
}
