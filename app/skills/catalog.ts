import { productFromPhotoSkill } from "./product-from-photo";
import { researchSkill } from "./research";
import { defineSkill } from "./types";

export const SKILLS = [
  defineSkill({
    id: "wardrobe",
    title: "Гардероб и визуальный подбор",
    description:
      "Подбор образов, визуальных референсов и работа с контекстом списка одежды.",
    status: "legacy",
    costProfile: "existing-yandex-services",
    triggerHints: ["образ", "лук", "гардероб", "что надеть", "референсы"],
    dependencies: ["Yandex Search", "Telegram reply context"],
  }),
  researchSkill,
  productFromPhotoSkill,
  defineSkill({
    id: "document-analysis",
    title: "Анализ документов",
    description:
      "Чтение и анализ PDF, Word, Excel, CSV, TXT и сканов с OCR.",
    status: "legacy",
    costProfile: "existing-yandex-services",
    triggerHints: ["проанализируй файл", "сделай выжимку", "сравни документы"],
    dependencies: ["PDF parser", "Mammoth", "XLSX", "Yandex Vision"],
  }),
  defineSkill({
    id: "expense-control",
    title: "Контроль расходов",
    description:
      "Учёт подписок, облачных расходов, бюджетных порогов и напоминаний.",
    status: "legacy",
    costProfile: "no-new-cost",
    triggerHints: ["расходы", "подписки", "бюджет", "сколько потрачено"],
    dependencies: ["Yandex Billing", "Redis"],
  }),
  defineSkill({
    id: "navigation",
    title: "Навигация",
    description:
      "Маршруты, дорожная ситуация и оценка времени в пути.",
    status: "legacy",
    costProfile: "no-new-cost",
    triggerHints: ["маршрут", "пробки", "как доехать", "сколько ехать"],
    dependencies: ["Yandex Navigator", "Mapbox traffic"],
  }),
  defineSkill({
    id: "morning-brief",
    title: "Утренний бриф",
    description:
      "Ежедневная бизнес-сводка по погоде, рынку, конкурентам, спросу, законам и расходам.",
    status: "legacy",
    costProfile: "existing-yandex-services",
    triggerHints: ["утренний бриф", "/brief-now"],
    dependencies: ["Yandex Search", "YandexGPT", "Redis", "Yandex Cloud trigger"],
  }),
  defineSkill({
    id: "gmail",
    title: "Gmail",
    description:
      "Будущий навык для поиска, анализа и подготовки действий по электронной почте.",
    status: "planned",
    costProfile: "external-integration",
    triggerHints: ["почта", "gmail", "письма"],
    dependencies: ["Google account connection"],
  }),
  defineSkill({
    id: "google-drive",
    title: "Google Drive",
    description:
      "Будущий навык для поиска и работы с файлами в Google Drive.",
    status: "planned",
    costProfile: "external-integration",
    triggerHints: ["google drive", "диск", "файл в гугл диске"],
    dependencies: ["Google account connection"],
  }),
  defineSkill({
    id: "google-calendar",
    title: "Google Calendar",
    description:
      "Будущий навык для чтения календаря, планирования и работы со встречами.",
    status: "planned",
    costProfile: "external-integration",
    triggerHints: ["календарь", "встреча", "google calendar"],
    dependencies: ["Google account connection"],
  }),
] as const;
