import {
  type ErdgebundenFlags,
  type SkillDef,
  type AderDef,
  getSkillLevel,
  getAderData,
  getBaseData,
  countAhnensteine,
  findSkill,
  resolveSkill,
} from "./data.ts";

export type SkillState = "unlocked" | "available" | "locked" | "excluded";

/**
 * Returns how high a tier a player can reach based on active ader count.
 * 1 ader  → capstone (tier 3)
 * 2 adern → tier 2
 * 3 adern → tier 1
 */
export function getMaxAllowedTier(activeAdern: string[]): number {
  switch (activeAdern.length) {
    case 0: return 0;
    case 1: return 3;
    case 2: return 2;
    case 3: return 1;
    default: return 1;
  }
}

/** Count how many skills of a given tier are unlocked in a specific ader */
function countUnlockedInTier(flags: ErdgebundenFlags, ader: AderDef, tier: number): number {
  let count = 0;
  for (const skill of ader.skills) {
    if (skill.tier === tier) {
      const key = `${ader.id}::${skill.id}`;
      if (getSkillLevel(flags, key) > 0) count++;
    }
  }
  return count;
}

/** Check if a single prerequisite is satisfied */
function checkPrerequisite(
  flags: ErdgebundenFlags,
  ader: AderDef,
  req: SkillDef["requires"][number]
): boolean {
  switch (req.type) {
    case "skill": {
      const key = req.skill!;
      const aderKey = `${ader.id}::${key}`;
      return getSkillLevel(flags, aderKey) > 0 || getSkillLevel(flags, key) > 0;
    }
    case "skillOr": {
      return req.skills!.some((s) => {
        const aderKey = `${ader.id}::${s}`;
        return getSkillLevel(flags, aderKey) > 0 || getSkillLevel(flags, s) > 0;
      });
    }
    case "skillAnd": {
      return req.skills!.every((s) => {
        const aderKey = `${ader.id}::${s}`;
        return getSkillLevel(flags, aderKey) > 0 || getSkillLevel(flags, s) > 0;
      });
    }
    case "tier": {
      return countUnlockedInTier(flags, ader, req.tier!) >= (req.count ?? 1);
    }
    case "skillLevel": {
      const key = req.skill!;
      const aderKey = `${ader.id}::${key}`;
      const lvl = Math.max(getSkillLevel(flags, aderKey), getSkillLevel(flags, key));
      return lvl >= (req.level ?? 1);
    }
    default:
      return false;
  }
}

/** Get the name of a skill by id within an ader */
function skillName(ader: AderDef, id: string): string {
  const s = ader.skills.find((sk) => sk.id === id);
  return s ? `"${s.name}"` : id;
}

/** Describe a prerequisite in human-readable German */
function describePrerequisite(ader: AderDef, req: SkillDef["requires"][number]): string {
  switch (req.type) {
    case "skill":
      return `${skillName(ader, req.skill!)} muss freigeschaltet sein`;
    case "skillOr":
      return `Eines von: ${req.skills!.map((s) => skillName(ader, s)).join(" oder ")}`;
    case "skillAnd":
      return `Alle: ${req.skills!.map((s) => skillName(ader, s)).join(" und ")}`;
    case "tier":
      return `${req.count ?? 1} Skill(s) aus Tier ${req.tier!} benötigt`;
    case "skillLevel":
      return `${skillName(ader, req.skill!)} auf Level ${req.level ?? 1}`;
    default:
      return "Unbekannte Voraussetzung";
  }
}

/** Find which skill causes exclusion and return its name */
function getExclusionReason(flags: ErdgebundenFlags, ader: AderDef, skill: SkillDef): string | null {
  for (const exId of skill.excludes) {
    const aderKey = `${ader.id}::${exId}`;
    if (getSkillLevel(flags, aderKey) > 0) {
      return `Ausgeschlossen durch ${skillName(ader, exId)} (bereits freigeschaltet)`;
    }
  }
  for (const other of ader.skills) {
    if (other.id === skill.id) continue;
    if (other.excludes.includes(skill.id)) {
      const aderKey = `${ader.id}::${other.id}`;
      if (getSkillLevel(flags, aderKey) > 0) {
        return `Ausgeschlossen durch ${skillName(ader, other.id)} (bereits freigeschaltet)`;
      }
    }
  }
  return null;
}

/** Check if any exclusion blocks this skill */
function isExcluded(flags: ErdgebundenFlags, ader: AderDef, skill: SkillDef): boolean {
  return getExclusionReason(flags, ader, skill) !== null;
}

/**
 * List the names of all skills mutually exclusive with this one — regardless of
 * unlock state. Combines this skill's own `excludes` with a reverse lookup over
 * skills that exclude it, so the conflict is visible *before* either is chosen.
 */
export function getExclusionInfo(ader: AderDef, skill: SkillDef): string[] {
  const ids = new Set<string>(skill.excludes);
  for (const other of ader.skills) {
    if (other.id === skill.id) continue;
    if (other.excludes.includes(skill.id)) ids.add(other.id);
  }
  return [...ids].map((id) => skillName(ader, id).replace(/^"|"$/g, ""));
}

/** Get the visual state of a skill */
export function getSkillState(
  flags: ErdgebundenFlags,
  ader: AderDef,
  skill: SkillDef
): SkillState {
  const key = `${ader.id}::${skill.id}`;
  const level = getSkillLevel(flags, key);

  if (level > 0) return "unlocked";

  if (getSkillLevel(flags, "erdgebunden") === 0) return "locked";

  // Tier 0: available if erdgebunden unlocked AND max ader limit not reached
  if (skill.tier === 0) {
    // Check max ader limit: if this ader isn't active yet, it would be a new ader
    if (!flags.activeAdern.includes(ader.id) && flags.activeAdern.length >= 3) {
      return "locked";
    }
    return skill.requires.length === 0 || skill.requires.every((req) => checkPrerequisite(flags, ader, req))
      ? "available"
      : "locked";
  }

  if (isExcluded(flags, ader, skill)) return "excluded";

  const maxTier = getMaxAllowedTier(flags.activeAdern);
  if (skill.tier > maxTier) return "locked";

  const allMet = skill.requires.every((req) => checkPrerequisite(flags, ader, req));
  if (!allMet) return "locked";

  return "available";
}

/** Get state for a base skill (erdmarkiert/erdgebunden) */
export function getBaseSkillState(
  flags: ErdgebundenFlags,
  skill: SkillDef
): SkillState {
  const level = getSkillLevel(flags, skill.id);
  if (level > 0) return "unlocked";

  if (skill.id === "erdmarkiert") {
    return flags.activated ? "available" : "locked";
  }
  if (skill.id === "erdgebunden") {
    return getSkillLevel(flags, "erdmarkiert") > 0 ? "available" : "locked";
  }
  return "locked";
}

/** Get the actual cost to unlock/level up a skill */
export function getSkillCost(skill: SkillDef, currentLevel: number): number {
  if (skill.freeWithAder) return 0;
  return skill.cost;
}

/** Full unlock check with detailed reasons */
export function canUnlockSkill(
  actor: any,
  flags: ErdgebundenFlags,
  ader: AderDef,
  skill: SkillDef
): { allowed: boolean; reason?: string } {
  const key = `${ader.id}::${skill.id}`;
  const currentLevel = getSkillLevel(flags, key);

  if (currentLevel >= skill.maxLevel) {
    return { allowed: false, reason: "Bereits auf Maximum-Level" };
  }

  if (currentLevel === 0) {
    // Erdgebunden check
    if (getSkillLevel(flags, "erdgebunden") === 0) {
      return { allowed: false, reason: "Erdgebunden muss zuerst freigeschaltet werden" };
    }

    // Tier 0: check max ader limit
    if (skill.tier === 0 && !flags.activeAdern.includes(ader.id) && flags.activeAdern.length >= 3) {
      return { allowed: false, reason: `Maximum von 3 Adern erreicht (aktiv: ${flags.activeAdern.join(", ")})` };
    }

    // Exclusion check with specific reason
    const exReason = getExclusionReason(flags, ader, skill);
    if (exReason) {
      return { allowed: false, reason: exReason };
    }

    // Tier restriction
    if (skill.tier > 0) {
      const maxTier = getMaxAllowedTier(flags.activeAdern);
      if (skill.tier > maxTier) {
        const tierNames = { 1: "Tier 1", 2: "Tier 2", 3: "Capstone" };
        return { allowed: false, reason: `${(tierNames as any)[skill.tier] ?? `Tier ${skill.tier}`} nicht erreichbar mit ${flags.activeAdern.length} aktiven Adern (max Tier ${maxTier})` };
      }
    }

    // Detailed prerequisite check
    const unmetReqs: string[] = [];
    for (const req of skill.requires) {
      if (!checkPrerequisite(flags, ader, req)) {
        unmetReqs.push(describePrerequisite(ader, req));
      }
    }
    if (unmetReqs.length > 0) {
      return { allowed: false, reason: `Voraussetzungen:\n• ${unmetReqs.join("\n• ")}` };
    }
  }

  // Check cost
  if (!skill.freeWithAder) {
    const cost = getSkillCost(skill, currentLevel);
    const available = countAhnensteine(actor);
    if (available < cost) {
      return { allowed: false, reason: `Benötigt ${cost} Ahnenstein(e), du hast ${available}` };
    }
  }

  return { allowed: true };
}

/** Check if base skill can be unlocked */
export function canUnlockBaseSkill(
  actor: any,
  flags: ErdgebundenFlags,
  skill: SkillDef
): { allowed: boolean; reason?: string } {
  const currentLevel = getSkillLevel(flags, skill.id);
  if (currentLevel >= skill.maxLevel) {
    return { allowed: false, reason: "Bereits freigeschaltet" };
  }

  const state = getBaseSkillState(flags, skill);
  if (state !== "available") {
    if (skill.id === "erdgebunden") {
      return { allowed: false, reason: "Erdmarkiert muss zuerst freigeschaltet werden" };
    }
    return { allowed: false, reason: "Voraussetzungen nicht erfüllt" };
  }

  if (skill.cost > 0) {
    const available = countAhnensteine(actor);
    if (available < skill.cost) {
      return { allowed: false, reason: `Benötigt ${skill.cost} Ahnenstein(e), du hast ${available}` };
    }
  }

  return { allowed: true };
}

/** Can the player activate a new ader? */
export function canActivateAder(
  flags: ErdgebundenFlags,
  aderId: string
): { allowed: boolean; reason?: string } {
  if (!flags.activated) {
    return { allowed: false, reason: "Nicht vom GM freigeschaltet" };
  }
  if (getSkillLevel(flags, "erdgebunden") === 0) {
    return { allowed: false, reason: "Erdgebunden muss zuerst freigeschaltet werden" };
  }
  if (flags.activeAdern.includes(aderId)) {
    return { allowed: false, reason: "Diese Ader ist bereits aktiv" };
  }
  if (flags.activeAdern.length >= 3) {
    return { allowed: false, reason: "Maximum von 3 Adern erreicht" };
  }
  return { allowed: true };
}

/** Get list of all unlocked skills for summary view */
export function getUnlockedSkillsList(flags: ErdgebundenFlags): {
  key: string;
  aderId: string | null;
  skill: SkillDef;
  level: number;
}[] {
  const result: { key: string; aderId: string | null; skill: SkillDef; level: number }[] = [];

  const base = getBaseData();
  for (const skill of base.skills) {
    const level = getSkillLevel(flags, skill.id);
    if (level > 0) {
      result.push({ key: skill.id, aderId: null, skill, level });
    }
  }

  for (const aderId of flags.activeAdern) {
    const ader = getAderData(aderId);
    if (!ader) continue;
    for (const skill of ader.skills) {
      const key = `${aderId}::${skill.id}`;
      const level = getSkillLevel(flags, key);
      if (level > 0) {
        result.push({ key, aderId, skill, level });
      }
    }
  }

  return result;
}

/** Count total invested Ahnensteine (from skill flags) */
export function countInvestedAhnensteine(flags: ErdgebundenFlags): number {
  let total = 0;
  for (const [key, level] of Object.entries(flags.skills)) {
    if (level <= 0) continue;
    const skill = resolveSkill(key);
    if (!skill || skill.freeWithAder) continue;
    total += skill.cost * level;
  }
  return total;
}
