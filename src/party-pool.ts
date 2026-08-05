import { MODULE_ID, POOL_SOCKET, socket } from "./consts.ts";
import {
  type PoolResult,
  getPoolState,
  partsToCp,
  formatMoney,
  gmAddMoney,
  distribute,
  withdrawMoney,
  withdrawItem,
} from "./pool-data.ts";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

type PoolTab = "money" | "items" | "transfer" | "log";

const APP_ID = "vael-tir-party-pool";

function isGM(): boolean {
  return !!(game as any).user?.isGM;
}

function userName(): string {
  return isGM() ? "GM" : (game as any).user?.name ?? "?";
}

/** Read an item's display quantity from serialized dnd5e item data. */
function itemQuantity(data: any): number {
  const q = data?.system?.quantity;
  if (q && typeof q === "object") return Number(q.value) || 1;
  return Number(q) || 1;
}

export class PartyPoolApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    classes: ["erdgebunden", "party-pool", "themed", "theme-dark"],
    tag: "div",
    window: {
      title: "Party-Pool",
      resizable: true,
    },
    position: {
      width: 620,
      height: 720,
    },
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/party-pool.hbs` },
  };

  private _tab: PoolTab = "money";
  private _actorId: string | null = null;

  constructor() {
    super();
    this._actorId = (game as any).user?.character?.id ?? null;
  }

  /** Open (or focus) the single shared pool window. */
  static open(): void {
    const existing = (foundry as any).applications.instances.get(APP_ID);
    if (existing) {
      existing.render({ force: true });
      existing.bringToFront?.();
      return;
    }
    new PartyPoolApp().render({ force: true });
  }

  /** Re-render any open pool window (called when the shared state changes). */
  static refreshOpen(): void {
    for (const app of (foundry as any).applications.instances.values()) {
      if (app instanceof PartyPoolApp) app.render();
    }
  }

  private _ownedCharacters(): any[] {
    return ((game as any).actors?.contents ?? []).filter((a: any) => a.isOwner && a.type === "character");
  }

  private _resolveActorId(): string | null {
    if (this._actorId && (game as any).actors?.get(this._actorId)?.isOwner) return this._actorId;
    return this._ownedCharacters()[0]?.id ?? null;
  }

  private _transferTargets(myId: string | null): any[] {
    return ((game as any).actors?.contents ?? []).filter(
      (a: any) => a.type === "character" && a.hasPlayerOwner && a.id !== myId
    );
  }

  async _prepareContext() {
    const state = getPoolState();
    const gm = isGM();
    const myId = this._resolveActorId();

    const items = state.items.map((i) => ({
      poolId: i.poolId,
      name: i.data?.name ?? "?",
      img: i.data?.img ?? "icons/svg/item-bag.svg",
      qty: itemQuantity(i.data),
    }));

    const log = gm
      ? state.log.map((e) => ({
          time: new Date(e.ts).toLocaleString(),
          userName: e.userName,
          action: e.action,
          detail: e.detail,
        }))
      : [];

    return {
      tab: this._tab,
      isGM: gm,
      moneyDisplay: formatMoney(state.moneyCp),
      itemCount: items.length,
      items,
      log,
      hasLog: log.length > 0,
      ownedCharacters: this._ownedCharacters().map((a: any) => ({ id: a.id, name: a.name })),
      selectedActorId: myId,
      hasActor: !!myId,
      transferTargets: this._transferTargets(myId).map((a: any) => ({ id: a.id, name: a.name })),
    } as any;
  }

  protected _attachPartListeners(partId: string, html: HTMLElement): void {
    super._attachPartListeners(partId, html, {});

    html.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
      el.addEventListener("click", (ev) => this._onAction(ev));
    });

    const actorSelect = html.querySelector<HTMLSelectElement>("[data-select-actor]");
    actorSelect?.addEventListener("change", () => {
      this._actorId = actorSelect.value || null;
      this.render();
    });

    html.querySelectorAll<HTMLElement>("[data-dropzone]").forEach((zone) => {
      const mode = zone.dataset.dropzone as "deposit" | "transfer";
      zone.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        zone.classList.add("drag-over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
      zone.addEventListener("drop", (ev) => {
        zone.classList.remove("drag-over");
        this._onDrop(ev as DragEvent, mode);
      });
    });
  }

  // ── Input helpers ──

  private _readMoney(attr: string): number {
    const root = this.element;
    const val = (sel: string) =>
      Number((root.querySelector(`[data-${attr}="${sel}"]`) as HTMLInputElement)?.value || 0);
    return partsToCp({ gp: val("gp"), sp: val("sp"), cp: val("cp") });
  }

  private _selectedTargetId(): string | null {
    return (this.element.querySelector("[data-transfer-target]") as HTMLSelectElement)?.value || null;
  }

  // ── Execution helpers ──

  private async _exec(name: string, payload: Record<string, any>): Promise<PoolResult> {
    try {
      const res = await socket.executeAsGM(name, {
        ...payload,
        userName: userName(),
        userId: (game as any).user?.id,
      });
      return (res as PoolResult) ?? { ok: false, reason: "Keine Antwort vom GM" };
    } catch (e) {
      console.error(`[${MODULE_ID}] Pool socket call failed:`, e);
      return { ok: false, reason: "Kein GM online" };
    }
  }

  private _after(res: PoolResult, successMsg: string): void {
    if (res.ok) {
      (ui as any).notifications?.info(successMsg);
    } else {
      (ui as any).notifications?.warn(res.reason ?? "Aktion nicht möglich");
    }
    this.render();
  }

  // ── Actions ──

  private async _onAction(event: Event): Promise<void> {
    const target = event.currentTarget as HTMLElement;
    const action = target.dataset.action;

    switch (action) {
      case "switch-tab":
        this._tab = (target.dataset.tab as PoolTab) ?? "money";
        this.render();
        break;

      case "deposit-money": {
        const actorId = this._resolveActorId();
        if (!actorId) return this._noActor();
        const amountCp = this._readMoney("deposit");
        if (amountCp <= 0) return void (ui as any).notifications?.warn("Bitte einen Betrag eingeben");
        this._after(await this._exec(POOL_SOCKET.depositMoney, { actorId, amountCp }), "Eingezahlt");
        break;
      }

      case "withdraw-money": {
        const actorId = this._resolveActorId();
        if (!actorId) return this._noActor();
        const amountCp = this._readMoney("withdraw");
        if (amountCp <= 0) return void (ui as any).notifications?.warn("Bitte einen Betrag eingeben");
        if (isGM()) {
          this._after(await withdrawMoney(actorId, amountCp, userName()), "Entnommen");
        } else {
          this._after(await this._exec(POOL_SOCKET.withdrawMoney, { actorId, amountCp }), "Entnahme genehmigt");
        }
        break;
      }

      case "gm-add-money": {
        if (!isGM()) return;
        const amountCp = this._readMoney("gmadd");
        if (amountCp <= 0) return void (ui as any).notifications?.warn("Bitte einen Betrag eingeben");
        this._after(await gmAddMoney(amountCp, userName()), "Zum Pool hinzugefügt");
        break;
      }

      case "withdraw-item": {
        const actorId = this._resolveActorId();
        if (!actorId) return this._noActor();
        const poolId = target.dataset.poolId;
        if (!poolId) return;
        if (isGM()) {
          this._after(await withdrawItem(actorId, poolId, userName()), "Entnommen");
        } else {
          this._after(await this._exec(POOL_SOCKET.withdrawItem, { actorId, poolId }), "Entnahme genehmigt");
        }
        break;
      }

      case "transfer-money": {
        const fromId = this._resolveActorId();
        if (!fromId) return this._noActor();
        const toId = this._selectedTargetId();
        if (!toId) return void (ui as any).notifications?.warn("Bitte einen Ziel-Spieler wählen");
        const amountCp = this._readMoney("transfer");
        if (amountCp <= 0) return void (ui as any).notifications?.warn("Bitte einen Betrag eingeben");
        this._after(await this._exec(POOL_SOCKET.transferMoney, { fromId, toId, amountCp }), "Übergeben");
        break;
      }

      case "distribute":
        if (isGM()) await this._openDistributeDialog();
        break;
    }
  }

  private _noActor(): void {
    (ui as any).notifications?.warn("Kein Charakter ausgewählt");
  }

  private async _onDrop(event: DragEvent, mode: "deposit" | "transfer"): Promise<void> {
    event.preventDefault();
    let data: any;
    try {
      data = JSON.parse(event.dataTransfer?.getData("text/plain") ?? "");
    } catch {
      return;
    }
    if (data?.type !== "Item" || !data.uuid) {
      (ui as any).notifications?.warn("Nur Gegenstände können hier abgelegt werden");
      return;
    }

    if (mode === "deposit") {
      this._after(await this._exec(POOL_SOCKET.depositItem, { itemUuid: data.uuid }), "Gegenstand eingezahlt");
    } else {
      const toId = this._selectedTargetId();
      if (!toId) return void (ui as any).notifications?.warn("Bitte zuerst einen Ziel-Spieler wählen");
      const fromId = this._resolveActorId();
      this._after(await this._exec(POOL_SOCKET.transferItem, { fromId, toId, itemUuid: data.uuid }), "Übergeben");
    }
  }

  // ── GM: Loot distribution (30/70) ──

  private async _openDistributeDialog(): Promise<void> {
    const characters = ((game as any).actors?.contents ?? []).filter(
      (a: any) => a.type === "character" && a.hasPlayerOwner
    );

    const rows = characters
      .map(
        (a: any) =>
          `<label class="pp-check"><input type="checkbox" name="present" value="${a.id}" checked /> ${a.name}</label>`
      )
      .join("");

    const content = `
      <div class="pp-distribute">
        <p>Gelootetes Geld eingeben. 30% fließen in die Gildenbank, 70% werden gleichmäßig auf die angehakten Anwesenden verteilt.</p>
        <div class="pp-money-input">
          <label>GP <input type="number" min="0" name="gp" value="0" /></label>
          <label>SP <input type="number" min="0" name="sp" value="0" /></label>
          <label>CP <input type="number" min="0" name="cp" value="0" /></label>
        </div>
        <fieldset class="pp-present">
          <legend>Anwesende Spieler</legend>
          ${rows || "<em>Keine Spieler-Charaktere gefunden</em>"}
        </fieldset>
      </div>`;

    await foundry.applications.api.DialogV2.wait({
      window: { title: "Beute verteilen (30/70)" },
      content,
      buttons: [
        {
          action: "distribute",
          label: "Verteilen",
          default: true,
          callback: async (_ev: any, _btn: any, dialog: any) => {
            const root: HTMLElement = dialog.element ?? dialog;
            const num = (n: string) =>
              Number((root.querySelector(`[name="${n}"]`) as HTMLInputElement)?.value || 0);
            const amountCp = partsToCp({ gp: num("gp"), sp: num("sp"), cp: num("cp") });
            const ids = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="present"]:checked')).map(
              (el) => el.value
            );
            const res = await distribute(amountCp, ids, userName());
            this._after(res, "Beute verteilt");
          },
        },
        { action: "cancel", label: "Abbrechen" },
      ],
    });
  }
}
