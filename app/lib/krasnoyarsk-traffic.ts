const MAPBOX_DIRECTIONS_API = "https://api.mapbox.com/directions/v5/mapbox/driving-traffic";
const TRAFFIC_CACHE_MS = 90 * 1000;
const MAPBOX_TIMEOUT_MS = 12_000;

type TrafficCorridor = {
  id: string;
  label: string;
  from: [number, number];
  to: [number, number];
};

type MapboxRoute = {
  duration?: number;
  duration_typical?: number;
  distance?: number;
  legs?: Array<{
    summary?: string;
    incidents?: Array<{
      type?: string;
      description?: string;
      impact?: string;
      closed?: boolean;
      affected_road_names?: string[];
    }>;
    closures?: unknown[];
    annotation?: {
      congestion_numeric?: Array<number | null>;
      distance?: number[];
    };
  }>;
};

export type TrafficCorridorResult = {
  id: string;
  label: string;
  score10: number;
  congestion100: number;
  delayMinutes: number;
  delayPercent: number;
  durationMinutes: number;
  typicalMinutes: number;
  distanceKm: number;
  trafficCoverage: number;
  incidents: number;
  closures: number;
  summary: string;
};

export type KrasnoyarskTrafficSummary = {
  score10: number;
  level: string;
  corridors: TrafficCorridorResult[];
  trafficCoverage: number;
  fetchedAt: string;
};

const CORRIDORS: TrafficCorridor[] = [
  {
    id: "svobodny-vzletka",
    label: "Свободный → Взлётка",
    from: [92.779, 56.033],
    to: [92.924, 56.041],
  },
  {
    id: "center-severny",
    label: "Центр → Северный",
    from: [92.865, 56.012],
    to: [92.941, 56.074],
  },
  {
    id: "kommunalny-bridge",
    label: "Коммунальный мост",
    from: [92.866, 56.008],
    to: [92.889, 55.989],
  },
  {
    id: "oktyabrsky-bridge",
    label: "Октябрьский мост",
    from: [92.921, 56.035],
    to: [92.956, 55.997],
  },
  {
    id: "right-bank",
    label: "Правый берег, запад → восток",
    from: [92.882, 55.989],
    to: [92.987, 56.005],
  },
];

let cache:
  | {
      expiresAtMs: number;
      value: KrasnoyarskTrafficSummary;
    }
  | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function trafficLevel(score10: number) {
  if (score10 < 2) return "дороги в основном свободны";
  if (score10 < 4) return "движение умеренное";
  if (score10 < 6) return "движение плотное";
  if (score10 < 8) return "сильные заторы";
  return "очень тяжёлая дорожная обстановка";
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAPBOX_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw new Error("MAPBOX_TRAFFIC_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function weightedCongestion(route: MapboxRoute) {
  let weighted = 0;
  let knownDistance = 0;
  let totalDistance = 0;

  for (const leg of route.legs || []) {
    const congestion = leg.annotation?.congestion_numeric || [];
    const distances = leg.annotation?.distance || [];
    const count = Math.max(congestion.length, distances.length);

    for (let index = 0; index < count; index += 1) {
      const distance = Number(distances[index] || 0);
      const value = congestion[index];

      if (distance > 0) totalDistance += distance;

      if (
        distance > 0 &&
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        weighted += clamp(value, 0, 100) * distance;
        knownDistance += distance;
      }
    }
  }

  if (knownDistance <= 0) {
    return {
      value: null as number | null,
      coverage: 0,
    };
  }

  return {
    value: weighted / knownDistance,
    coverage: totalDistance > 0 ? knownDistance / totalDistance : 1,
  };
}

function routeIncidents(route: MapboxRoute) {
  let incidents = 0;
  let closures = 0;

  for (const leg of route.legs || []) {
    incidents += Array.isArray(leg.incidents) ? leg.incidents.length : 0;
    closures += Array.isArray(leg.closures) ? leg.closures.length : 0;
  }

  return { incidents, closures };
}

function routeSummary(route: MapboxRoute) {
  return (route.legs || [])
    .map((leg) => String(leg.summary || "").trim())
    .filter(Boolean)
    .join(", ");
}

async function fetchCorridor(
  token: string,
  corridor: TrafficCorridor
): Promise<TrafficCorridorResult> {
  const coordinates =
    `${corridor.from[0]},${corridor.from[1]};${corridor.to[0]},${corridor.to[1]}`;

  const params = new URLSearchParams({
    access_token: token,
    alternatives: "false",
    annotations: "congestion_numeric,distance,closure",
    overview: "full",
    steps: "false",
  });

  const response = await fetchWithTimeout(
    `${MAPBOX_DIRECTIONS_API}/${coordinates}?${params.toString()}`
  );

  const data = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    routes?: MapboxRoute[];
  };

  if (!response.ok || data.code !== "Ok") {
    if (response.status === 401) {
      throw new Error("MAPBOX_TRAFFIC_UNAUTHORIZED");
    }
    if (response.status === 403) {
      throw new Error("MAPBOX_TRAFFIC_FORBIDDEN");
    }
    if (response.status === 429) {
      throw new Error("MAPBOX_TRAFFIC_RATE_LIMIT");
    }

    throw new Error(
      `MAPBOX_TRAFFIC_HTTP_${response.status || "UNKNOWN"}:${data.code || ""}`
    );
  }

  const route = data.routes?.[0];
  if (!route) {
    throw new Error(`MAPBOX_TRAFFIC_NO_ROUTE:${corridor.id}`);
  }

  const duration = Number(route.duration || 0);
  const typical = Number(route.duration_typical || duration || 0);
  const distance = Number(route.distance || 0);

  if (duration <= 0 || typical <= 0 || distance <= 0) {
    throw new Error(`MAPBOX_TRAFFIC_BAD_ROUTE:${corridor.id}`);
  }

  const congestion = weightedCongestion(route);
  const delayPercent = Math.max(0, ((duration - typical) / typical) * 100);
  const delayScore = clamp(delayPercent * 3, 0, 100);

  const score100 =
    congestion.value === null
      ? delayScore
      : congestion.value * 0.72 + delayScore * 0.28;

  const events = routeIncidents(route);

  return {
    id: corridor.id,
    label: corridor.label,
    score10: round1(clamp(score100 / 10, 0, 10)),
    congestion100:
      congestion.value === null ? 0 : round1(congestion.value),
    delayMinutes: round1(Math.max(0, (duration - typical) / 60)),
    delayPercent: round1(delayPercent),
    durationMinutes: round1(duration / 60),
    typicalMinutes: round1(typical / 60),
    distanceKm: round1(distance / 1000),
    trafficCoverage: round1(clamp(congestion.coverage, 0, 1) * 100),
    incidents: events.incidents,
    closures: events.closures,
    summary: routeSummary(route),
  };
}

export async function getKrasnoyarskTraffic(): Promise<KrasnoyarskTrafficSummary> {
  if (cache && cache.expiresAtMs > Date.now()) {
    return cache.value;
  }

  const token = process.env.MAPBOX_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("MAPBOX_ACCESS_TOKEN_MISSING");
  }

  const settled = await Promise.allSettled(
    CORRIDORS.map((corridor) => fetchCorridor(token, corridor))
  );

  const corridors = settled
    .filter(
      (
        item
      ): item is PromiseFulfilledResult<TrafficCorridorResult> =>
        item.status === "fulfilled"
    )
    .map((item) => item.value);

  if (corridors.length === 0) {
    const reasons = settled
      .filter(
        (item): item is PromiseRejectedResult => item.status === "rejected"
      )
      .map((item) =>
        item.reason instanceof Error ? item.reason.message : String(item.reason)
      );

    const priority =
      reasons.find((reason) => reason.includes("FORBIDDEN")) ||
      reasons.find((reason) => reason.includes("UNAUTHORIZED")) ||
      reasons.find((reason) => reason.includes("RATE_LIMIT")) ||
      reasons.find((reason) => reason.includes("TIMEOUT")) ||
      reasons[0] ||
      "MAPBOX_TRAFFIC_UNAVAILABLE";

    throw new Error(priority);
  }

  const score10 = round1(
    corridors.reduce((sum, item) => sum + item.score10, 0) /
      corridors.length
  );

  const trafficCoverage = round1(
    corridors.reduce((sum, item) => sum + item.trafficCoverage, 0) /
      corridors.length
  );

  const value: KrasnoyarskTrafficSummary = {
    score10,
    level: trafficLevel(score10),
    corridors: [...corridors].sort(
      (left, right) =>
        right.score10 - left.score10 ||
        right.delayMinutes - left.delayMinutes
    ),
    trafficCoverage,
    fetchedAt: new Date().toISOString(),
  };

  cache = {
    expiresAtMs: Date.now() + TRAFFIC_CACHE_MS,
    value,
  };

  return value;
}

export function formatKrasnoyarskTraffic(
  summary: KrasnoyarskTrafficSummary
) {
  const worst = summary.corridors.slice(0, 3);
  const incidents = summary.corridors.reduce(
    (sum, item) => sum + item.incidents,
    0
  );
  const closures = summary.corridors.reduce(
    (sum, item) => sum + item.closures,
    0
  );

  const lines = [
    `Аня, сейчас в Красноярске моя расчётная оценка загруженности дорог: ${summary.score10.toFixed(1).replace(".", ",")}/10, ${summary.level}.`,
    "",
    "Самые нагруженные из проверенных направлений:",
    ...worst.map((item, index) => {
      const delay =
        item.delayMinutes >= 0.5
          ? `, задержка примерно +${item.delayMinutes.toFixed(1).replace(".", ",")} мин к обычному времени`
          : ", заметной дополнительной задержки нет";
      return `${index + 1}. ${item.label}: ${item.score10.toFixed(1).replace(".", ",")}/10${delay}.`;
    }),
  ];

  if (incidents > 0 || closures > 0) {
    lines.push(
      "",
      `На проверенных маршрутах Mapbox сообщает событий: ${incidents}, перекрытий: ${closures}.`
    );
  }

  lines.push(
    "",
    "Это расчётная оценка Сани по текущим данным Mapbox driving-traffic, а не официальный балл Яндекс Пробок."
  );

  if (summary.trafficCoverage < 35) {
    lines.push(
      "Покрытие live-данными на проверенных участках сейчас ограниченное, поэтому оценку лучше считать ориентировочной."
    );
  }

  return lines.join("\n");
}
