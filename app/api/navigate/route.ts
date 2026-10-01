export const runtime = "nodejs";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const latRaw = url.searchParams.get("lat");
  const lonRaw = url.searchParams.get("lon");
  const name = url.searchParams.get("name") || "точка назначения";
  const query = url.searchParams.get("q");

  let deepLink: string;
  let title: string;

  if (latRaw && lonRaw) {
    const lat = Number(latRaw);
    const lon = Number(lonRaw);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return new Response("Некорректные координаты", { status: 400 });
    }

    deepLink =
      `yandexnavi://build_route_on_map?lat_to=${encodeURIComponent(
        lat
      )}&lon_to=${encodeURIComponent(lon)}`;
    title = `Маршрут до ${name}`;
  } else if (query) {
    deepLink = `yandexnavi://map_search?text=${encodeURIComponent(query)}`;
    title = `Поиск: ${query}`;
  } else {
    return new Response("Не указана точка назначения", { status: 400 });
  }

  const safeDeepLink = escapeHtml(deepLink);
  const safeTitle = escapeHtml(title);

  return new Response(
    `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 560px; margin: 48px auto; padding: 0 20px; line-height: 1.45; }
    a { display: inline-block; padding: 14px 18px; border-radius: 10px; background: #111; color: #fff; text-decoration: none; font-weight: 700; }
    p { color: #444; }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p>Если Яндекс Навигатор не открылся автоматически, нажми кнопку.</p>
  <p><a href="${safeDeepLink}">Открыть в Яндекс Навигаторе</a></p>
  <script>
    setTimeout(function () {
      window.location.href = ${JSON.stringify(deepLink)};
    }, 150);
  </script>
</body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}
