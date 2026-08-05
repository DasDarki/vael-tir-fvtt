import { MODULE_ID, PARTY_POOL_SETTING } from "./consts.ts";

// ── Types ──

export type PoolAction =
  | "deposit-money"
  | "withdraw-money"
  | "gm-add-money"
  | "deposit-item"
  | "withdraw-item"
  | "transfer-money"
  | "transfer-item"
  | "distribute";

export interface PoolLogEntry {
  ts: number;
  userName: string;
  action: PoolAction;
  detail: string;
}

export interface PoolItem {
  poolId: string;
  data: any;
}

export interface PartyPoolState {
  moneyCp: number;
  items: PoolItem[];
  log: PoolLogEntry[];
}

export interface PoolResult {
  ok: boolean;
  reason?: string;
}

export interface MoneyParts {
  gp: number;
  sp: number;
  cp: number;
}

const EMPTY_STATE: PartyPoolState = { moneyCp: 0, items: [], log: [] };
const LOG_LIMIT = 500;

// ── Setting Registration & State Access ──

export function registerPartyPoolSetting(): void {
  (game as any).settings.register(MODULE_ID, PARTY_POOL_SETTING, {
    name: "Party Pool",
    scope: "world",
    config: false,
    type: Object,
    default: { ...EMPTY_STATE },
  });
}

/** Read a defensive copy of the current pool state. */
export function getPoolState(): PartyPoolState {
  const raw = (game as any).settings.get(MODULE_ID, PARTY_POOL_SETTING) as PartyPoolState | undefined;
  if (!raw) return { moneyCp: 0, items: [], log: [] };
  return {
    moneyCp: Number(raw.moneyCp) || 0,
    items: Array.isArray(raw.items) ? [...raw.items] : [],
    log: Array.isArray(raw.log) ? [...raw.log] : [],
  };
}

/** Persist the pool state. World-scoped: only a GM client may call this. */
export async function setPoolState(state: PartyPoolState): Promise<void> {
  await (game as any).settings.set(MODULE_ID, PARTY_POOL_SETTING, state);
}

function appendLog(state: PartyPoolState, action: PoolAction, userName: string, detail: string): void {
  state.log.unshift({ ts: Date.now(), userName, action, detail });
  if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT;
}

// ── Currency Helpers (GP/SP/CP with full interchangeability, no PP/EP) ──

export function partsToCp(p: Partial<MoneyParts>): number {
  return Math.floor(p.gp ?? 0) * 100 + Math.floor(p.sp ?? 0) * 10 + Math.floor(p.cp ?? 0);
}

export function cpToParts(cp: number): MoneyParts {
  let rest = Math.max(0, Math.floor(cp));
  const gp = Math.floor(rest / 100);
  rest %= 100;
  const sp = Math.floor(rest / 10);
  rest %= 10;
  return { gp, sp, cp: rest };
}

export function formatMoney(cp: number): string {
  const { gp, sp, cp: c } = cpToParts(cp);
  const parts: string[] = [];
  if (gp) parts.push(`${gp} GP`);
  if (sp) parts.push(`${sp} SP`);
  if (c) parts.push(`${c} CP`);
  return parts.length ? parts.join(" ") : "0 CP";
}

/** Available money on an actor in copper, counting only GP/SP/CP (PP/EP ignored). */
export function actorAvailableCp(actor: any): number {
  const c = actor?.system?.currency ?? {};
  return (Number(c.gp) || 0) * 100 + (Number(c.sp) || 0) * 10 + (Number(c.cp) || 0);
}

/** Set an actor's GP/SP/CP from a copper total, leaving PP/EP untouched. */
async function setActorCp(actor: any, totalCp: number): Promise<void> {
  const { gp, sp, cp } = cpToParts(totalCp);
  await actor.update({
    "system.currency.gp": gp,
    "system.currency.sp": sp,
    "system.currency.cp": cp,
  });
}

async function addActorCp(actor: any, amountCp: number): Promise<void> {
  await setActorCp(actor, actorAvailableCp(actor) + amountCp);
}

function getActor(actorId: string): any {
  return (game as any).actors?.get(actorId);
}

// ── Mutation Core (executed GM-side) ──

export async function depositMoney(actorId: string, amountCp: number, userName: string): Promise<PoolResult> {
  if (amountCp <= 0) return { ok: false, reason: "Betrag muss größer als 0 sein" };
  const actor = getActor(actorId);
  if (!actor) return { ok: false, reason: "Charakter nicht gefunden" };
  const avail = actorAvailableCp(actor);
  if (avail < amountCp) return { ok: false, reason: `Nicht genug Geld (${formatMoney(avail)} vorhanden)` };

  await setActorCp(actor, avail - amountCp);
  const state = getPoolState();
  state.moneyCp += amountCp;
  appendLog(state, "deposit-money", userName, `${actor.name} zahlt ${formatMoney(amountCp)} ein`);
  await setPoolState(state);
  return { ok: true };
}

export async function gmAddMoney(amountCp: number, userName: string): Promise<PoolResult> {
  if (amountCp <= 0) return { ok: false, reason: "Betrag muss größer als 0 sein" };
  const state = getPoolState();
  state.moneyCp += amountCp;
  appendLog(state, "gm-add-money", userName, `GM legt ${formatMoney(amountCp)} an (aus dem Nichts)`);
  await setPoolState(state);
  return { ok: true };
}

export async function withdrawMoney(actorId: string, amountCp: number, userName: string): Promise<PoolResult> {
  if (amountCp <= 0) return { ok: false, reason: "Betrag muss größer als 0 sein" };
  const actor = getActor(actorId);
  if (!actor) return { ok: false, reason: "Charakter nicht gefunden" };
  const state = getPoolState();
  if (state.moneyCp < amountCp) return { ok: false, reason: `Pool hat nur ${formatMoney(state.moneyCp)}` };

  state.moneyCp -= amountCp;
  await addActorCp(actor, amountCp);
  appendLog(state, "withdraw-money", userName, `${actor.name} entnimmt ${formatMoney(amountCp)}`);
  await setPoolState(state);
  return { ok: true };
}

export async function depositItem(itemUuid: string, userName: string): Promise<PoolResult> {
  const item = await (globalThis as any).fromUuid(itemUuid);
  if (!item) return { ok: false, reason: "Gegenstand nicht gefunden" };
  const itemName = item.name;
  // Actor-embedded items are moved out of the owner's inventory; world or compendium
  // items (e.g. dragged from the sidebar) are copied so the original is not consumed.
  const ownerName = item.isEmbedded ? item.parent?.name ?? userName : userName;
  const data = item.toObject();

  if (item.isEmbedded) await item.delete();
  const state = getPoolState();
  state.items.push({ poolId: (foundry as any).utils.randomID(), data });
  appendLog(state, "deposit-item", userName, `${ownerName} legt "${itemName}" in den Pool`);
  await setPoolState(state);
  return { ok: true };
}

export async function withdrawItem(actorId: string, poolId: string, userName: string): Promise<PoolResult> {
  const actor = getActor(actorId);
  if (!actor) return { ok: false, reason: "Charakter nicht gefunden" };
  const state = getPoolState();
  const idx = state.items.findIndex((i) => i.poolId === poolId);
  if (idx < 0) return { ok: false, reason: "Gegenstand nicht mehr im Pool" };

  const entry = state.items[idx]!;
  await actor.createEmbeddedDocuments("Item", [entry.data]);
  state.items.splice(idx, 1);
  appendLog(state, "withdraw-item", userName, `${actor.name} entnimmt "${entry.data?.name ?? "?"}"`);
  await setPoolState(state);
  return { ok: true };
}

export async function transferMoney(fromId: string, toId: string, amountCp: number, userName: string): Promise<PoolResult> {
  if (amountCp <= 0) return { ok: false, reason: "Betrag muss größer als 0 sein" };
  const from = getActor(fromId);
  const to = getActor(toId);
  if (!from || !to) return { ok: false, reason: "Charakter nicht gefunden" };
  if (from.id === to.id) return { ok: false, reason: "Quelle und Ziel sind identisch" };
  const avail = actorAvailableCp(from);
  if (avail < amountCp) return { ok: false, reason: `${from.name} hat nicht genug Geld (${formatMoney(avail)})` };

  await setActorCp(from, avail - amountCp);
  await addActorCp(to, amountCp);
  const state = getPoolState();
  appendLog(state, "transfer-money", userName, `${from.name} → ${to.name}: ${formatMoney(amountCp)}`);
  await setPoolState(state);
  return { ok: true };
}

export async function transferItem(fromId: string, toId: string, itemUuid: string, userName: string): Promise<PoolResult> {
  const from = getActor(fromId);
  const to = getActor(toId);
  if (!to) return { ok: false, reason: "Zielcharakter nicht gefunden" };
  const item = await (globalThis as any).fromUuid(itemUuid);
  if (!item) return { ok: false, reason: "Gegenstand nicht gefunden" };
  const itemName = item.name;
  const data = item.toObject();

  await item.delete();
  await to.createEmbeddedDocuments("Item", [data]);
  const state = getPoolState();
  appendLog(state, "transfer-item", userName, `${from?.name ?? userName} → ${to.name}: "${itemName}"`);
  await setPoolState(state);
  return { ok: true };
}

export async function distribute(amountCp: number, presentActorIds: string[], userName: string): Promise<PoolResult> {
  if (amountCp <= 0) return { ok: false, reason: "Betrag muss größer als 0 sein" };
  const ids = [...new Set(presentActorIds)].filter((id) => getActor(id));
  if (ids.length === 0) return { ok: false, reason: "Keine anwesenden Spieler ausgewählt" };

  const bank = Math.round(amountCp * 0.3);
  const toShare = amountCp - bank;
  const share = Math.floor(toShare / ids.length);
  const remainder = toShare - share * ids.length;
  const bankTotal = bank + remainder;

  const state = getPoolState();
  state.moneyCp += bankTotal;
  for (const id of ids) {
    await addActorCp(getActor(id), share);
  }
  const names = ids.map((id) => getActor(id).name).join(", ");
  appendLog(
    state,
    "distribute",
    userName,
    `Beute ${formatMoney(amountCp)} verteilt: ${formatMoney(bankTotal)} in die Gildenbank, je ${formatMoney(share)} an ${names}`
  );
  await setPoolState(state);
  return { ok: true };
}
