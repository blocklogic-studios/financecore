import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { system, world, ItemStack } from "@minecraft/server";

function nextForm(fn) {
  system.run(() => {
    try { fn(); } catch (e) { console.warn("[FinanceCore] form:", e); }
  });
}

/** Parse CAD amount; returns null if invalid */
function parseAmount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function isAdmin(player) {
  try {
    if (typeof player.isOp === "function" && player.isOp()) return true;
  } catch (e) {}
  try {
    if (player.hasTag && player.hasTag("financecore_admin")) return true;
  } catch (e) {}
  return false;
}

function holdingBankManager(player) {
  try {
    const equip = player.getComponent("equippable");
    if (equip) {
      for (const slot of ["Mainhand", "Offhand", "mainhand", "offhand"]) {
        try {
          const it = equip.getEquipment(slot);
          if (it && it.typeId === "financecore:bank_manager") return true;
        } catch (e) {}
      }
    }
    const inv = player.getComponent("inventory")?.container;
    // selected slot often = mainhand; also scan hotbar
    if (inv) {
      for (let i = 0; i < 9; i++) {
        const it = inv.getItem(i);
        if (it && it.typeId === "financecore:bank_manager") {
          // prefer if selected - selectedSlot available on some builds
          try {
            if (player.selectedSlotIndex === i) return true;
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
  // Final: any hotbar bank manager counts as "holding tool" for mobile
  try {
    const inv = player.getComponent("inventory")?.container;
    if (inv) {
      for (let i = 0; i < 9; i++) {
        const it = inv.getItem(i);
        if (it && it.typeId === "financecore:bank_manager") return true;
      }
    }
  } catch (e) {}
  return false;
}



export function setupUIHandlers(finance) {
  world.afterEvents.itemUse.subscribe((event) => {
    const item = event.itemStack;
    if (!item) return;
    const id = item.typeId;
    const player = event.source;
    if (id === "financecore:bank_book") nextForm(() => showBankBook(player, finance));
    else if (id === "financecore:bank_manager")
      player.sendMessage("§7Bank Manager: §fclick an ATM§7 to configure bank, color, and networks.");
    else if (id === "financecore:debit_card" || id === "financecore:credit_card" || id === "financecore:business_card")
      nextForm(() => showCardMenu(player, finance, item));
    else if (id === "financecore:cheque") nextForm(() => showChequeItem(player, finance, item));
  });

  world.afterEvents.playerInteractWithBlock.subscribe((event) => {
    const block = event.block;
    if (!block) return;
    const id = block.typeId;
    const player = event.player;
    const map = {
      "financecore:teller_terminal": () => showTeller(player, finance),
      "financecore:card_embosser": () => showEmbosser(player, finance),
      "financecore:pos_terminal": () => showPOS(player, finance),
      "financecore:cash_drawer": () => showDrawer(player, finance, block),
      "financecore:vault": () => showVault(player, finance, block)
    };
    if (id === "financecore:atm" || id.startsWith("financecore:atm_")) {
      event.cancel = true;
      if (holdingBankManager(player)) {
        nextForm(() => showATMConfig(player, finance, block));
      } else {
        nextForm(() => showATM(player, finance, block));
      }
    } else if (map[id]) {
      event.cancel = true;
      nextForm(map[id]);
    }
  });

  try {
    if (world.beforeEvents && world.beforeEvents.playerPlaceBlock) {
      world.beforeEvents.playerPlaceBlock.subscribe((event) => {
        const player = event.player;
        if (!player || !finance.settings.costPerBlock) return;
        const r = finance.tryChargeBlockPlace(player.name);
        if (!r.ok) { event.cancel = true; player.sendMessage(`§c${r.error}`); }
      });
      console.log("[FinanceCore] Block-cost place hook active");
    } else {
      console.warn("[FinanceCore] playerPlaceBlock unavailable — block cost disabled on this build");
    }
  } catch (e) {
    console.warn("[FinanceCore] Block-cost hook failed", e);
  }
}

function showBankBook(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  const cards = finance.getPlayerCards(player.name);
  let body = accounts.length
    ? accounts.map((a) => {
        const inst = finance.getInstitution(a.institutionId);
        const line = a.type === "credit"
          ? `owed ${finance.formatMoney(a.balance)} / limit ${finance.formatMoney(a.limit)}${a.overdue ? " §cOVERDUE" : ""}`
          : finance.formatMoney(a.balance);
        return `§e${inst?.name || a.institutionId}\n§7${a.type} §f${a.id}\n§a${line}`;
      }).join("\n\n")
    : "§7No accounts. Visit a Teller.";
  if (cards.length) {
    body += "\n\n§8Cards:\n" + cards.map((c) => `§7${c.institutionName} ••${c.last4} §8(${c.status})`).join("\n");
  }
  new ActionFormData().title("Bank Book").body(body)
    .button("Pending e-Transfers")
    .button("Transaction history")
    .button("Employer deposit info")
    .button("Register my phone")
    .button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 4) return;
      if (res.selection === 0) nextForm(() => showPendingTransfers(player, finance));
      if (res.selection === 1) nextForm(() => showPickAccountHistory(player, finance));
      if (res.selection === 2) nextForm(() => showEmployerDepositInfo(player, finance));
      if (res.selection === 3) nextForm(() => showRegisterPhone(player, finance));
    });
}

function showRegisterPhone(player, finance) {
  new ModalFormData().title("Phone for e-Transfer").textField("Phone number", "4165551234")
    .show(player).then((res) => {
      if (res.canceled) return;
      const r = finance.registerPhoneAlias(player.name, res.formValues[0]);
      player.sendMessage(r.ok ? "§aPhone registered" : `§c${r.error}`);
    });
}

function showCardMenu(player, finance, item) {
  const cardId = finance.parseCardIdFromItem(item);
  const card = cardId ? finance.getCard(cardId) : null;
  const body = card
    ? `§e${card.institutionName}\n§7•••• ${card.last4}\n§8${card.type} · ${card.status}\n§8Exp ${card.expiry}\n§7${card.id}`
    : "§7No card id on item lore.";
  new ActionFormData().title("Card").body(body)
    .button("Change PIN").button("Freeze").button("Report lost").button("Reactivate").button("Close")
    .show(player).then((res) => {
      if (res.canceled || !card || res.selection === 4) return;
      if (res.selection === 0) {
        nextForm(() => {
          new ModalFormData().title("Change PIN").textField("Current PIN", "****").textField("New PIN", "****")
            .show(player).then((r) => {
              if (r.canceled) return;
              const out = finance.changePin(card.id, player.name, r.formValues[0], r.formValues[1]);
              player.sendMessage(out.ok ? "§aPIN updated" : `§c${out.error}`);
            });
        });
      }
      if (res.selection === 1) player.sendMessage(finance.setCardStatus(card.id, player.name, "frozen").ok ? "§eFrozen" : "§cFail");
      if (res.selection === 2) player.sendMessage(finance.setCardStatus(card.id, player.name, "lost").ok ? "§cLost" : "§cFail");
      if (res.selection === 3) player.sendMessage(finance.setCardStatus(card.id, player.name, "active").ok ? "§aActive" : "§cFail");
    });
}

function showChequeItem(player, finance, item) {
  const lore = item.getLore?.() || [];
  let id = null;
  for (const line of lore) {
    const m = String(line).match(/chq_\d+/);
    if (m) { id = m[0]; break; }
  }
  if (!id && item.nameTag) {
    const m = String(item.nameTag).match(/chq_\d+/);
    if (m) id = m[0];
  }
  if (!id) { player.sendMessage("§7Invalid cheque — no id in lore"); return; }
  new ActionFormData().title("Cheque").body(lore.join("\n") || id).button("Deposit").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection !== 0) return;
      nextForm(() => pickAccountForm(player, finance, "Deposit to", (acc) => {
        const r = finance.depositCheque(id, acc.id, player.name);
        player.sendMessage(r.ok ? "§aCleared" : `§c${r.error}`);
      }));
    });
}

function showATM(player, finance, block) {
  const dim = block ? block.dimension.id : "minecraft:overworld";
  const x = block ? block.x : 0, y = block ? block.y : 0, z = block ? block.z : 0;
  const cfg = block ? finance.getAtmConfig(dim, x, y, z) : { label: "ATM", networks: ["Interac"], institutionId: "generic", color: "bank_default" };
  const inst = finance.getInstitution(cfg.institutionId);
  const nets = (cfg.networks || []).join(" · ") || "Interac";
  const title = cfg.label || (inst ? `${inst.name} ATM` : "ATM");
  const body = `§e${title}\n§7Networks: §f${nets}\n§8Color: ${cfg.color || "default"}\n§7${finance.getCurrency()} tender · card + PIN`;
  const form = new ActionFormData().title(title.slice(0, 28)).body(body)
    .button("Use card (PIN)")
    .button("My accounts")
    .button("Pending e-Transfers");
  if (isAdmin(player)) form.button("§6Configure ATM");
  form.button("Close");
  const closeIdx = isAdmin(player) ? 4 : 3;
  form.show(player).then((res) => {
    if (res.canceled || res.selection === closeIdx) return;
    if (res.selection === 0) nextForm(() => showATMCardSession(player, finance, cfg));
    if (res.selection === 1) nextForm(() => showAccountList(player, finance));
    if (res.selection === 2) nextForm(() => showPendingTransfers(player, finance));
    if (isAdmin(player) && res.selection === 3) nextForm(() => showATMConfig(player, finance, block));
  });
}

function showATMConfig(player, finance, block) {
  if (!block) { player.sendMessage("§cNo ATM block"); return; }
  const dim = block.dimension.id;
  const cfg = finance.getAtmConfig(dim, block.x, block.y, block.z);
  new ActionFormData().title("Configure ATM")
    .body(`§7Bank: §f${cfg.institutionId}\n§7Color: §f${cfg.color}\n§7Networks: §f${(cfg.networks||[]).join(", ")}`)
    .button("Set bank / logo")
    .button("Set color")
    .button("Set networks")
    .button("Apply branded model")
    .button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 4) return;
      if (res.selection === 0) nextForm(() => showATMPickBank(player, finance, block));
      if (res.selection === 1) nextForm(() => showATMPickColor(player, finance, block));
      if (res.selection === 2) nextForm(() => showATMPickNetworks(player, finance, block));
      if (res.selection === 3) {
        const c = finance.getAtmConfig(dim, block.x, block.y, block.z);
        const r = finance.applyAtmBlockType(block.dimension, block.x, block.y, block.z, c.institutionId);
        player.sendMessage(r.ok ? `§aApplied §f${r.typeId}` : `§c${r.error}`);
      }
    });
}

function showATMPickBank(player, finance, block) {
  const insts = [
    { id: "generic", name: "Network / generic" },
    ...finance.listInstitutions()
  ];
  const form = new ActionFormData().title("ATM bank").body("§7Stylized in-game branding (not official logos)");
  for (const i of insts) form.button(i.name);
  form.show(player).then((res) => {
    if (res.canceled) return;
    const pick = insts[res.selection];
    if (!pick) return;
    finance.setAtmConfig(block.dimension.id, block.x, block.y, block.z, { institutionId: pick.id });
    const r = finance.applyAtmBlockType(block.dimension, block.x, block.y, block.z, pick.id);
    player.sendMessage(`§aATM set to §f${pick.name}` + (r.ok ? " §7(model updated)" : " §c(model swap failed)"));
  });
}

function showATMPickColor(player, finance, block) {
  const colors = [
    { id: "bank_default", label: "Bank default" },
    { id: "blue", label: "Blue" },
    { id: "green", label: "Green" },
    { id: "red", label: "Red" },
    { id: "black", label: "Black" },
    { id: "orange", label: "Orange" },
    { id: "white", label: "White / silver" }
  ];
  const form = new ActionFormData().title("ATM color");
  for (const c of colors) form.button(c.label);
  form.show(player).then((res) => {
    if (res.canceled) return;
    const c = colors[res.selection];
    if (!c) return;
    finance.setAtmConfig(block.dimension.id, block.x, block.y, block.z, { color: c.id });
    player.sendMessage(`§aColor: §f${c.label}`);
  });
}

function showATMPickNetworks(player, finance, block) {
  const all = ["Interac", "Visa Debit", "Mastercard", "Plus", "Cirrus", "THE EXCHANGE"];
  const cfg = finance.getAtmConfig(block.dimension.id, block.x, block.y, block.z);
  const current = new Set(cfg.networks || []);
  const form = new ActionFormData().title("Toggle networks")
    .body("§7Tap to toggle · current shown with ✓");
  for (const n of all) form.button(`${current.has(n) ? "§a✓ " : "§8○ "}${n}`);
  form.button("Done");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === all.length) return;
    const n = all[res.selection];
    if (current.has(n)) current.delete(n); else current.add(n);
    finance.setAtmConfig(block.dimension.id, block.x, block.y, block.z, { networks: [...current] });
    nextForm(() => showATMPickNetworks(player, finance, block));
  });
}


function showATMCardSession(player, finance, cfg) {
  const heldId = finance.getHeldCardId(player);
  const defaultId = heldId || "card_4001";
  const bodyHint = heldId ? `§aHeld card detected: ${heldId}` : "§7Hold a card or type id from lore";
  new ModalFormData()
    .title("Insert card")
    .textField(`Card id (${heldId ? "held OK" : "or hold card"})`, defaultId)
    .textField("PIN", "****")
    .show(player).then((res) => {
      if (res.canceled) return;
      let cardId = String(res.formValues[0] || "").trim();
      if (!cardId && heldId) cardId = heldId;
      if (!cardId) cardId = heldId;
      const card = finance.getCard(cardId);
      if (!card) { player.sendMessage("§cCard not found — hold your card or check lore id:card_…"); return; }
      if (card.owner !== player.name) { player.sendMessage("§cThis card is not yours"); return; }
      const pinCheck = finance.verifyPin(cardId, res.formValues[1]);
      if (!pinCheck.ok) { player.sendMessage(`§c${pinCheck.error}`); return; }
      nextForm(() => showATMOps(player, finance, card, cfg));
    });
}

function showATMOps(player, finance, card, cfg) {
  const acc = finance.getAccount(card.accountId);
  const bal =
    acc && acc.type === "credit"
      ? "owed " + finance.formatMoney(acc.balance)
      : finance.formatMoney(acc ? acc.balance : 0);
  const atmLabel = (cfg && cfg.label) || "ATM";
  const nets = cfg && cfg.networks && cfg.networks.length ? cfg.networks.join(" / ") : "Interac";
  const title = (String(atmLabel).slice(0, 18) + " *" + card.last4).slice(0, 30);
  new ActionFormData()
    .title(title)
    .body(String(card.institutionName || "") + "\n" + nets + "\n" + bal)
    .button("Withdraw cash")
    .button("Deposit cash")
    .button("Transfer")
    .button("e-Transfer")
    .button("Direct deposit")
            .button("Done")
    .show(player)
    .then((res) => {
      if (res.canceled || res.selection === 6) return;
      if (res.selection === 0) {
        nextForm(() => {
          new ModalFormData()
            .title("Withdraw")
            .textField("Amount", "40")
            .show(player)
            .then((r) => {
              if (r.canceled) return;
              const amount = parseAmount(r.formValues[0]);
              if (amount == null) {
                player.sendMessage("Invalid amount");
                return;
              }
              const out = finance.withdrawCash(card.accountId, amount, player);
              player.sendMessage(out.ok ? "Dispensed " + finance.formatMoney(amount) : String(out.error));
            });
        });
      }
      if (res.selection === 1) {
        nextForm(() => {
          let split = { cad: 0, usd: 0, total: 0 };
          try {
            split = finance.countInventoryCashSplit(player);
          } catch (e) {
            console.warn("[FinanceCore] cash split", e);
            split = { cad: 0, usd: 0, total: finance.countInventoryCash(player) || 0 };
          }
          const held = split.total || 0;
          const label =
            "CAD " +
            Number(split.cad || 0).toFixed(2) +
            " USD " +
            Number(split.usd || 0).toFixed(2);
          new ModalFormData()
            .title("Deposit cash")
            .textField(label, held > 0 ? String(held) : "20")
            .show(player)
            .then((r) => {
              if (r.canceled) return;
              const amount = parseAmount(r.formValues[0]);
              if (amount == null) {
                player.sendMessage("Invalid amount");
                return;
              }
              try {
                const out = finance.depositCash(card.accountId, player, amount, "ALL");
                if (out.ok) {
                  player.sendMessage(
                    "Deposited " +
                      finance.formatMoney(out.deposited || amount) +
                      " Balance " +
                      finance.formatMoney(out.balance)
                  );
                } else {
                  player.sendMessage(String(out.error || "Deposit failed"));
                }
              } catch (e) {
                console.warn("[FinanceCore] deposit", e);
                player.sendMessage("Deposit error - check content log");
              }
            });
        });
      }
      if (res.selection === 2) nextForm(() => showInternalTransfer(player, finance));
      if (res.selection === 3) nextForm(() => showETransfer(player, finance, card.accountId));
      if (res.selection === 4) nextForm(() => showDirectDepositMenu(player, finance));
      if (res.selection === 5) nextForm(() => showTransactionHistory(player, finance, card.accountId));
    });
}


function showAccountList(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  const form = new ActionFormData().title("Accounts");
  if (!accounts.length) { form.body("§cNone").button("OK").show(player); return; }
  for (const a of accounts) {
    const inst = finance.getInstitution(a.institutionId);
    const bal = a.type === "credit"
      ? `owed ${finance.formatMoney(a.balance)}${a.overdue ? " OVERDUE" : ""}`
      : finance.formatMoney(a.balance);
    form.button(`${inst?.name || a.institutionId}\n${a.type} · ${bal}`);
  }
  form.button("Back").show(player);
}

function pickAccountForm(player, finance, title, thenFn) {
  const accounts = finance.getPlayerAccounts(player.name);
  if (!accounts.length) { player.sendMessage("§cNo accounts"); return; }
  const form = new ActionFormData().title(title);
  for (const a of accounts) {
    const inst = finance.getInstitution(a.institutionId);
    form.button(`${inst?.name || a.institutionId}\n${a.type} · ${a.id}`);
  }
  form.show(player).then((res) => {
    if (res.canceled) return;
    const acc = accounts[res.selection];
    if (acc) nextForm(() => thenFn(acc));
  });
}

function showInternalTransfer(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  if (accounts.length < 2) { player.sendMessage("§cNeed 2+ accounts"); return; }
  const form = new ActionFormData().title("From");
  for (const a of accounts) form.button(`${a.type} ${a.id}`);
  form.show(player).then((res) => {
    if (res.canceled) return;
    const from = accounts[res.selection];
    nextForm(() => {
      const others = accounts.filter((a) => a.id !== from.id);
      const form2 = new ActionFormData().title("To");
      for (const a of others) form2.button(`${a.type} ${a.id}`);
      form2.show(player).then((res2) => {
        if (res2.canceled) return;
        const to = others[res2.selection];
        nextForm(() => {
          new ModalFormData().title("Amount").textField("CAD", "50").show(player).then((res3) => {
            if (res3.canceled) return;
            const amount = parseAmount(res3.formValues[0]);
            if (amount == null) { player.sendMessage("§cInvalid amount"); return; }
            const r = finance.transferInternal(from.id, to.id, amount);
            player.sendMessage(r.ok ? "§aOK" : `§c${r.error}`);
          });
        });
      });
    });
  });
}

function showETransfer(player, finance, presetFromId) {
  const start = (fromAcc) => {
    new ModalFormData().title("Interac e-Transfer")
      .textField("Recipient phone", "4165551234")
      .textField("Amount CAD", "25")
      .textField("Message", "optional")
      .textField("Security question", "pet name?")
      .textField("Security answer", "")
      .show(player).then((res) => {
        if (res.canceled) return;
        const amount = parseAmount(res.formValues[1]);
        if (amount == null) { player.sendMessage("§cInvalid amount"); return; }
        const r = finance.sendETransfer(fromAcc.id, res.formValues[0], amount,
          res.formValues[2], player.name, res.formValues[3], res.formValues[4]);
        if (!r.ok) player.sendMessage(`§c${r.error}`);
        else player.sendMessage(r.recipientPlayer ? `§aSent to §f${r.recipientPlayer}` : "§ePending — answer required to claim");
      });
  };
  if (presetFromId) {
    const acc = finance.getAccount(presetFromId);
    if (acc) start(acc);
  } else pickAccountForm(player, finance, "e-Transfer from", start);
}

function showPendingTransfers(player, finance) {
  const list = finance.getPendingTransfersFor(player.name);
  const form = new ActionFormData().title("Pending e-Transfers");
  if (!list.length) { form.body("§7None").button("OK").show(player); return; }
  for (const t of list) form.button(`§a${finance.formatMoney(t.amount)} §7from ${t.fromOwner}\n§8${t.toPhone}`);
  form.show(player).then((res) => {
    if (res.canceled) return;
    const t = list[res.selection];
    if (!t) return;
    nextForm(() => {
      if (t.securityAnswer) {
        new ModalFormData().title("Security").textField(t.securityQuestion || "Answer", "").show(player).then((r) => {
          if (r.canceled) return;
          nextForm(() => acceptTransferToAccount(player, finance, t, r.formValues[0]));
        });
      } else acceptTransferToAccount(player, finance, t, "");
    });
  });
}

function acceptTransferToAccount(player, finance, t, answer) {
  pickAccountForm(player, finance, "Deposit to", (acc) => {
    const r = finance.acceptETransfer(t.id, acc.id, player.name, answer);
    player.sendMessage(r.ok ? `§aAccepted` : `§c${r.error}`);
  });
}

function showTeller(player, finance) {
  new ActionFormData().title("Teller Terminal").body("§7Full service")
    .button("Open Chequing").button("Open Savings").button("Open Business Chequing")
    .button("Open Business Savings").button("Open Credit").button("My Accounts")
    .button("Issue cheque").button("Direct deposit").button("Block cost")
    .button("Tax GST/HST").button("Currency CAD/USD").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 11) return;
      const types = ["chequing", "savings", "business_chequing", "business_savings", "credit"];
      if (res.selection <= 4) nextForm(() => showPickInstitution(player, finance, types[res.selection]));
      if (res.selection === 5) nextForm(() => showAccountList(player, finance));
      if (res.selection === 6) nextForm(() => showIssueCheque(player, finance));
      if (res.selection === 7) nextForm(() => showDirectDepositMenu(player, finance));
      if (res.selection === 8) {
        if (!isAdmin(player)) { player.sendMessage("§cOps only (or tag financecore_admin)"); return; }
        nextForm(() => showBlockCostAdmin(player, finance));
      }
      if (res.selection === 9) {
        if (!isAdmin(player)) { player.sendMessage("§cOps only (or tag financecore_admin)"); return; }
        nextForm(() => showTaxSettings(player, finance));
      }
      if (res.selection === 10) {
        if (!isAdmin(player)) { player.sendMessage("§cOps only (or tag financecore_admin)"); return; }
        nextForm(() => showCurrencySettings(player, finance));
      }
    });
}

function showPickInstitution(player, finance, type) {
  const insts = finance.listInstitutions();
  const form = new ActionFormData().title("Institution");
  for (const i of insts) form.button(`${i.name}\n§8${i.type}`);
  form.show(player).then((res) => {
    if (res.canceled) return;
    const inst = insts[res.selection];
    if (!inst) return;
    if (type.startsWith("business")) {
      nextForm(() => {
        new ModalFormData().title("Business name").textField("Name", "Shop Inc").show(player).then((r2) => {
          if (r2.canceled) return;
          const o = finance.openAccount(player.name, inst.id, type, r2.formValues[0] || "Biz");
          player.sendMessage(o.ok ? `§aOpened` : `§c${o.error}`);
        });
      });
    } else {
      const o = finance.openAccount(player.name, inst.id, type);
      player.sendMessage(o.ok ? `§aOpened at ${inst.name}` : `§c${o.error}`);
    }
  });
}

function showIssueCheque(player, finance) {
  pickAccountForm(player, finance, "Cheque from", (acc) => {
    new ModalFormData().title("Cheque").textField("Pay to", "Name").textField("Amount", "100").textField("Memo", "")
      .show(player).then((res) => {
        if (res.canceled) return;
        const amount = parseAmount(res.formValues[1]);
        if (amount == null) { player.sendMessage("§cInvalid amount"); return; }
        const r = finance.issueCheque(acc.id, player.name, res.formValues[0], amount, res.formValues[2]);
        if (!r.ok) { player.sendMessage(`§c${r.error}`); return; }
        const chq = r.cheque;
        try {
          const stack = new ItemStack("financecore:cheque", 1);
          stack.nameTag = `Cheque ${finance.formatMoney(chq.amount)}`;
          stack.setLore([
            `§7Pay to: §f${chq.payTo || "—"}`,
            `§7Amount: §a${finance.formatMoney(chq.amount)}`,
            `§8${chq.id}`,
            chq.memo ? `§7${chq.memo}` : "§8—"
          ]);
          const inv = player.getComponent("inventory")?.container;
          if (inv) {
            const left = inv.addItem(stack);
            if (left) player.dimension.spawnItem(left, player.location);
          } else {
            player.runCommandAsync(`give @s financecore:cheque 1`);
          }
        } catch (e) {
          player.runCommandAsync(`give @s financecore:cheque 1`);
          console.warn("[FinanceCore] cheque item", e);
        }
        player.sendMessage(`§aCheque §f${chq.id} §afor ${finance.formatMoney(chq.amount)}`);
      });
  });
}


function showDirectDepositMenu(player, finance) {
  new ActionFormData()
    .title("Direct deposit")
    .body("Set up payroll deposit or view the form your employer needs")
    .button("Employer form (routing details)")
    .button("Schedule recurring deposit")
    .button("Run deposit now")
    .button("My schedules")
    .button("Back")
    .show(player)
    .then((res) => {
      if (res.canceled || res.selection === 4) return;
      if (res.selection === 0) nextForm(() => showEmployerDepositInfo(player, finance));
      if (res.selection === 1) {
        nextForm(() => {
          pickAccountForm(player, finance, "Deposit into", (toAcc) => {
            nextForm(() => {
              new ModalFormData()
                .title("Recurring direct deposit")
                .textField("Amount", "1200")
                .textField("Source label", "Employer payroll")
                .textField("Memo", "Pay")
                .show(player)
                .then((r) => {
                  if (r.canceled) return;
                  const amount = parseAmount(r.formValues[0]);
                  if (amount == null) {
                    player.sendMessage("Invalid amount");
                    return;
                  }
                  const out = finance.scheduleDirectDeposit(
                    player.name,
                    toAcc.id,
                    amount,
                    24,
                    r.formValues[1] || "Payroll",
                    null
                  );
                  player.sendMessage(out.ok ? "Scheduled " + (out.id || out.dd?.id) : String(out.error));
                  const info = finance.getEmployerDepositInfo(toAcc.id);
                  if (info) {
                    player.sendMessage("§7Give your employer:");
                    player.sendMessage("§f" + info.bankName);
                    player.sendMessage("§7Transit §f" + info.transitNumber + " §7Inst §f" + info.institutionNumber);
                    player.sendMessage("§7Account §f" + info.accountNumber);
                  }
                });
            });
          });
        });
      }
      if (res.selection === 2) {
        nextForm(() => {
          pickAccountForm(player, finance, "Deposit into", (toAcc) => {
            nextForm(() => {
              new ModalFormData()
                .title("One-time direct deposit")
                .textField("Amount", "500")
                .textField("Source", "Payroll")
                .show(player)
                .then((r) => {
                  if (r.canceled) return;
                  const amount = parseAmount(r.formValues[0]);
                  if (amount == null) {
                    player.sendMessage("Invalid amount");
                    return;
                  }
                  const out = finance.directDeposit(
                    toAcc.id,
                    amount,
                    r.formValues[1] || "Direct Deposit",
                    "",
                    null
                  );
                  player.sendMessage(out.ok ? "Deposited " + finance.formatMoney(amount) : String(out.error));
                });
            });
          });
        });
      }
      if (res.selection === 3) {
        const list = finance.listDirectDeposits(player.name);
        const f = new ActionFormData().title("Schedules");
        if (!list.length) f.body("None").button("OK");
        else
          for (const d of list)
            f.button(d.id + "\n" + finance.formatMoney(d.amount) + " → " + d.toAccountId);
        f.show(player);
      }
    });
}

function showEmployerDepositInfo(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name).filter((a) => a.type !== "credit");
  if (!accounts.length) {
    player.sendMessage("No chequing/savings account. Open one at a Teller.");
    return;
  }
  const form = new ActionFormData()
    .title("Employer deposit form")
    .body("Pick the account to show on your payroll form");
  for (const a of accounts) {
    const inst = finance.getInstitution(a.institutionId);
    form.button((inst ? inst.name : a.institutionId) + "\n" + a.type + " " + a.id);
  }
  form.button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === accounts.length) return;
    const acc = accounts[res.selection];
    const info = finance.getEmployerDepositInfo(acc.id);
    if (!info) {
      player.sendMessage("Could not build deposit info");
      return;
    }
    const body =
      "§lBanking details for payroll§r\n\n" +
      "§7Account holder§r\n§f" +
      info.accountHolder +
      "\n\n§7Bank§r\n§f" +
      info.bankName +
      "\n\n§7Account type§r\n§f" +
      info.accountType +
      "\n\n§7Transit (branch)§r\n§f" +
      info.transitNumber +
      "\n\n§7Institution number§r\n§f" +
      info.institutionNumber +
      "\n\n§7Account number§r\n§f" +
      info.accountNumber +
      "\n\n§7Combined (transit-inst-account)§r\n§f" +
      info.paddedFormat +
      "\n\n§8Give these exact numbers to your employer / payroll.";
    new ActionFormData()
      .title("Direct deposit form")
      .body(body)
      .button("Copy to chat")
      .button("Transaction history")
      .button("Done")
      .show(player)
      .then((r2) => {
        if (r2.canceled || r2.selection === 2) return;
        if (r2.selection === 0) {
          player.sendMessage("§l§aEmployer direct deposit");
          player.sendMessage("§7Bank: §f" + info.bankName);
          player.sendMessage("§7Holder: §f" + info.accountHolder);
          player.sendMessage("§7Type: §f" + info.accountType);
          player.sendMessage("§7Transit: §f" + info.transitNumber);
          player.sendMessage("§7Institution: §f" + info.institutionNumber);
          player.sendMessage("§7Account: §f" + info.accountNumber);
          player.sendMessage("§7Format: §f" + info.paddedFormat);
        }
        if (r2.selection === 1) nextForm(() => showTransactionHistory(player, finance, acc.id));
      });
  });
}

function showPickAccountHistory(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  if (!accounts.length) {
    player.sendMessage("No accounts");
    return;
  }
  const form = new ActionFormData().title("History — pick account");
  for (const a of accounts) {
    const inst = finance.getInstitution(a.institutionId);
    form.button((inst ? inst.name : "") + "\n" + a.type + " " + finance.formatMoney(a.balance));
  }
  form.button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === accounts.length) return;
    nextForm(() => showTransactionHistory(player, finance, accounts[res.selection].id));
  });
}

function showTransactionHistory(player, finance, accountId) {
  const acc = finance.getAccount(accountId);
  if (!acc) {
    player.sendMessage("Account not found");
    return;
  }
  const rows = finance.getTransactionHistory(accountId, 15);
  const inst = finance.getInstitution(acc.institutionId);
  let body = "§7" + (inst ? inst.name : "") + " §f" + acc.id + "\n§7Bal " + finance.formatMoney(acc.balance) + "\n\n";
  if (!rows.length) {
    body += "§8No transactions yet.";
  } else {
    for (const e of rows) {
      const amt = e.amount != null ? finance.formatMoney(Math.abs(e.amount)) : "";
      const sign = e.amount != null && e.amount < 0 ? "-" : "+";
      const when = e.at ? new Date(e.at).toISOString().slice(0, 16).replace("T", " ") : "";
      const note = e.note || e.type || e.merchant || e.source || "";
      body += "§f" + sign + amt + " §7" + note + (when ? "\n§8" + when : "") + "\n";
    }
  }
  new ActionFormData()
    .title("Transactions")
    .body(body.slice(0, 900))
    .button("Employer deposit info")
    .button("Done")
    .show(player)
    .then((res) => {
      if (res.canceled || res.selection === 1) return;
      if (res.selection === 0) nextForm(() => showEmployerDepositInfo(player, finance));
    });
}


function showBlockCostAdmin(player, finance) {
  new ModalFormData().title("Block cost").textField("CAD (0=off)", String(finance.settings.costPerBlock || 0))
    .show(player).then((res) => {
      if (res.canceled) return;
      const v = Number(res.formValues[0]);
      finance.settings.costPerBlock = Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : 0;
      finance.save();
      player.sendMessage("§aSaved");
    });
}

function showTaxSettings(player, finance) {
  new ModalFormData().title("Tax")
    .textField("GST", String(finance.settings.gstRate ?? 0.05))
    .textField("HST", String(finance.settings.hstRate ?? 0.13))
    .textField("Use HST? yes/no", finance.settings.useHst ? "yes" : "no")
    .show(player).then((res) => {
      if (res.canceled) return;
      finance.settings.gstRate = parseFloat(res.formValues[0]) || 0;
      finance.settings.hstRate = parseFloat(res.formValues[1]) || 0;
      finance.settings.useHst = String(res.formValues[2]).toLowerCase().startsWith("y");
      finance.save();
      player.sendMessage("§aTax saved");
    });
}

function showEmbosser(player, finance) {
  if (!finance.playerHasBlankCard(player)) {
    player.sendMessage("§cNeed a Blank Card in inventory");
    return;
  }
  const accounts = finance.getPlayerAccounts(player.name);
  if (!accounts.length) { player.sendMessage("§cOpen an account first"); return; }
  new ActionFormData().title("Card Embosser").body("§7Consumes 1 blank card")
    .button("Debit").button("Credit").button("Business").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 3) return;
      const kind = ["debit", "credit", "business"][res.selection];
      nextForm(() => {
        const form2 = new ActionFormData().title("Account");
        for (const a of accounts) {
          const inst = finance.getInstitution(a.institutionId);
          form2.button(`${inst?.name || a.institutionId}\n${a.type}`);
        }
        form2.show(player).then((res2) => {
          if (res2.canceled) return;
          const acc = accounts[res2.selection];
          nextForm(() => {
            new ModalFormData().title("PIN").textField("4 digits", "1234").show(player).then((res3) => {
              if (res3.canceled) return;
              const r = finance.embossCard(player, acc.id, kind, res3.formValues[0]);
              player.sendMessage(r.ok ? `§a••${r.card.last4} §7${r.card.id}` : `§c${r.error}`);
            });
          });
        });
      });
    });
}

function showPOS(player, finance) {
  new ActionFormData().title("POS").body(`§7${finance.settings.useHst ? "HST" : "GST"}`)
    .button("Register merchant").button("Charge card").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 2) return;
      if (res.selection === 0) nextForm(() => registerMerchantFlow(player, finance));
      if (res.selection === 1) nextForm(() => chargeCardFlow(player, finance));
    });
}

function registerMerchantFlow(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  if (!accounts.length) { player.sendMessage("§cNeed account"); return; }
  new ModalFormData().title("Merchant").textField("Name", "Shop").show(player).then((res) => {
    if (res.canceled) return;
    const name = res.formValues[0] || "Shop";
    nextForm(() => {
      const form = new ActionFormData().title("Settlement");
      for (const a of accounts) form.button(`${a.type} ${a.id}`);
      form.show(player).then((res2) => {
        if (res2.canceled) return;
        const r = finance.registerMerchant(player.name, name, accounts[res2.selection].id);
        player.sendMessage(r.ok ? "§aRegistered" : `§c${r.error}`);
      });
    });
  });
}

function chargeCardFlow(player, finance) {
  const merchants = [...finance.merchants.values()].filter((m) => m.owner === player.name);
  if (!merchants.length) { player.sendMessage("§cRegister first"); return; }
  const form = new ActionFormData().title("Merchant");
  for (const m of merchants) form.button(m.name);
  form.show(player).then((res) => {
    if (res.canceled) return;
    const m = merchants[res.selection];
    nextForm(() => {
      const held = finance.getHeldCardId(player);
      new ModalFormData().title("Charge").textField("Customer card id", held || "card_4001").textField("PIN", "1234").textField("Amount", "12.50")
        .show(player).then((res2) => {
          if (res2.canceled) return;
          let cardId = String(res2.formValues[0] || "").trim() || held;
          const card = finance.getCard(cardId);
          if (!card) { player.sendMessage("§cCard not found"); return; }
          // Customer must be online (cardholder present)
          const holderOnline = world.getAllPlayers().some((p) => p.name === card.owner);
          if (!holderOnline) { player.sendMessage("§cCardholder must be online"); return; }
          const amount = parseAmount(res2.formValues[2]);
          if (amount == null) { player.sendMessage("§cInvalid amount"); return; }
          const r = finance.posCharge(m.id, cardId, res2.formValues[1], amount, true);
          player.sendMessage(r.ok ? `§a${finance.formatMoney(r.total)} (tax ${finance.formatMoney(r.tax)})` : `§c${r.error}`);
        });
    });
  });
}

function showDrawer(player, finance, block) {
  const key = `${block.dimension.id}:${block.x},${block.y},${block.z}`;
  let d = finance.drawers.get(key) || finance.registerDrawer(block.x, block.y, block.z, block.dimension.id, "rbc", 500);
  new ActionFormData().title("Cash Drawer").body(`§7Float: §a${finance.formatMoney(d.cash)}`)
    .button("Deposit tender from inventory")
    .button("Withdraw $50 tender")
    .button("Adjust +100 (admin count)")
    .button("Adjust -50 (admin count)")
    .button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 4) return;
      if (res.selection === 0) {
        const r = finance.drawerDepositTender(key, player);
        player.sendMessage(r.ok ? `§aDeposited ${finance.formatMoney(r.deposited)}` : `§c${r.error}`);
      } else if (res.selection === 1) {
        const r = finance.drawerWithdrawTender(key, player, 50);
        player.sendMessage(r.ok ? "§aWithdrew $50.00 CAD tender" : `§c${r.error}`);
      } else if (res.selection === 2) {
        d.cash = Math.round((d.cash + 100) * 100) / 100;
        finance.save();
        player.sendMessage(`§aFloat ${finance.formatMoney(d.cash)}`);
      } else if (res.selection === 3) {
        d.cash = Math.round(Math.max(0, d.cash - 50) * 100) / 100;
        finance.save();
        player.sendMessage(`§aFloat ${finance.formatMoney(d.cash)}`);
      }
    });
}

function showVault(player, finance, block) {
  const key = `${block.dimension.id}:${block.x},${block.y},${block.z}`;
  let v = finance.vaults.get(key) || finance.registerVault(block.x, block.y, block.z, block.dimension.id, "rbc", 0);
  new ActionFormData().title("Vault").body(`§7Cash: §a${finance.formatMoney(v.cash)}`)
    .button("Deposit tender from inventory")
    .button("Withdraw $100 tender")
    .button("Adjust +500")
    .button("Adjust -500")
    .button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 4) return;
      if (res.selection === 0) {
        const r = finance.vaultDepositTender(key, player);
        player.sendMessage(r.ok ? `§aDeposited ${finance.formatMoney(r.deposited)}` : `§c${r.error}`);
      } else if (res.selection === 1) {
        const r = finance.vaultWithdrawTender(key, player, 100);
        player.sendMessage(r.ok ? "§aWithdrew $100.00 CAD tender" : `§c${r.error}`);
      } else if (res.selection === 2) {
        v.cash = Math.round((v.cash + 500) * 100) / 100;
        finance.save();
        player.sendMessage(`§a${finance.formatMoney(v.cash)}`);
      } else if (res.selection === 3) {
        v.cash = Math.round(Math.max(0, v.cash - 500) * 100) / 100;
        finance.save();
        player.sendMessage(`§a${finance.formatMoney(v.cash)}`);
      }
    });
}


function showCurrencySettings(player, finance) {
  const cur = finance.getCurrency();
  new ActionFormData().title("Currency")
    .body(`§7World tender currency: §a${cur}\n§8Affects ATM cash in/out`)
    .button("CAD (Canadian)").button("USD (US)").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 2) return;
      const code = res.selection === 0 ? "CAD" : "USD";
      finance.setCurrency(code);
      player.sendMessage(`§aCurrency set to ${code}`);
    });
}





