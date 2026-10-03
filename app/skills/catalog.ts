import { documentAnalysisSkill } from "./document-analysis";
import { expenseControlSkill } from "./expense-control";
import { navigationSkill } from "./navigation";
import { morningBriefSkill } from "./morning-brief";
import { productFromPhotoSkill } from "./product-from-photo";
import { researchSkill } from "./research";
import { wardrobeSkill } from "./wardrobe";
import { defineSkill } from "./types";

export const SKILLS = [
  wardrobeSkill,
  researchSkill,
  productFromPhotoSkill,
  documentAnalysisSkill,
  expenseControlSkill,
  navigationSkill,
  morningBriefSkill,
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
