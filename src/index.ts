import "styles/index.scss";

import { MODULE_ID, setSocket } from "./consts.ts";
import { loadAllData, getFlags } from "./data.ts";
import { ErdgebundenApp } from "./app.ts";

// ── Socket Setup ──

// @ts-ignore
Hooks.once("socketlib.ready", () => {
  // @ts-ignore
  const socket = socketlib.registerModule(MODULE_ID);

  socket.register("unlockSkill", (data: any) => {
    // GM-side handler: handled via flag updates, no extra logic needed
  });

  setSocket(socket);
});

// ── Initialization ──

Hooks.once("init", async () => {
  console.log(`[${MODULE_ID}] Initializing Erdgebunden module`);

  // Load all templates
  foundry.applications.handlebars.loadTemplates([
    `modules/${MODULE_ID}/templates/main-view.hbs`,
    `modules/${MODULE_ID}/templates/ader-view.hbs`,
    `modules/${MODULE_ID}/templates/skill-tooltip.hbs`,
    `modules/${MODULE_ID}/templates/summary-view.hbs`,
  ]);
});

Hooks.once("ready", async () => {
  // Load all JSON data
  try {
    await loadAllData();
    console.log(`[${MODULE_ID}] Skill data loaded successfully`);
  } catch (e) {
    console.error(`[${MODULE_ID}] Failed to load skill data:`, e);
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
