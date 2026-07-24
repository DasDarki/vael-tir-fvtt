import { MODULE_ID } from "./consts.ts";
import {
  type ErdgebundenFlags,
  type SkillMechanic,
  getFlags,
} from "./data.ts";
import { getUnlockedSkillsList } from "./skill-engine.ts";

// ── Active-Effect Change Modelling ──

/** Foundry CONST.ACTIVE_EFFECT_MODES, mirrored so we don't depend on globals here. */
const AE_MODES = {
  custom: 0,
  multiply: 1,
  add: 2,
  downgrade: 3,
  upgrade: 4,
  override: 5,
} as const;

type ModeName = keyof typeof AE_MODES;

interface AEChange {
  key: string;
  mode: number;
  value: string;
}

/**
 * Central DSL → dnd5e data-path mapping. These paths (damage/condition trait
 * sets, movement, senses) are stable across dnd5e v3–v5. If a path ever moves,
 * this is the single place to change it.
 */
const TRAIT_KEY: Record<string, string> = {
  resistance: "system.traits.dr.value",
  immunity: "system.traits.di.value",
  vulnerability: "system.traits.dv.value",
  conditionImmunity: "system.traits.ci.value",
};

/** Sensible default apply-mode per mechanic type when the JSON omits `mode`. */
function defaultMode(type: SkillMechanic["type"]): ModeName {
  return type === "sense" ? "upgrade" : "add";
}

/** Resolve the effective value for the skill's current level (perLevel overrides value). */
function effectiveValue(m: SkillMechanic, level: number): string | number | undefined {
  if (m.perLevel && m.perLevel.length > 0) {
    const idx = Math.min(Math.max(level - 1, 0), m.perLevel.length - 1);
    return m.perLevel[idx];
  }
  return m.value;
}

/** Resolve the dnd5e Active-Effect change key for a mechanic. */
function changeKey(m: SkillMechanic): string | null {
  switch (m.type) {
    case "resistance":
    case "immunity":
    case "vulnerability":
    case "conditionImmunity":
      return TRAIT_KEY[m.type] ?? null;
    case "speed":
      return `system.attributes.movement.${m.movement ?? "walk"}`;
    case "sense":
      return `system.attributes.senses.${m.sense ?? "darkvision"}`;
    case "raw":
      return m.key ?? null;
    default:
      return null;
  }
}

/** Compile a single mechanic (at a given level) into an Active-Effect change. */
function mapMechanicToChange(m: SkillMechanic, level: number): AEChange | null {
  const key = changeKey(m);
  if (!key) return null;
  const val = effectiveValue(m, level);
  if (val === undefined || val === null || val === "") return null;
  const modeName = m.mode ?? defaultMode(m.type);
  return { key, mode: AE_MODES[modeName], value: String(val) };
}

// ── Computation ──

export interface ToggleSpec {
  /** Unique per skill + condition, used to reconcile toggle effects. */
  sourceKey: string;
  /** Human-readable effect name, e.g. "Standhaft: ≤10 ft bewegt". */
  label: string;
  changes: AEChange[];
}

export interface ComputedMechanics {
  passiveChanges: AEChange[];
  toggles: ToggleSpec[];
}

/**
 * Compute the full set of sheet mechanics from the current skill state.
 * This is idempotent and derived purely from flags — the "computed" model:
 * multi-level skills yield the total value for their current level (replace,
 * not stack), and immunities supersede same-type resistances.
 */
export function computeMechanics(flags: ErdgebundenFlags): ComputedMechanics {
  const unlocked = getUnlockedSkillsList(flags);
  const passiveChanges: AEChange[] = [];
  const toggleMap = new Map<string, ToggleSpec>();

  for (const { key, skill, level } of unlocked) {
    if (!skill.mechanics?.length) continue;
    for (const m of skill.mechanics) {
      const change = mapMechanicToChange(m, level);
      if (!change) continue;

      if (m.condition) {
        // All mechanics of one skill sharing a condition collapse into one toggle.
        const tKey = `${key}::${m.condition}`;
        let spec = toggleMap.get(tKey);
        if (!spec) {
          spec = { sourceKey: tKey, label: `${skill.name}: ${m.condition}`, changes: [] };
          toggleMap.set(tKey, spec);
        }
        spec.changes.push(change);
      } else {
        passiveChanges.push(change);
      }
    }
  }

  // Immunity supersedes resistance for the same damage type.
  const immuneTypes = new Set(
    passiveChanges.filter((c) => c.key === TRAIT_KEY.immunity).map((c) => c.value)
  );
  const filteredPassive = passiveChanges.filter(
    (c) => !(c.key === TRAIT_KEY.resistance && immuneTypes.has(c.value))
  );

  return { passiveChanges: filteredPassive, toggles: [...toggleMap.values()] };
}

// ── Active-Effect Reconciliation ──

const PASSIVE_NAME = "Erdgebunden – Passive Effekte";
const EFFECT_IMG = `modules/${MODULE_ID}/assets/img/1_Erdgebunden.webp`;

/** Order-independent comparison of two change lists. */
function changesDiffer(a: readonly any[] | undefined, b: readonly AEChange[]): boolean {
  const norm = (arr: readonly any[]) =>
    arr.map((c) => `${c.key}|${c.mode}|${c.value}`).sort().join(";");
  return norm(a ?? []) !== norm(b);
}

function isManaged(e: any, kind?: string): boolean {
  if (!e?.getFlag(MODULE_ID, "managed")) return false;
  return kind ? e.getFlag(MODULE_ID, "kind") === kind : true;
}

/**
 * Reconcile the actor's managed Active Effects with the computed mechanics.
 * - One "passive" effect (enabled) holds all always-on changes, regenerated fully.
 * - One "toggle" effect (disabled by default) per conditional; the player's
 *   enabled/disabled choice is preserved across recomputes.
 * Only runs for actors the current user owns (AE writes require ownership).
 */
export async function syncActorMechanics(actor: any): Promise<void> {
  if (!actor?.isOwner) return;

  const flags = getFlags(actor);
  const { passiveChanges, toggles } = computeMechanics(flags);

  const managed = actor.effects.filter((e: any) => isManaged(e));
  const passiveEffect = managed.find((e: any) => isManaged(e, "passive"));
  const toggleEffects = new Map<string, any>();
  for (const e of managed) {
    if (!isManaged(e, "toggle")) continue;
    const sk = e.getFlag(MODULE_ID, "sourceKey");
    if (sk) toggleEffects.set(sk, e);
  }

  const toCreate: any[] = [];
  const toUpdate: any[] = [];
  const toDelete: string[] = [];

  // ── Passive effect ──
  if (passiveChanges.length === 0) {
    if (passiveEffect) toDelete.push(passiveEffect.id);
  } else if (passiveEffect) {
    if (changesDiffer(passiveEffect.changes, passiveChanges)) {
      toUpdate.push({ _id: passiveEffect.id, changes: passiveChanges });
    }
  } else {
    toCreate.push({
      name: PASSIVE_NAME,
      img: EFFECT_IMG,
      disabled: false,
      transfer: false,
      changes: passiveChanges,
      flags: { [MODULE_ID]: { managed: true, kind: "passive" } },
    });
  }

  // ── Toggle effects ──
  const desiredKeys = new Set(toggles.map((t) => t.sourceKey));
  for (const t of toggles) {
    const existing = toggleEffects.get(t.sourceKey);
    if (existing) {
      // Preserve the player's disabled/enabled choice; only refresh changes/name.
      if (existing.name !== t.label || changesDiffer(existing.changes, t.changes)) {
        toUpdate.push({ _id: existing.id, name: t.label, changes: t.changes });
      }
    } else {
      toCreate.push({
        name: t.label,
        img: EFFECT_IMG,
        disabled: true,
        transfer: false,
        changes: t.changes,
        flags: { [MODULE_ID]: { managed: true, kind: "toggle", sourceKey: t.sourceKey } },
      });
    }
  }
  for (const [sk, e] of toggleEffects) {
    if (!desiredKeys.has(sk)) toDelete.push(e.id);
  }

  // ── Apply (delete → update → create) ──
  if (toDelete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete);
  if (toUpdate.length) await actor.updateEmbeddedDocuments("ActiveEffect", toUpdate);
  if (toCreate.length) await actor.createEmbeddedDocuments("ActiveEffect", toCreate);
}
