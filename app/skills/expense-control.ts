import { formatExpenseOverview } from "@/app/lib/expense-control";
import { getYandexBillingSummary } from "@/app/lib/yandex-billing";
import { defineSkill } from "./types";
import type { SkillContext, SkillResult } from "./types";

function billingDiagnosticFromError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "unknown error";

  console.error("Could not read Yandex Billing", message);

  if (message.includes("YANDEX_SERVICE_ACCOUNT_KEY_JSON is missing")) {
    return "KEY_MISSING";
  }

  if (message.includes("not valid JSON")) {
    return "KEY_JSON_INVALID";
  }

  if (message.includes("incomplete key data")) {
    return "KEY_INCOMPLETE";
  }

  if (message.startsWith("Yandex IAM token request failed:")) {
    const status = message.match(/failed:\s*(\d+)/)?.[1] || "UNKNOWN";
    return `IAM_HTTP_${status}`;
  }

  if (message.startsWith("Yandex Billing account list failed:")) {
    const status = message.match(/failed:\s*(\d+)/)?.[1] || "UNKNOWN";
    return `ACCOUNT_LIST_HTTP_${status}`;
  }

  if (message.includes("No active Yandex Billing account")) {
    return "ACCOUNT_NOT_FOUND";
  }

  if (message.includes("More than one active Yandex Billing account")) {
    return "ACCOUNT_MULTIPLE";
  }

  if (message.startsWith("Yandex Billing gRPC HTTP status")) {
    const status = message.match(/status\s+(\d+)/)?.[1] || "UNKNOWN";
    return `USAGE_HTTP_${status}`;
  }

  if (message.startsWith("Yandex Billing gRPC failed:")) {
    const status = message.match(/failed:\s*(\d+)/)?.[1] || "UNKNOWN";
    return `USAGE_GRPC_${status}`;
  }

  if (message.includes("gRPC")) {
    return "USAGE_GRPC_PROTOCOL";
  }

  return "UNKNOWN";
}

async function buildExpenseReport() {
  let yandexBilling = null;
  let billingDiagnostic = "";

  try {
    yandexBilling = await getYandexBillingSummary();
  } catch (error) {
    billingDiagnostic = billingDiagnosticFromError(error);
  }

  const report = formatExpenseOverview(new Date(), yandexBilling);

  return billingDiagnostic
    ? `${report}\n\nДиагностика Yandex Cloud: ${billingDiagnostic}`
    : report;
}

async function runExpenseControl(
  _context: SkillContext
): Promise<SkillResult> {
  return {
    handled: true,
    text: await buildExpenseReport(),
  };
}

export const expenseControlSkill = defineSkill({
  id: "expense-control",
  title: "Контроль расходов",
  description:
    "Показывает подписки, ожидаемые платежи, бюджет Yandex Cloud и фактические облачные расходы.",
  status: "native",
  costProfile: "no-new-cost",
  triggerHints: [
    "/expenses",
    "расходы",
    "подписки",
    "сколько потрачено",
    "сколько стоит бот",
    "платежи",
  ],
  dependencies: [
    "Yandex Billing",
    "Expense reminders",
    "Subscription registry",
  ],
  handler: {
    match(context: SkillContext) {
      const text = context.text.trim();
      const matched =
        /^\/expenses\b/i.test(text) ||
        /(?:расход|подписк|сколько\s+(?:потрачено|трачу|стоит)|платеж|списан)/i.test(
          text
        );

      return {
        matched,
        confidence: matched ? 0.95 : 0,
        reason: matched ? "expense intent" : "no expense intent",
      };
    },
    run: runExpenseControl,
  },
});
