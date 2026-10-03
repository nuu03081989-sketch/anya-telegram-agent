export type SkillId =
  | "wardrobe"
  | "research"
  | "document-analysis"
  | "expense-control"
  | "navigation"
  | "morning-brief"
  | "gmail"
  | "google-drive"
  | "google-calendar";

export type SkillStatus =
  | "legacy"
  | "planned"
  | "native";

export type SkillCostProfile =
  | "no-new-cost"
  | "existing-yandex-services"
  | "external-integration";

export type SkillContext = {
  chatId: number;
  text: string;
  replyText?: string;
};

export type SkillMatch = {
  matched: boolean;
  confidence?: number;
  reason?: string;
};

export type SkillResult = {
  handled: boolean;
  text?: string;
};

export type SkillHandler = {
  match: (context: SkillContext) => SkillMatch | Promise<SkillMatch>;
  run: (context: SkillContext) => SkillResult | Promise<SkillResult>;
};

export type SkillDefinition = {
  id: SkillId;
  title: string;
  description: string;
  status: SkillStatus;
  costProfile: SkillCostProfile;
  triggerHints: readonly string[];
  dependencies: readonly string[];
  handler?: SkillHandler;
};

export function defineSkill<const T extends SkillDefinition>(skill: T) {
  return skill;
}
