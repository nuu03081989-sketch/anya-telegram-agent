import {
  acquireBackgroundOcrTaskLock,
  listPendingBackgroundOcrTasks,
  releaseBackgroundOcrTaskLock,
  removeBackgroundOcrTask,
  saveBackgroundOcrExchange,
  type BackgroundOcrTask,
} from "@/app/lib/background-ocr";
import {
  analyzeExtractedDocument,
  getYandexPdfOcrResult,
  sanitizeDocumentMemory,
} from "@/app/skills/document-analysis";

export const runtime = "nodejs";
export const maxDuration = 120;

const TELEGRAM_API = "https://api.telegram.org";
const MAX_TASK_AGE_MS = 30 * 60 * 1000;

function cleanTelegramText(text: string) {
  return text
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*\*\s+/gm, "")
    .trim();
}

async function sendTelegramMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: cleanTelegramText(text).slice(0, 4090),
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status}`);
  }
}

function operationLabel(operation: BackgroundOcrTask["operations"][number]) {
  return operation.startPage === operation.endPage
    ? `Страница ${operation.startPage}`
    : `Страницы ${operation.startPage}-${operation.endPage}`;
}

function isTerminalOcrError(message: string) {
  return (
    message.includes("OCR_NOT_CONFIGURED") ||
    message.includes("OCR_PERMISSION_DENIED") ||
    message.includes("OCR_RESULT_FAILED")
  );
}

async function failTask(task: BackgroundOcrTask, text: string) {
  try {
    await sendTelegramMessage(task.chatId, text);
  } finally {
    await removeBackgroundOcrTask(task.id);
  }
}

async function processTask(task: BackgroundOcrTask) {
  const createdAt = Date.parse(task.createdAt);

  if (
    !Number.isFinite(createdAt) ||
    Date.now() - createdAt > MAX_TASK_AGE_MS
  ) {
    await failTask(
      task,
      "Аня, фоновый OCR этого файла не завершился за 30 минут. Я остановил задачу, чтобы она не висела бесконечно. Исходный файл в Redis не храню."
    );
    return "expired";
  }

  const locked = await acquireBackgroundOcrTaskLock(task.id);
  if (!locked) return "locked";

  try {
    const results = await Promise.all(
      task.operations.map((operation) =>
        getYandexPdfOcrResult(operation.operationId)
      )
    );

    if (results.some((result) => !result.done)) {
      return "pending";
    }

    const documentText = results
      .map((result, index) => {
        const operation = task.operations[index];
        const text = result.done ? result.text : "";
        return `[OCR часть ${index + 1}: ${operationLabel(operation)}]\n${text}`;
      })
      .join("\n\n");

    const answer = await analyzeExtractedDocument(
      task.fileName,
      documentText,
      task.userPrompt
    );

    await sendTelegramMessage(task.chatId, answer);
    await saveBackgroundOcrExchange(
      task.chatId,
      task.fileName,
      task.userPrompt,
      sanitizeDocumentMemory(answer)
    );
    await removeBackgroundOcrTask(task.id);

    return "completed";
  } catch (error) {
    const message = String(error);
    console.error("Background OCR task failed", task.id, error);

    if (isTerminalOcrError(message)) {
      await failTask(
        task,
        "Аня, фоновый OCR остановился из-за ошибки доступа или ответа Yandex Vision. Задачу закрыл, чтобы она не повторялась бесконечно."
      );
      return "failed";
    }

    return "retry";
  } finally {
    await releaseBackgroundOcrTaskLock(task.id).catch(() => {});
  }
}

export async function GET() {
  return Response.json({
    ok: true,
    service: "ocr-worker",
    enabled: process.env.OCR_BACKGROUND_ENABLED === "true",
  });
}

export async function POST(request: Request) {
  const expectedSecret = process.env.OCR_WORKER_SECRET;
  const receivedSecret = request.headers.get("x-ocr-worker-secret");

  if (!expectedSecret) {
    console.error("OCR_WORKER_SECRET is missing");
    return Response.json(
      { ok: false, error: "not_configured" },
      { status: 500 }
    );
  }

  if (receivedSecret !== expectedSecret) {
    return Response.json({ ok: false }, { status: 401 });
  }

  if (process.env.OCR_BACKGROUND_ENABLED !== "true") {
    return Response.json({ ok: true, skipped: "disabled" });
  }

  const tasks = await listPendingBackgroundOcrTasks(10);
  const counts = {
    total: tasks.length,
    completed: 0,
    pending: 0,
    retry: 0,
    failed: 0,
    expired: 0,
    locked: 0,
  };

  for (const task of tasks) {
    const result = await processTask(task);

    if (result in counts) {
      counts[result as keyof typeof counts] += 1;
    }
  }

  return Response.json({ ok: true, ...counts });
}
