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


export function setupUIHandlers(finance) {
  world.afterEvents.itemUse.subscribe((event) => {
    const item = event.itemStack;
    if (!item) return;
    const id = item.typeId;
    const player = event.source;
    if (id === "financecore:bank_book") nextForm(() => showBankBook(player, finance));
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
      "financecore:atm": () => showATM(player, finance),
      "financecore:teller_terminal": () => showTeller(player, finance),
      "financecore:card_embosser": () => showEmbosser(player, finance),
      "financecore:pos_terminal": () => showPOS(player, finance),
      "financecore:cash_drawer": () => showDrawer(player, finance, block),
      "financecore:vault": () => showVault(player, finance, block)
    };
    if (map[id]) { event.cancel = true; nextForm(map[id]); }
  });

  try {
    world.beforeEvents.playerPlaceBlock.subscribe((event) => {
      const player = event.player;
      if (!player || !finance.settings.costPerBlock) return;
      const r = finance.tryChargeBlockPlace(player.name);
      if (!r.ok) { event.cancel = true; player.sendMessage(`§c${r.error}`); }
    });
  } catch (e) {}
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
    .button("Pending e-Transfers").button("Register my phone").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 2) return;
      if (res.selection === 0) nextForm(() => showPendingTransfers(player, finance));
      if (res.selection === 1) nextForm(() => showRegisterPhone(player, finance));
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

function showATM(player, finance) {
  new ActionFormData().title("ATM").body("§7Insert card · Interac · CAD tender")
    .button("Use card (PIN)").button("My accounts").button("Pending e-Transfers").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 3) return;
      if (res.selection === 0) nextForm(() => showATMCardSession(player, finance));
      if (res.selection === 1) nextForm(() => showAccountList(player, finance));
      if (res.selection === 2) nextForm(() => showPendingTransfers(player, finance));
    });
}

function showATMCardSession(player, finance) {
  new ModalFormData().title("Insert card").textField("Card id (id:card_…)", "card_4001").textField("PIN", "****")
    .show(player).then((res) => {
      if (res.canceled) return;
      const cardId = String(res.formValues[0]).trim();
      const card = finance.getCard(cardId);
      if (!card) { player.sendMessage("§cCard not found"); return; }
      if (card.owner !== player.name) { player.sendMessage("§cThis card is not yours"); return; }
      if (card.status !== "active") { player.sendMessage(`§cCard is ${card.status}`); return; }
      if (!finance.verifyPin(cardId, res.formValues[1])) { player.sendMessage("§cInvalid PIN"); return; }
      nextForm(() => showATMOps(player, finance, card));
    });
}

function showATMOps(player, finance, card) {
  const acc = finance.getAccount(card.accountId);
  const bal = acc?.type === "credit" ? `owed ${finance.formatMoney(acc.balance)}` : finance.formatMoney(acc?.balance ?? 0);
  new ActionFormData().title(`ATM · ••${card.last4}`).body(`§7${card.institutionName}\n§a${bal}`)
    .button("Withdraw cash").button("Deposit cash").button("Transfer").button("e-Transfer")
    .button("Direct deposit").button("Done")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 5) return;
      if (res.selection === 0) nextForm(() => {
        new ModalFormData().title("Withdraw").textField("Amount CAD", "40").show(player).then((r) => {
          if (r.canceled) return;
          const amount = parseAmount(r.formValues[0]);
          if (amount == null) { player.sendMessage("§cInvalid amount"); return; }
          const out = finance.withdrawCash(card.accountId, amount, player);
          player.sendMessage(out.ok ? `§aDispensed` : `§c${out.error}`);
        });
      });
      if (res.selection === 1) nextForm(() => {
        const held = finance.countInventoryCash(player);
        new ModalFormData().title("Deposit cash").textField(`Amount (hold ${held.toFixed(2)})`, String(held || 20))
          .show(player).then((r) => {
            if (r.canceled) return;
            const amount = parseAmount(r.formValues[0]);
            if (amount == null) { player.sendMessage("§cInvalid amount"); return; }
            const out = finance.depositCash(card.accountId, player, amount);
            player.sendMessage(out.ok ? `§aDeposited` : `§c${out.error}`);
          });
      });
      if (res.selection === 2) nextForm(() => showInternalTransfer(player, finance));
      if (res.selection === 3) nextForm(() => showETransfer(player, finance, card.accountId));
      if (res.selection === 4) nextForm(() => showDirectDepositMenu(player, finance));
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
    .button("Tax GST/HST").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 10) return;
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
  new ActionFormData().title("Direct Deposit")
    .button("One-time").button("Schedule recurring").button("My schedules").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 3) return;
      if (res.selection === 0) nextForm(() => pickAccountForm(player, finance, "To", (acc) => {
        new ModalFormData().title("DD").textField("Amount", "500").textField("Source", "Payroll")
          .show(player).then((r) => {
            if (r.canceled) return;
            const amount = parseAmount(r.formValues[0]);
            if (amount == null) { player.sendMessage("§cInvalid amount"); return; }
            const out = finance.directDeposit(acc.id, amount, r.formValues[1] || "Payroll");
            player.sendMessage(out.ok ? "§aDeposited" : `§c${out.error}`);
          });
      }));
      if (res.selection === 1) nextForm(() => pickAccountForm(player, finance, "To", (acc) => {
        new ModalFormData().title("Recurring").textField("Amount", "500").textField("Hours", "24").textField("Source", "Payroll")
          .show(player).then((r) => {
            if (r.canceled) return;
            const amount = parseAmount(r.formValues[0]);
            if (amount == null) { player.sendMessage("§cInvalid amount"); return; }
            const hours = Number(r.formValues[1]);
            if (!Number.isFinite(hours) || hours <= 0) { player.sendMessage("§cInvalid interval"); return; }
            const out = finance.scheduleDirectDeposit(player.name, acc.id, amount, hours, r.formValues[2] || "Payroll");
            player.sendMessage(out.ok ? `§aScheduled ${out.dd.id}` : `§c${out.error}`);
          });
      }));
      if (res.selection === 2) {
        const list = finance.listDirectDeposits(player.name);
        const f = new ActionFormData().title("Schedules");
        if (!list.length) f.body("§7None").button("OK");
        else for (const d of list) f.button(`${d.id}\n${finance.formatMoney(d.amount)}`);
        f.show(player);
      }
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
      new ModalFormData().title("Charge").textField("Card id", "card_4001").textField("PIN", "1234").textField("Amount", "12.50")
        .show(player).then((res2) => {
          if (res2.canceled) return;
          const cardId = String(res2.formValues[0]).trim();
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
  new ActionFormData().title("Cash Drawer").body(`§a${finance.formatMoney(d.cash)}`)
    .button("+100").button("-50").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 2) return;
      d.cash = Math.round(Math.max(0, d.cash + (res.selection === 0 ? 100 : -50)) * 100) / 100;
      finance.save();
      player.sendMessage(`§a${finance.formatMoney(d.cash)}`);
    });
}

function showVault(player, finance, block) {
  const key = `${block.dimension.id}:${block.x},${block.y},${block.z}`;
  let v = finance.vaults.get(key) || finance.registerVault(block.x, block.y, block.z, block.dimension.id, "rbc", 0);
  new ActionFormData().title("Vault").body(`§a${finance.formatMoney(v.cash)}`)
    .button("+500").button("-500").button("Close")
    .show(player).then((res) => {
      if (res.canceled || res.selection === 2) return;
      v.cash = Math.round(Math.max(0, v.cash + (res.selection === 0 ? 500 : -500)) * 100) / 100;
      finance.save();
      player.sendMessage(`§a${finance.formatMoney(v.cash)}`);
    });
}
