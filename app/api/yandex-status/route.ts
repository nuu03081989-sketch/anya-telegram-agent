export const runtime = "nodejs";

const YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions";

export async function GET() {
  const apiKey = process.env.YANDEX_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  if (!apiKey || !folderId) {
    return Response.json({
      ok: false,
      stage: "env",
      has_api_key: Boolean(apiKey),
      has_folder_id: Boolean(folderId),
    });
  }

  try {
    const response = await fetch(YANDEX_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Api-Key ${apiKey}`,
      },
      body: JSON.stringify({
        model: `gpt://${folderId}/yandexgpt/latest`,
        messages: [{ role: "user", content: "Ответь одним словом: работает" }],
        max_tokens: 20,
        temperature: 0,
      }),
    });

    const raw = await response.text();
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {}

    return Response.json({
      ok: response.ok,
      stage: "yandex",
      status: response.status,
      folder_id: folderId,
      response: parsed,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      stage: "network",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
