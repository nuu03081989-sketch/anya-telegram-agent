const KRASNOYARSK_TIME_ZONE = "Asia/Krasnoyarsk";

export type ExpenseReminder = {
  id: string;
  dueDate: string;
  message: string;
};

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
};

function getLocalDateParts(date = new Date()): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KRASNOYARSK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value || "0"),
    month: Number(parts.find((part) => part.type === "month")?.value || "0"),
    day: Number(parts.find((part) => part.type === "day")?.value || "0"),
  };
}

function dateKeyFromParts(year: number, month: number, day: number) {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

export function krasnoyarskDateKey(date = new Date()) {
  const { year, month, day } = getLocalDateParts(date);
  return dateKeyFromParts(year, month, day);
}

function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));

  return dateKeyFromParts(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate()
  );
}

function nextMonthlyDate(dayOfMonth: number, date = new Date()) {
  const local = getLocalDateParts(date);
  let year = local.year;
  let month = local.month;

  if (local.day > dayOfMonth) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return dateKeyFromParts(year, month, dayOfMonth);
}

function formatDateRu(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

function isOnOrBefore(left: string, right: string) {
  return left <= right;
}

export function formatExpenseOverview(
  date = new Date(),
  yandexBilling?: {
    currency: string;
    cost: number;
    expense: number;
    services: Array<{ name: string; cost: number; expense: number }>;
  } | null
) {
  const today = krasnoyarskDateKey(date);
  const browsecDue = nextMonthlyDate(28, date);
  const browsecReminder = shiftDateKey(browsecDue, -3);
  const chatGptPeriodEnd = "2026-10-28";
  const chatGptReminder = "2026-10-25";

  const chatGptStatus = isOnOrBefore(today, chatGptPeriodEnd)
    ? [
        "последний платёж: ₱982,14",
        "автопродление: отключено по письму OpenAI от 28.09.2026",
        `доступ оплачен до: ${formatDateRu(chatGptPeriodEnd)}`,
        `напоминание о решении по продлению: ${formatDateRu(chatGptReminder)}`,
      ]
    : [
        "последний известный платёж: ₱982,14",
        "последний подтверждённый оплаченный период закончился 28 октября 2026",
        "актуальный статус продления нужно перепроверить перед следующим платежом",
      ];

  const yandexLines = yandexBilling
    ? [
        `фактические расходы за месяц: ${yandexBilling.expense.toFixed(2).replace(".", ",")} ${yandexBilling.currency}`,
        `стоимость до скидок и грантов: ${yandexBilling.cost.toFixed(2).replace(".", ",")} ${yandexBilling.currency}`,
        ...(yandexBilling.services.length > 0
          ? [
              "по сервисам:",
              ...yandexBilling.services.slice(0, 6).map(
                (service) =>
                  `- ${service.name}: ${service.expense.toFixed(2).replace(".", ",")} ${yandexBilling.currency}`
              ),
            ]
          : []),
      ]
    : [
        "фактические расходы: временно не удалось получить из Billing API",
      ];

  return [
    "Аня, контроль расходов по нашим сервисам:",
    "",
    "Yandex Cloud",
    "бюджет: 500 ₽ в месяц",
    ...yandexLines,
    "за что платим: YandexGPT, поиск, OCR, SpeechKit и облачную инфраструктуру бота",
    "кабинет: https://console.yandex.cloud/billing",
    "",
    "Browsec Premium",
    "стоимость: 699 ₽ в месяц",
    `следующее ожидаемое автосписание: ${formatDateRu(browsecDue)}`,
    `напоминание: ${formatDateRu(browsecReminder)}`,
    "за что платим: VPN, премиум-серверы и повышенную скорость для работы с сервисами",
    "оплата/управление: https://browsec.com/en/orders/new",
    "",
    "ChatGPT Plus",
    ...chatGptStatus,
    "за что платим: расширенные лимиты и возможности ChatGPT для нашей работы",
    "управление подпиской: https://chatgpt.com/account/subscription",
    "",
    "Vercel Hobby",
    "стоимость: 0 ₽",
    "за что используем: размещение Telegram-бота",
    "кабинет: https://vercel.com/dashboard",
    "",
    "Redis",
    "отдельный платёж пока не подтверждён",
    "за что используем: краткосрочная память и служебная статистика бота",
  ].join("\n");
}

export function getExpenseReminders(date = new Date()): ExpenseReminder[] {
  const today = krasnoyarskDateKey(date);
  const reminders: ExpenseReminder[] = [];

  const browsecDue = nextMonthlyDate(28, date);
  const browsecReminder = shiftDateKey(browsecDue, -3);

  if (today === browsecReminder) {
    reminders.push({
      id: "browsec-premium",
      dueDate: browsecDue,
      message: [
        `Аня, через 3 дня, ${formatDateRu(browsecDue)}, ожидается автосписание 699 ₽ за Browsec Premium.`,
        "Для чего платим: VPN, премиум-серверы и повышенная скорость для работы с сервисами.",
        "Оплата/управление: https://browsec.com/en/orders/new",
      ].join("\n"),
    });
  }

  if (today === "2026-10-25") {
    reminders.push({
      id: "chatgpt-plus-period-end",
      dueDate: "2026-10-28",
      message: [
        "Аня, через 3 дня заканчивается текущий оплаченный период ChatGPT Plus.",
        "По последнему письму OpenAI автопродление отключено, поэтому автоматического списания сейчас не ожидаю.",
        "Последний платёж: ₱982,14.",
        "Для чего платим: расширенные лимиты и возможности ChatGPT для нашей работы.",
        "Если хочешь сохранить Plus, проверить и продлить можно здесь: https://chatgpt.com/account/subscription",
      ].join("\n"),
    });
  }

  return reminders;
}
