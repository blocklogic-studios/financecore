import { system, world } from "@minecraft/server";
import { FinanceManager } from "./core/FinanceManager.js";
import { setupUIHandlers } from "./ui/handlers.js";

export const finance = new FinanceManager();

system.beforeEvents.startup.subscribe((event) => {
  const reg = event.blockComponentRegistry;
  const ids = [
    "financecore:atm",
    "financecore:atm_generic",
    "financecore:atm_rbc",
    "financecore:atm_td",
    "financecore:atm_bmo",
    "financecore:atm_scotiabank",
    "financecore:atm_cibc",
    "financecore:atm_national",
    "financecore:atm_desjardins",
    "financecore:atm_vancity",
    "financecore:atm_tangerine",
    "financecore:teller_terminal",
    "financecore:card_embosser",
    "financecore:pos_terminal",
    "financecore:cash_drawer",
    "financecore:vault"
  ];
  for (const id of ids) {
    reg.registerCustomComponent(id, {
      onPlayerInteract() {
        /* menus handled in playerInteractWithBlock */
      }
    });
  }
  console.log("[FinanceCore] Components registered");
});

world.afterEvents.worldLoad.subscribe(() => {
  finance.load();
  setupUIHandlers(finance);
  console.log("[FinanceCore] Ready — Canadian multi-bank finance");
});

system.runInterval(() => {
  finance.tick();
}, 20);

console.log("[FinanceCore] Script started");
