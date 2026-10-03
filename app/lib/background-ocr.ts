import { createClient } from "redis";
import type { BackgroundOcrOperation } from "@/app/skills/document-analysis";

const OCR_PENDING_KEY = "telegram:ocr:pending";
const OCR_TASK_TTL_SECONDS = 60 * 60 * 24;
const OCR_LOCK_TTL_SECONDS = 90;

export type BackgroundOcrTask = {
  id: string;
  chatId: number;
  fileName: string;
  userPrompt: string;
  operations: BackgroundOcrOperation[];
  createdAt: string;
};

let redisClient: ReturnType<typeof createClient> | null = null;

async function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is missing");

  if (!redisClient) {
    redisClient = createClient({ url });
    redisClient.on("error", (error) =>
      console.error("Background OCR Redis error", error)
    );
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  return redisClient;
}

function taskKey(taskId: string) {
  return `telegram:ocr:task:${taskId}`;
}

function lockKey(taskId: string) {
  return `telegram:ocr:lock:${taskId}`;
}

export async function enqueueBackgroundOcrTask(
  input: Omit<BackgroundOcrTask, "id" | "createdAt">
) {
  const redis = await getRedis();
  const id = crypto.randomUUID();
  const task: BackgroundOcrTask = {
    ...input,
    id,
    createdAt: new Date().toISOString(),
  };

  await redis
    .multi()
    .set(taskKey(id), JSON.stringify(task), { EX: OCR_TASK_TTL_SECONDS })
    .sAdd(OCR_PENDING_KEY, id)
    .expire(OCR_PENDING_KEY, OCR_TASK_TTL_SECONDS)
    .exec();

  return task;
}

export async function listPendingBackgroundOcrTasks(limit = 10) {
  const redis = await getRedis();
  const ids = (await redis.sMembers(OCR_PENDING_KEY)).slice(0, limit);
  const tasks: BackgroundOcrTask[] = [];

  for (const id of ids) {
    const raw = await redis.get(taskKey(id));

    if (!raw) {
      await redis.sRem(OCR_PENDING_KEY, id);
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as BackgroundOcrTask;

      if (
        parsed &&
        typeof parsed.id === "string" &&
        Number.isFinite(parsed.chatId) &&
        Array.isArray(parsed.operations)
      ) {
        tasks.push(parsed);
      } else {
        await removeBackgroundOcrTask(id);
      }
    } catch {
      await removeBackgroundOcrTask(id);
    }
  }

  return tasks;
}

export async function acquireBackgroundOcrTaskLock(taskId: string) {
  const redis = await getRedis();
  const result = await redis.set(lockKey(taskId), "1", {
    NX: true,
    EX: OCR_LOCK_TTL_SECONDS,
  });

  return result === "OK";
}

export async function releaseBackgroundOcrTaskLock(taskId: string) {
  const redis = await getRedis();
  await redis.del(lockKey(taskId));
}

export async function removeBackgroundOcrTask(taskId: string) {
  const redis = await getRedis();

  await redis
    .multi()
    .sRem(OCR_PENDING_KEY, taskId)
    .del(taskKey(taskId))
    .del(lockKey(taskId))
    .exec();
}

export async function saveBackgroundOcrExchange(
  chatId: number,
  fileName: string,
  userPrompt: string,
  assistantText: string
) {
  const redis = await getRedis();
  const key = `telegram:history:${chatId}`;
  const userText = userPrompt
    ? `[Файл: ${fileName}] ${userPrompt}`
    : `[Файл: ${fileName}]`;

  await redis
    .multi()
    .rPush(key, JSON.stringify({ role: "user", content: userText }))
    .rPush(
      key,
      JSON.stringify({ role: "assistant", content: assistantText })
    )
    .lTrim(key, -30, -1)
    .expire(key, 60 * 60 * 24 * 14)
    .exec();
}
