import { system, world } from "@minecraft/server";
import { FinanceManager } from "./core/FinanceManager.js";
import { setupUIHandlers } from "./ui/handlers.js";

export const finance = new FinanceManager();

system.beforeEvents.startup.subscribe((event) => {
  const reg = event.blockComponentRegistry;
  const ids = [
    "financecore:atm",
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
