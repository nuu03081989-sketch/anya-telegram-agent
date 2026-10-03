import { SKILLS } from "./catalog";
import type { SkillDefinition, SkillId, SkillStatus } from "./types";

const registry = new Map<SkillId, SkillDefinition>(
  SKILLS.map((skill) => [skill.id, skill])
);

export function getSkill(id: SkillId) {
  return registry.get(id);
}

export function listSkills() {
  return [...registry.values()];
}

export function listSkillsByStatus(status: SkillStatus) {
  return listSkills().filter((skill) => skill.status === status);
}

export function hasNativeHandler(id: SkillId) {
  return Boolean(registry.get(id)?.handler);
}
