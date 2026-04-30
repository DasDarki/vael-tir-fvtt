import { MODULE_ID, socket } from "./consts.ts";
import {
  type ErdgebundenFlags,
  type AderDef,
  type SkillDef,
  getFlags,
  setFlags,
  getSkillLevel,
  getBaseData,
  getAderData,
  getAllAdern,
  countAhnensteine,
  consumeAhnensteine,
} from "./data.ts";
import {
  type SkillState,
  getSkillState,
  getBaseSkillState,
  getSkillCost,
  canUnlockSkill,
  canUnlockBaseSkill,
  getMaxAllowedTier,
  getUnlockedSkillsList,
  countInvestedAhnensteine,
} from "./skill-engine.ts";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Build the URL for a skill icon image */
function skillIconUrl(skill: SkillDef, aderId?: string | null): string {
  const base = `modules/${MODULE_ID}/assets/img`;
  if (!aderId) {
    // Base skills: 0_Erdmarkiert.webp / 1_Erdgebunden.webp
    if (skill.id === "erdmarkiert") return `${base}/0_Erdmarkiert.webp`;
    if (skill.id === "erdgebunden") return `${base}/1_Erdgebunden.webp`;
    return `${base}/placeholder.webp`;
  }
  // Ader skills: use the folder from the ader data
  const ader = getAderData(aderId);
  if (!ader) return `${base}/placeholder.webp`;
  const iconFile = skill.id === "cap" ? "CAPSTONE.webp" : `${skill.id}.webp`;
  return `${base}/${ader.folder}/${iconFile}`;
}

/** Build the URL for an ader background image */
function aderBgUrl(aderId: string): string {
  const ader = getAderData(aderId);
  if (!ader) return "";
  return `modules/${MODULE_ID}/assets/img/${ader.folder}/_BG.webp`;
}

type ViewMode = "main" | "ader" | "summary";

export class ErdgebundenApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "erdgebunden-skill-tree",
    classes: ["erdgebunden", "themed", "theme-dark"],
    tag: "div",
    window: {
      title: "Erdgebunden – Skill Tree",
      resizable: false,
    },
    position: {
      width: 900,
      height: 700,
    },
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/main-view.hbs` },
  };

  private _view: ViewMode = "main";
  private _currentAderId: string | null = null;
  private _tooltipSkill: { skill: SkillDef; aderId: string | null; key: string } | null = null;

  private static readonly TEMPLATES: Record<ViewMode, string> = {
    main: `modules/${MODULE_ID}/templates/main-view.hbs`,
    ader: `modules/${MODULE_ID}/templates/ader-view.hbs`,
    summary: `modules/${MODULE_ID}/templates/summary-view.hbs`,
  };

  constructor(private readonly actor: any) {
    super();
  }

  // Switch template based on current view
  _configureRenderParts(options: any) {
    const parts = super._configureRenderParts(options) as any;
    if (parts.content) {
      parts.content.template = ErdgebundenApp.TEMPLATES[this._view];
    }
    return parts;
  }

  async _prepareContext() {
    const flags = getFlags(this.actor);
    const isGM = !!game.user?.isGM;
    const ahnensteine = countAhnensteine(this.actor);
    const invested = countInvestedAhnensteine(flags);

    if (this._view === "main") {
      return this._prepareMainContext(flags, isGM, ahnensteine, invested);
    }
    if (this._view === "ader") {
      return this._prepareAderContext(flags, isGM, ahnensteine, invested);
    }
    if (this._view === "summary") {
      return this._prepareSummaryContext(flags, isGM, ahnensteine, invested);
    }
    return {};
  }

  private _prepareMainContext(
    flags: ErdgebundenFlags,
    isGM: boolean,
    ahnensteine: number,
    invested: number
  ) {
    const base = getBaseData();
    const adern = getAllAdern();

    const baseSkills = base.skills.map((s) => ({
      ...s,
      state: getBaseSkillState(flags, s),
      level: getSkillLevel(flags, s.id),
      key: s.id,
      iconUrl: skillIconUrl(s),
    }));

    console.log(`[Erdgebunden] Main view - flags.skills:`, JSON.stringify(flags.skills));
    console.log(`[Erdgebunden] Main view - activeAdern:`, flags.activeAdern);

    const aderNodes = adern.map((a) => {
      const isActive = flags.activeAdern.includes(a.id);
      const unlockedCount = a.skills.filter(
        (s) => getSkillLevel(flags, `${a.id}::${s.id}`) > 0
      ).length;
      console.log(`[Erdgebunden] Ader "${a.id}": isActive=${isActive}, unlocked=${unlockedCount}/${a.skills.length}`);

      return {
        id: a.id,
        name: a.name,
        fullName: a.fullName,
        subtitle: a.subtitle,
        isActive,
        unlockedCount,
        totalCount: a.skills.length,
        bgUrl: aderBgUrl(a.id),
      };
    });

    return {
      view: "main",
      isGM,
      actorName: this.actor.name,
      activated: flags.activated,
      ahnensteine,
      invested,
      baseSkills,
      aderNodes,
      hasErdgebunden: getSkillLevel(flags, "erdgebunden") > 0,
    } as any;
  }

  private _prepareAderContext(
    flags: ErdgebundenFlags,
    isGM: boolean,
    ahnensteine: number,
    invested: number
  ) {
    const ader = this._currentAderId ? getAderData(this._currentAderId) : null;
    if (!ader) return { view: "ader", error: true } as any;

    const maxTier = getMaxAllowedTier(flags.activeAdern);
    const isActive = flags.activeAdern.includes(ader.id);

    console.log(`[Erdgebunden] Preparing ader context for "${ader.id}", isActive=${isActive}, maxTier=${maxTier}`);
    console.log(`[Erdgebunden] Current flags.skills:`, JSON.stringify(flags.skills));

    const skills = ader.skills.map((s) => {
      const key = `${ader.id}::${s.id}`;
      const level = getSkillLevel(flags, key);
      const state = getSkillState(flags, ader, s);
      const check = canUnlockSkill(this.actor, flags, ader, s);

      console.log(`[Erdgebunden] Skill "${s.name}" (${key}): level=${level}, state=${state}, canUnlock=${check.allowed}, reason=${check.reason ?? "none"}`);

      return {
        ...s,
        key,
        level,
        state,
        canUnlock: check.allowed,
        unlockReason: check.reason,
        isMaxLevel: level >= s.maxLevel,
        costDisplay: `${getSkillCost(s, level)} Ahnenstein(e)`,
        iconUrl: skillIconUrl(s, ader.id),
        gridStyle: `grid-column: ${s.gridPos.col + 2}; grid-row: ${s.gridPos.row + 1};`,
      };
    });

    // Build tier labels from actual skill positions
    const tierRowMap = new Map<number, number[]>();
    for (const s of ader.skills) {
      const rows = tierRowMap.get(s.tier) ?? [];
      rows.push(s.gridPos.row);
      tierRowMap.set(s.tier, rows);
    }
    const tierLabels: { label: string; gridRow: number }[] = [];
    for (const [tier, rows] of tierRowMap) {
      const minRow = Math.min(...rows);
      const maxRow = Math.max(...rows);
      const midRow = Math.round((minRow + maxRow) / 2);
      const label = tier === 3 ? "Capstone" : tier === 0 ? "Tier 0" : `Tier ${tier}`;
      tierLabels.push({ label, gridRow: midRow + 1 });
    }
    tierLabels.sort((a, b) => a.gridRow - b.gridRow);

    return {
      view: "ader",
      isGM,
      ader,
      isActive,
      skills,
      maxTier,
      ahnensteine,
      invested,
      gridCols: ader.gridCols,
      gridRows: ader.gridRows,
      bgUrl: aderBgUrl(ader.id),
      tierLabels,
    } as any;
  }

  private _prepareSummaryContext(
    flags: ErdgebundenFlags,
    isGM: boolean,
    ahnensteine: number,
    invested: number
  ) {
    const unlocked = getUnlockedSkillsList(flags);

    // Group by ader
    const grouped: Record<string, typeof unlocked> = { base: [] };
    for (const entry of unlocked) {
      const group = entry.aderId ?? "base";
      if (!grouped[group]) grouped[group] = [];
      grouped[group]!.push(entry);
    }

    const sections = Object.entries(grouped).map(([key, skills]) => {
      let label = "Basis";
      if (key !== "base") {
        const ader = getAderData(key);
        label = ader?.fullName ?? key;
      }
      return { key, label, skills };
    });

    return {
      view: "summary",
      isGM,
      ahnensteine,
      invested,
      sections,
      totalUnlocked: unlocked.length,
    } as any;
  }

  protected _attachPartListeners(partId: string, html: HTMLElement): void {
    super._attachPartListeners(partId, html, {});

    // Navigation buttons
    html.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
      el.addEventListener("click", (ev) => this._onAction(ev));
    });

    // Skill node clicks (show tooltip)
    html.querySelectorAll<HTMLElement>("[data-skill-key]").forEach((el) => {
      el.addEventListener("click", (ev) => this._onSkillClick(ev));
    });

  }

  private async _onAction(event: Event) {
    const target = event.currentTarget as HTMLElement;
    const action = target.dataset.action;

    switch (action) {
      case "nav-main":
        this._view = "main";
        this._currentAderId = null;
        await this.render({ force: true });
        break;

      case "nav-summary":
        // Toggle: if already on summary, go back to main
        if (this._view === "summary") {
          this._view = "main";
          this._currentAderId = null;
        } else {
          this._view = "summary";
        }
        await this.render({ force: true });
        break;

      case "open-ader": {
        const aderId = target.dataset.aderId;
        if (!aderId) return;
        this._view = "ader";
        this._currentAderId = aderId;
        await this.render({ force: true });
        break;
      }

      case "activate-actor": {
        if (!game.user?.isGM) return;
        await this._toggleActivation();
        break;
      }

      case "unlock-base-skill": {
        const skillId = target.dataset.skillId;
        if (!skillId) return;
        await this._unlockBaseSkill(skillId);
        break;
      }

      case "unlock-skill": {
        const skillKey = target.dataset.skillKey;
        if (!skillKey) return;
        await this._unlockAderSkill(skillKey);
        break;
      }

      case "close-tooltip":
        this._closeTooltip();
        break;
    }
  }

  private _onSkillClick(event: Event) {
    const target = event.currentTarget as HTMLElement;
    const key = target.dataset.skillKey;
    if (!key) return;

    // Find the skill data
    const html = target.closest(".erdgebunden") as HTMLElement;
    if (!html) return;

    // Show tooltip overlay
    this._showTooltip(key, target, html);
  }

  private _showTooltip(key: string, anchor: HTMLElement, container: HTMLElement) {
    // Remove existing tooltip
    this._closeTooltip(container);

    let skill: SkillDef | undefined;
    let aderId: string | null = null;
    let state: SkillState = "locked";
    let level = 0;
    let canDo: { allowed: boolean; reason?: string } = { allowed: false, reason: "" };

    const flags = getFlags(this.actor);

    if (key.includes("::")) {
      const [aId, sId] = key.split("::", 2);
      aderId = aId!;
      const ader = getAderData(aderId);
      if (!ader) return;
      skill = ader.skills.find((s) => s.id === sId);
      if (!skill) return;
      state = getSkillState(flags, ader, skill);
      level = getSkillLevel(flags, key);
      canDo = canUnlockSkill(this.actor, flags, ader, skill);
    } else {
      const base = getBaseData();
      skill = base.skills.find((s) => s.id === key);
      if (!skill) return;
      state = getBaseSkillState(flags, skill);
      level = getSkillLevel(flags, key);
      canDo = canUnlockBaseSkill(this.actor, flags, skill);
    }

    const tooltip = document.createElement("div");
    tooltip.classList.add("skill-tooltip-overlay");

    const costText = skill.cost > 0 ? `${getSkillCost(skill, level)} Ahnenstein(e)` : "Frei";
    const isMaxLevel = level >= skill.maxLevel;
    const showUnlock = canDo.allowed && !isMaxLevel;
    const actionLabel = level > 0 ? "Level Up" : "Freischalten";
    const unlockAction = aderId ? "unlock-skill" : "unlock-base-skill";
    const unlockData = aderId ? `data-skill-key="${key}"` : `data-skill-id="${key}"`;

    const levelEffectsHtml = skill.levelEffects?.length
      ? `<div class="tooltip-level-effects">
           <h4>Level-Effekte</h4>
           <ul>${skill.levelEffects.map((e) => `<li>${e}</li>`).join("")}</ul>
         </div>`
      : "";

    tooltip.innerHTML = `
      <div class="skill-tooltip">
        <div class="tooltip-header">
          <h3>${skill.name}</h3>
          <span class="tooltip-tier">Tier ${skill.tier < 0 ? "Basis" : skill.tier === 3 ? "Capstone" : skill.tier}</span>
          <button type="button" class="tooltip-close" data-action="close-tooltip">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <p class="tooltip-flavor"><em>${skill.flavor}</em></p>
        <div class="tooltip-state state-${state}">
          ${state === "unlocked" ? `Level ${level}/${skill.maxLevel}` : state === "available" ? "Verfügbar" : state === "excluded" ? "Ausgeschlossen" : "Gesperrt"}
        </div>
        <div class="tooltip-effects">
          <h4>Effekte</h4>
          <ul>${skill.effects.map((e) => `<li>${e}</li>`).join("")}</ul>
        </div>
        ${levelEffectsHtml}
        <div class="tooltip-cost">Kosten: ${costText}</div>
        ${!canDo.allowed && canDo.reason ? `<div class="tooltip-reason">${canDo.reason.replace(/\n/g, "<br>")}</div>` : ""}
        ${showUnlock ? `<button type="button" class="tooltip-unlock-btn" data-action="${unlockAction}" ${unlockData}>${actionLabel}</button>` : ""}
      </div>
    `;

    tooltip.querySelector(".tooltip-close")?.addEventListener("click", () => this._closeTooltip(container));
    tooltip.querySelector(".tooltip-unlock-btn")?.addEventListener("click", (ev) => this._onAction(ev));

    // Clicking backdrop closes
    tooltip.addEventListener("click", (ev) => {
      if (ev.target === tooltip) this._closeTooltip(container);
    });

    container.appendChild(tooltip);
  }

  private _closeTooltip(container?: HTMLElement) {
    const el = container ?? this.element;
    el?.querySelector(".skill-tooltip-overlay")?.remove();
  }

  // ── Actions ──

  private async _toggleActivation() {
    const flags = getFlags(this.actor);
    flags.activated = !flags.activated;

    // When activating, auto-unlock erdmarkiert
    if (flags.activated && !flags.skills["erdmarkiert"]) {
      flags.skills["erdmarkiert"] = 1;
    }

    await setFlags(this.actor, flags);
    ui.notifications?.info(flags.activated ? "Erdgebunden aktiviert" : "Erdgebunden deaktiviert");
    await this.render({ force: true });
  }

  private async _unlockBaseSkill(skillId: string) {
    const flags = getFlags(this.actor);
    const base = getBaseData();
    const skill = base.skills.find((s) => s.id === skillId);
    if (!skill) return;

    const check = canUnlockBaseSkill(this.actor, flags, skill);
    if (!check.allowed) {
      ui.notifications?.warn(check.reason ?? "Kann nicht freigeschaltet werden");
      return;
    }

    // Consume Ahnensteine if skill has a cost
    if (skill.cost > 0) {
      const ok = await consumeAhnensteine(this.actor, skill.cost);
      if (!ok) {
        ui.notifications?.error("Nicht genug Ahnensteine!");
        return;
      }
    }

    // Re-load flags after item deletion (actor state changed)
    const finalFlags = getFlags(this.actor);
    console.log(`[Erdgebunden] Unlocking base skill "${skillId}": current level=${finalFlags.skills[skillId] ?? 0}`);
    finalFlags.skills[skillId] = (finalFlags.skills[skillId] ?? 0) + 1;
    console.log(`[Erdgebunden] Setting base skill "${skillId}" to level=${finalFlags.skills[skillId]}`);
    await setFlags(this.actor, finalFlags);
    console.log(`[Erdgebunden] Flags saved. Verifying:`, getFlags(this.actor).skills);
    this._closeTooltip();
    await this.render({ force: true });
  }

  private async _unlockAderSkill(key: string) {
    const [aderId, skillId] = key.split("::", 2);
    if (!aderId || !skillId) return;

    const ader = getAderData(aderId);
    if (!ader) return;

    const skill = ader.skills.find((s) => s.id === skillId);
    if (!skill) return;

    const flags = getFlags(this.actor);
    const check = canUnlockSkill(this.actor, flags, ader, skill);
    if (!check.allowed) {
      ui.notifications?.warn(check.reason ?? "Kann nicht freigeschaltet werden");
      return;
    }

    // Confirmation dialog
    const cost = getSkillCost(skill, getSkillLevel(flags, key));
    const currentLevel = getSkillLevel(flags, key);
    const actionText = currentLevel > 0 ? `${skill.name} auf Level ${currentLevel + 1} bringen` : `${skill.name} freischalten`;
    const costText = cost > 0 ? `\nDies kostet ${cost} Ahnenstein(e).` : "";

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Skill freischalten?" },
      content: `<p>${actionText}?${costText}</p>`,
      yes: { label: "Ja" },
      no: { label: "Nein" },
    });

    if (!confirmed) return;

    // Re-check after dialog (state may have changed)
    const freshFlags = getFlags(this.actor);
    const recheck = canUnlockSkill(this.actor, freshFlags, ader, skill);
    if (!recheck.allowed) {
      ui.notifications?.warn(recheck.reason ?? "Kann nicht mehr freigeschaltet werden");
      return;
    }

    // Remove Ahnensteine items
    if (cost > 0) {
      const ok = await consumeAhnensteine(this.actor, cost);
      if (!ok) {
        ui.notifications?.error("Nicht genug Ahnensteine!");
        return;
      }
    }

    // Re-load flags after item deletion (actor state changed)
    const finalFlags = getFlags(this.actor);
    console.log(`[Erdgebunden] Unlocking ader skill "${key}": current level=${finalFlags.skills[key] ?? 0}`);
    finalFlags.skills[key] = (finalFlags.skills[key] ?? 0) + 1;

    // Auto-activate ader if not yet active
    if (!finalFlags.activeAdern.includes(aderId)) {
      finalFlags.activeAdern.push(aderId);
      console.log(`[Erdgebunden] Auto-activated ader "${aderId}"`);
    }

    console.log(`[Erdgebunden] Setting ader skill "${key}" to level=${finalFlags.skills[key]}`);
    await setFlags(this.actor, finalFlags);
    console.log(`[Erdgebunden] Flags saved. Verifying:`, getFlags(this.actor).skills);
    this._closeTooltip();
    await this.render({ force: true });
  }

}
