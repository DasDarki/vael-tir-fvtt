import { MODULE_ID, FLAG_KEY } from "./consts.ts";

// ── JSON Data Types ──

export interface SkillPrerequisite {
  type: "skill" | "skillOr" | "skillAnd" | "tier" | "skillLevel";
  skill?: string;
  skills?: string[];
  tier?: number;
  count?: number;
  level?: number;
}

export interface GridPos {
  col: number;
  row: number;
}

export interface SkillDef {
  id: string;
  name: string;
  tier: number;
  icon: string;
  flavor: string;
  effects: string[];
  levelEffects?: string[];
  cost: number;
  maxLevel: number;
  requires: SkillPrerequisite[];
  excludes: string[];
  freeWithAder: boolean;
  gridPos: GridPos;
}

export interface AderDef {
  id: string;
  name: string;
  fullName: string;
  subtitle: string;
  folder: string;
  gridCols: number;
  gridRows: number;
  connections: [string, string][];
  skills: SkillDef[];
}

export interface BaseDef {
  skills: SkillDef[];
}

// ── Actor Flag Types ──

export interface ErdgebundenFlags {
  activated: boolean;
  activeAdern: string[];
  skills: Record<string, number>;
}

const DEFAULT_FLAGS: ErdgebundenFlags = {
  activated: false,
  activeAdern: [],
  skills: {},
};

// ── Flag Management ──

export function getFlags(actor: any): ErdgebundenFlags {
  const raw = actor.getFlag(MODULE_ID, FLAG_KEY);
  console.log(`[Erdgebunden] getFlags raw:`, JSON.stringify(raw));
  if (!raw) return { ...DEFAULT_FLAGS, activeAdern: [], skills: {} };

  // Migrate old dot-separated keys: FoundryVTT stored "stein.0-A" as { stein: { "0-A": 1 } }
  const skills: Record<string, number> = {};
  if (raw.skills) {
    for (const [key, value] of Object.entries(raw.skills)) {
      if (typeof value === "number") {
        skills[key] = value;
      } else if (typeof value === "object" && value !== null) {
        // Nested object from dot-key expansion: flatten back
        for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
          if (typeof subVal === "number") {
            const flatKey = `${key}::${subKey}`;
            // Only add if not already present with the new :: format
            if (!skills[flatKey]) skills[flatKey] = subVal;
          }
        }
      }
    }
  }

  // Derive activeAdern from skills: any ader with at least 1 unlocked skill is active
  const activeAdern: string[] = Array.isArray(raw.activeAdern) ? [...raw.activeAdern] : [];
  for (const key of Object.keys(skills)) {
    if (key.includes("::")) {
      const aderId = key.split("::", 1)[0]!;
      if (skills[key]! > 0 && !activeAdern.includes(aderId)) {
        activeAdern.push(aderId);
        console.log(`[Erdgebunden] Migration: auto-activated ader "${aderId}" from skill "${key}"`);
      }
    }
  }

  // Derive activated from erdmarkiert
  const activated = (raw.activated ?? false) || (skills["erdmarkiert"] ?? 0) > 0;

  return { activated, activeAdern, skills };
}

export async function setFlags(actor: any, flags: ErdgebundenFlags): Promise<void> {
  console.log(`[Erdgebunden] setFlags:`, JSON.stringify(flags));
  // Wipe the whole flag and re-set to avoid FoundryVTT mergeObject issues with old nested keys
  await actor.unsetFlag(MODULE_ID, FLAG_KEY);
  await actor.setFlag(MODULE_ID, FLAG_KEY, flags);
}

export function getSkillLevel(flags: ErdgebundenFlags, skillId: string): number {
  return flags.skills[skillId] ?? 0;
}

// ── Ahnenstein Counting ──

export function countAhnensteine(actor: any): number {
  if (!actor.items) return 0;
  let count = 0;
  for (const item of actor.items) {
    if (item.name === "Ahnenstein") count++;
  }
  return count;
}

export function getAhnensteinIds(actor: any, count: number): string[] {
  const ids: string[] = [];
  for (const item of actor.items) {
    if (item.name === "Ahnenstein") {
      ids.push(item.id);
      if (ids.length >= count) break;
    }
  }
  return ids;
}

// ── JSON Data Cache & Loading ──

let baseData: BaseDef | null = null;
const aderCache = new Map<string, AderDef>();

const ADER_IDS = ["stein", "tiefe", "wurzel", "asche", "schleier", "wandel"] as const;
export type AderId = (typeof ADER_IDS)[number];
export const ALL_ADER_IDS: readonly string[] = ADER_IDS;

export async function loadAllData(): Promise<void> {
  const basePath = `modules/${MODULE_ID}/assets/data`;

  const baseResp = await fetch(`${basePath}/base.json`);
  baseData = (await baseResp.json()) as BaseDef;

  await Promise.all(
    ADER_IDS.map(async (id) => {
      const resp = await fetch(`${basePath}/${id}.json`);
      const data = (await resp.json()) as AderDef;
      aderCache.set(id, data);
    })
  );
}

export function getBaseData(): BaseDef {
  if (!baseData) throw new Error("Erdgebunden: base data not loaded");
  return baseData;
}

export function getAderData(id: string): AderDef | undefined {
  return aderCache.get(id);
}

export function getAllAdern(): AderDef[] {
  return ADER_IDS.map((id) => aderCache.get(id)!).filter(Boolean);
}

export function findSkill(aderId: string, skillId: string): SkillDef | undefined {
  const ader = aderCache.get(aderId);
  if (!ader) return undefined;
  return ader.skills.find((s) => s.id === skillId);
}

export function findBaseSkill(skillId: string): SkillDef | undefined {
  return baseData?.skills.find((s) => s.id === skillId);
}

/** Resolves a full skill key like "stein.1-3" into the SkillDef */
export function resolveSkill(fullKey: string): SkillDef | undefined {
  if (!fullKey.includes("::")) {
    return findBaseSkill(fullKey);
  }
  const [aderId, skillId] = fullKey.split("::", 2);
  return findSkill(aderId!, skillId!);
}
