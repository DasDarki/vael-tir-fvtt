import "styles/index.scss";

import { MODULE_ID, setSocket, POOL_SOCKET, PARTY_POOL_SETTING } from "./consts.ts";
import { loadAllData, getFlags } from "./data.ts";
import { syncActorMechanics } from "./mechanics.ts";
import { ErdgebundenApp } from "./app.ts";
import { PartyPoolApp } from "./party-pool.ts";
import {
  registerPartyPoolSetting,
  getPoolState,
  formatMoney,
  depositMoney,
  depositItem,
  withdrawMoney,
  withdrawItem,
  transferMoney,
  transferItem,
  type PoolResult,
} from "./pool-data.ts";

// ── Socket Setup ──

// @ts-ignore
Hooks.once("socketlib.ready", () => {
  // @ts-ignore
  const socket = socketlib.registerModule(MODULE_ID);

  socket.register("unlockSkill", (data: any) => {
    // GM-side handler: handled via flag updates, no extra logic needed
  });

  // Party-pool operations run authoritatively on a GM client.
  // Deposits and P2P transfers are free; withdrawals require GM approval.
  socket.register(POOL_SOCKET.depositMoney, (d: any) => depositMoney(d.actorId, d.amountCp, d.userName));
  socket.register(POOL_SOCKET.depositItem, (d: any) => depositItem(d.itemUuid, d.userName));
  socket.register(POOL_SOCKET.transferMoney, (d: any) => transferMoney(d.fromId, d.toId, d.amountCp, d.userName));
  socket.register(POOL_SOCKET.transferItem, (d: any) => transferItem(d.fromId, d.toId, d.itemUuid, d.userName));
  socket.register(POOL_SOCKET.withdrawMoney, (d: any) => gmApproveWithdrawMoney(d));
  socket.register(POOL_SOCKET.withdrawItem, (d: any) => gmApproveWithdrawItem(d));

  setSocket(socket);
});

/** GM-side approval dialog for a money withdrawal request, then performs it. */
async function gmApproveWithdrawMoney(d: any): Promise<PoolResult> {
  const actor = (game as any).actors?.get(d.actorId);
  const approved = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Pool-Entnahme genehmigen" },
    content: `<p><strong>${d.userName}</strong> möchte <strong>${formatMoney(d.amountCp)}</strong> für „${actor?.name ?? "?"}" aus dem Party-Pool entnehmen.</p>`,
    yes: { label: "Genehmigen" },
    no: { label: "Ablehnen" },
  });
  if (!approved) return { ok: false, reason: "Vom GM abgelehnt" };
  return withdrawMoney(d.actorId, d.amountCp, d.userName);
}

/** GM-side approval dialog for an item withdrawal request, then performs it. */
async function gmApproveWithdrawItem(d: any): Promise<PoolResult> {
  const entry = getPoolState().items.find((i) => i.poolId === d.poolId);
  if (!entry) return { ok: false, reason: "Gegenstand nicht mehr im Pool" };
  const actor = (game as any).actors?.get(d.actorId);
  const approved = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Pool-Entnahme genehmigen" },
    content: `<p><strong>${d.userName}</strong> möchte „${entry.data?.name ?? "?"}" für „${actor?.name ?? "?"}" aus dem Party-Pool entnehmen.</p>`,
    yes: { label: "Genehmigen" },
    no: { label: "Ablehnen" },
  });
  if (!approved) return { ok: false, reason: "Vom GM abgelehnt" };
  return withdrawItem(d.actorId, d.poolId, d.userName);
}

// ── Initialization ──

Hooks.once("init", async () => {
  console.log(`[${MODULE_ID}] Initializing Erdgebunden module`);

  registerPartyPoolSetting();

  // Load all templates
  foundry.applications.handlebars.loadTemplates([
    `modules/${MODULE_ID}/templates/main-view.hbs`,
    `modules/${MODULE_ID}/templates/ader-view.hbs`,
    `modules/${MODULE_ID}/templates/skill-tooltip.hbs`,
    `modules/${MODULE_ID}/templates/summary-view.hbs`,
    `modules/${MODULE_ID}/templates/party-pool.hbs`,
  ]);
});

// ── Party Pool: chat command & live refresh ──

Hooks.on("chatMessage", (_log: any, message: string) => {
  if (/^\/party-?pool\b/i.test((message ?? "").trim())) {
    PartyPoolApp.open();
    return false;
  }
  return undefined;
});

// The pool state lives in a world setting; updateSetting fires on every client
// when it changes, so open pool windows refresh themselves without manual sockets.
Hooks.on("updateSetting", (setting: any) => {
  if ((setting?.key ?? "").endsWith(PARTY_POOL_SETTING)) {
    PartyPoolApp.refreshOpen();
  }
});

Hooks.once("ready", async () => {
  // Load all JSON data
  try {
    await loadAllData();
    console.log(`[${MODULE_ID}] Skill data loaded successfully`);
  } catch (e) {
    console.error(`[${MODULE_ID}] Failed to load skill data:`, e);
    return;
  }

  // Reconcile sheet mechanics for all owned actors so existing, already-skilled
  // characters get their Active Effects without having to reopen the skill tree.
  const actors: any[] = (game as any).actors?.contents ?? [];
  for (const actor of actors) {
    if (!actor?.isOwner) continue;
    try {
      await syncActorMechanics(actor);
    } catch (e) {
      console.error(`[${MODULE_ID}] Failed to sync mechanics for actor "${actor?.name}":`, e);
    }
  }
});

// ── Button Injection ──

Hooks.on("renderActorSheetV2", (_app: any, element: HTMLElement, context: any) => {
  const header = element.querySelector(".window-header");
  if (!header) return;

  // Don't inject twice
  if (header.querySelector("button[data-erdgebunden]")) return;

  const actor = context.document;
  if (!actor) return;

  const flags = getFlags(actor);
  const isGM = !!game.user?.isGM;

  // Players only see button if activated
  if (!isGM && !flags.activated) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.classList.add("header-control", "icon", "fa-solid", "fa-mountain");
  btn.dataset.erdgebunden = "true";
  btn.dataset.actorId = actor.id;
  btn.dataset.tooltip = "Erdgebunden";
  btn.setAttribute("aria-label", "Erdgebunden Skill Tree");

  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openErdgebundenApp(actor.id);
  });

  const firstBtn = header.querySelector("button");
  if (firstBtn) {
    firstBtn.insertAdjacentElement("beforebegin", btn);
  } else {
    header.appendChild(btn);
  }
});

function openErdgebundenApp(actorId: string) {
  const actor = game.actors?.get(actorId);
  if (!actor) {
    console.warn(`[${MODULE_ID}] Could not find actor:`, actorId);
    return;
  }

  const app = new ErdgebundenApp(actor);
  app.render({ force: true });
}
