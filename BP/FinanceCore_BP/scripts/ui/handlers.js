import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { system, world } from "@minecraft/server";

function nextForm(fn) {
  system.run(() => {
    try {
      fn();
    } catch (e) {
      console.warn("[FinanceCore] form error:", e);
    }
  });
}

export function setupUIHandlers(finance) {
  world.afterEvents.itemUse.subscribe((event) => {
    const item = event.itemStack;
    if (!item) return;
    const id = item.typeId;
    const player = event.source;
    if (id === "financecore:bank_book") {
      nextForm(() => showBankBook(player, finance));
    } else if (
      id === "financecore:debit_card" ||
      id === "financecore:credit_card" ||
      id === "financecore:business_card"
    ) {
      nextForm(() => showCardInfo(player, finance, item));
    }
  });

  world.afterEvents.playerInteractWithBlock.subscribe((event) => {
    const block = event.block;
    if (!block) return;
    const id = block.typeId;
    const player = event.player;
    if (id === "financecore:atm") {
      event.cancel = true;
      nextForm(() => showATM(player, finance));
    } else if (id === "financecore:teller_terminal") {
      event.cancel = true;
      nextForm(() => showTeller(player, finance));
    } else if (id === "financecore:card_embosser") {
      event.cancel = true;
      nextForm(() => showEmbosser(player, finance));
    } else if (id === "financecore:pos_terminal") {
      event.cancel = true;
      nextForm(() => showPOS(player, finance));
    } else if (id === "financecore:cash_drawer") {
      event.cancel = true;
      nextForm(() => showDrawer(player, finance, block));
    } else if (id === "financecore:vault") {
      event.cancel = true;
      nextForm(() => showVault(player, finance, block));
    }
  });

  // Cost per block
  world.beforeEvents.playerPlaceBlock?.subscribe?.((event) => {
    try {
      const player = event.player;
      if (!player || !finance.settings.costPerBlock) return;
      const r = finance.tryChargeBlockPlace(player.name);
      if (!r.ok) {
        event.cancel = true;
        player.sendMessage(`§c${r.error} (§7${finance.formatMoney(finance.settings.costPerBlock)}§c per block)`);
      }
    } catch (e) {
      /* ignore if event missing on build */
    }
  });
}

// ---------- Bank book ----------
function showBankBook(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  const form = new ActionFormData()
    .title("Bank Book")
    .body(
      accounts.length
        ? accounts
            .map((a) => {
              const inst = finance.getInstitution(a.institutionId);
              const label = a.type === "credit" ? `owed ${finance.formatMoney(a.balance)}` : finance.formatMoney(a.balance);
              return `§e${inst ? inst.name : a.institutionId}\n§7${a.type} §f${a.id}\n§a${label}`;
            })
            .join("\n\n")
        : "§7No accounts yet. Visit a Teller Terminal."
    )
    .button("Refresh")
    .button("Pending e-Transfers")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled) return;
    if (res.selection === 0) nextForm(() => showBankBook(player, finance));
    if (res.selection === 1) nextForm(() => showPendingTransfers(player, finance));
  });
}

function showCardInfo(player, finance, item) {
  const lore = item.getLore?.() || [];
  const body = lore.length ? lore.join("\n") : "§7Card not linked. Use a Card Embosser at your bank.";
  new ActionFormData().title("Card").body(body).button("OK").show(player);
}

// ---------- ATM ----------
function showATM(player, finance) {
  const form = new ActionFormData()
    .title("ATM")
    .body("§7Interac Debit · CAD tender dispensed as bills & coins")
    .button("My Accounts")
    .button("Withdraw cash")
    .button("Deposit cash")
    .button("Transfer (my accounts)")
    .button("e-Transfer")
    .button("Direct deposit")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 6) return;
    if (res.selection === 0) nextForm(() => showAccountList(player, finance));
    if (res.selection === 1) nextForm(() => showWithdrawCash(player, finance));
    if (res.selection === 2) nextForm(() => showDepositCash(player, finance));
    if (res.selection === 3) nextForm(() => showInternalTransfer(player, finance));
    if (res.selection === 4) nextForm(() => showETransfer(player, finance));
    if (res.selection === 5) nextForm(() => showDirectDeposit(player, finance));
  });
}

function showAccountList(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  const form = new ActionFormData().title("Accounts").body("§7Your open accounts");
  if (!accounts.length) {
    form.body("§cNo accounts. Open one at a Teller.").button("OK");
    form.show(player);
    return;
  }
  for (const a of accounts) {
    const inst = finance.getInstitution(a.institutionId);
    const bal =
      a.type === "credit"
        ? `limit ${finance.formatMoney(a.limit)} · owed ${finance.formatMoney(a.balance)}`
        : finance.formatMoney(a.balance);
    form.button(`${inst?.name || a.institutionId}\n${a.type} · ${bal}`);
  }
  form.button("Back");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === accounts.length) nextForm(() => showATM(player, finance));
  });
}

function pickAccountForm(player, finance, title, thenFn) {
  const accounts = finance.getPlayerAccounts(player.name);
  if (!accounts.length) {
    player.sendMessage("§cNo accounts.");
    return;
  }
  const form = new ActionFormData().title(title).body("§7Select account");
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

function showWithdraw(player, finance) {
  pickAccountForm(player, finance, "Withdraw", (acc) => {
    const modal = new ModalFormData().title("Withdraw").textField("Amount CAD", "e.g. 40");
    modal.show(player).then((res) => {
      if (res.canceled) return;
      const amount = parseFloat(res.formValues[0]);
      const r = finance.withdraw(acc.id, amount);
      player.sendMessage(r.ok ? `§aWithdrew ${finance.formatMoney(amount)}. Balance ${finance.formatMoney(r.balance)}` : `§c${r.error}`);
    });
  });
}

function showDeposit(player, finance) {
  pickAccountForm(player, finance, "Deposit", (acc) => {
    const modal = new ModalFormData().title("Deposit").textField("Amount CAD", "e.g. 100");
    modal.show(player).then((res) => {
      if (res.canceled) return;
      const amount = parseFloat(res.formValues[0]);
      const r = finance.deposit(acc.id, amount);
      player.sendMessage(r.ok ? `§aDeposited ${finance.formatMoney(amount)}. Balance ${finance.formatMoney(r.balance)}` : `§c${r.error}`);
    });
  });
}

function showInternalTransfer(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  if (accounts.length < 2) {
    player.sendMessage("§cNeed at least 2 accounts.");
    return;
  }
  const form = new ActionFormData().title("From account");
  for (const a of accounts) form.button(`${a.type} ${a.id}`);
  form.show(player).then((res) => {
    if (res.canceled) return;
    const from = accounts[res.selection];
    nextForm(() => {
      const form2 = new ActionFormData().title("To account");
      const others = accounts.filter((a) => a.id !== from.id);
      for (const a of others) form2.button(`${a.type} ${a.id}`);
      form2.show(player).then((res2) => {
        if (res2.canceled) return;
        const to = others[res2.selection];
        nextForm(() => {
          const modal = new ModalFormData().title("Amount").textField("CAD", "50");
          modal.show(player).then((res3) => {
            if (res3.canceled) return;
            const amount = parseFloat(res3.formValues[0]);
            const r = finance.transferInternal(from.id, to.id, amount);
            player.sendMessage(r.ok ? `§aTransferred ${finance.formatMoney(amount)}` : `§c${r.error}`);
          });
        });
      });
    });
  });
}

function showETransfer(player, finance) {
  pickAccountForm(player, finance, "e-Transfer from", (acc) => {
    const modal = new ModalFormData()
      .title("Interac e-Transfer")
      .textField("Recipient phone", "e.g. 4165551234")
      .textField("Amount CAD", "25")
      .textField("Message", "optional");
    modal.show(player).then((res) => {
      if (res.canceled) return;
      const phone = res.formValues[0];
      const amount = parseFloat(res.formValues[1]);
      const msg = res.formValues[2] || "";
      const r = finance.sendETransfer(acc.id, phone, amount, msg, player.name);
      if (!r.ok) {
        player.sendMessage(`§c${r.error}`);
        return;
      }
      if (r.recipientPlayer) {
        player.sendMessage(`§a e-Transfer sent to §f${r.recipientPlayer} §7(${phone})`);
        try {
          const dest = world.getPlayers().find((p) => p.name === r.recipientPlayer);
          dest?.sendMessage(`§aYou have an e-Transfer from §f${player.name}§a for ${finance.formatMoney(amount)}. Open Bank Book.`);
        } catch (e) {}
      } else {
        player.sendMessage(
          `§e e-Transfer pending — phone §f${phone} §7not resolved (enable CarrierCore SIMs or recipient accepts unmatched).`
        );
      }
    });
  });
}

function showPendingTransfers(player, finance) {
  const list = finance.getPendingTransfersFor(player.name);
  const form = new ActionFormData().title("Pending e-Transfers");
  if (!list.length) {
    form.body("§7None").button("OK");
    form.show(player);
    return;
  }
  for (const t of list) {
    form.button(`§a${finance.formatMoney(t.amount)} §7from ${t.fromOwner}\n§8${t.toPhone}`);
  }
  form.show(player).then((res) => {
    if (res.canceled) return;
    const t = list[res.selection];
    if (!t) return;
    nextForm(() => {
      pickAccountForm(player, finance, "Deposit to", (acc) => {
        const r = finance.acceptETransfer(t.id, acc.id, player.name);
        player.sendMessage(r.ok ? `§aAccepted ${finance.formatMoney(t.amount)}` : `§c${r.error}`);
      });
    });
  });
}

// ---------- Teller ----------
function showTeller(player, finance) {
  const form = new ActionFormData()
    .title("Teller Terminal")
    .body("§7Open accounts · manage · business")
    .button("Open Chequing")
    .button("Open Savings")
    .button("Open Business Chequing")
    .button("Open Business Savings")
    .button("Open Credit Account")
    .button("My Accounts")
    .button("Direct deposit")
    .button("Set block cost (admin)")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 8) return;
    if (res.selection === 5) nextForm(() => showAccountList(player, finance));
    else if (res.selection === 6) nextForm(() => showDirectDeposit(player, finance));
    else if (res.selection === 7) nextForm(() => showBlockCostAdmin(player, finance));
    else {
      const types = ["chequing", "savings", "business_chequing", "business_savings", "credit"];
      const type = types[res.selection];
      nextForm(() => showPickInstitution(player, finance, type));
    }
  });
}

function showPickInstitution(player, finance, type) {
  const insts = finance.listInstitutions();
  const form = new ActionFormData().title("Choose institution").body("§7Banks & credit unions");
  for (const i of insts) {
    form.button(`${i.name}\n§8${i.type} · routing ${i.routing}`);
  }
  form.show(player).then((res) => {
    if (res.canceled) return;
    const inst = insts[res.selection];
    if (!inst) return;
    if (type.startsWith("business")) {
      nextForm(() => {
        const modal = new ModalFormData().title("Business name").textField("Legal / trade name", "My Shop Inc.");
        modal.show(player).then((r2) => {
          if (r2.canceled) return;
          const name = r2.formValues[0] || `${player.name} Business`;
          const opened = finance.openAccount(player.name, inst.id, type, name);
          player.sendMessage(
            opened.ok
              ? `§aOpened ${type} at §f${inst.name}§a — ${opened.account.id}`
              : `§c${opened.error}`
          );
        });
      });
    } else {
      const opened = finance.openAccount(player.name, inst.id, type);
      player.sendMessage(
        opened.ok
          ? `§aOpened ${type} at §f${inst.name}§a — ${opened.account.id}`
          : `§c${opened.error}`
      );
    }
  });
}

function showBlockCostAdmin(player, finance) {
  const modal = new ModalFormData()
    .title("Cost per block")
    .textField("CAD (0 = off)", String(finance.settings.costPerBlock || 0));
  modal.show(player).then((res) => {
    if (res.canceled) return;
    const v = parseFloat(res.formValues[0]);
    finance.settings.costPerBlock = isNaN(v) ? 0 : Math.max(0, v);
    finance.save();
    player.sendMessage(`§aBlock cost set to ${finance.formatMoney(finance.settings.costPerBlock)}`);
  });
}

// ---------- Embosser ----------
function showEmbosser(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  if (!accounts.length) {
    player.sendMessage("§cOpen an account at a Teller first.");
    return;
  }
  const form = new ActionFormData()
    .title("Card Embosser")
    .body("§7Insert blank card · link account · set PIN")
    .button("Emboss Debit Card")
    .button("Emboss Credit Card")
    .button("Emboss Business Card")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 3) return;
    const kinds = ["debit", "credit", "business"];
    const kind = kinds[res.selection];
    nextForm(() => {
      const form2 = new ActionFormData().title("Link account");
      for (const a of accounts) {
        const inst = finance.getInstitution(a.institutionId);
        form2.button(`${inst?.name || a.institutionId}\n${a.type} ${a.id}`);
      }
      form2.show(player).then((res2) => {
        if (res2.canceled) return;
        const acc = accounts[res2.selection];
        nextForm(() => {
          const modal = new ModalFormData().title("Set PIN").textField("4-digit PIN", "1234");
          modal.show(player).then((res3) => {
            if (res3.canceled) return;
            const pin = res3.formValues[0];
            const r = finance.embossCard(player.name, acc.id, kind, pin);
            if (!r.ok) {
              player.sendMessage(`§c${r.error}`);
              return;
            }
            const card = r.card;
            const itemId =
              kind === "credit"
                ? "financecore:credit_card"
                : kind === "business"
                  ? "financecore:business_card"
                  : "financecore:debit_card";
            try {
              const inv = player.getComponent("inventory")?.container;
              // prefer replacing blank card if held
              const stack = player.getComponent("inventory");
              player.runCommandAsync(
                `give @s ${itemId} 1`
              );
              player.sendMessage(
                `§aEmbossed §f${card.institutionName} §a••••${card.last4} (${kind})`
              );
              player.sendMessage(`§7Card id ${card.id} — keep your PIN safe.`);
            } catch (e) {
              player.sendMessage(`§aCard record ${card.id} created (••••${card.last4}). Give yourself ${itemId}.`);
            }
          });
        });
      });
    });
  });
}

// ---------- POS ----------
function showPOS(player, finance) {
  const form = new ActionFormData()
    .title("POS Terminal")
    .body("§7Merchant payments")
    .button("Register as merchant")
    .button("Charge card")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return;
    if (res.selection === 0) nextForm(() => registerMerchantFlow(player, finance));
    if (res.selection === 1) nextForm(() => chargeCardFlow(player, finance));
  });
}

function registerMerchantFlow(player, finance) {
  const accounts = finance.getPlayerAccounts(player.name);
  if (!accounts.length) {
    player.sendMessage("§cNeed an account.");
    return;
  }
  const modal = new ModalFormData().title("Merchant").textField("Business display name", "Shop");
  modal.show(player).then((res) => {
    if (res.canceled) return;
    const name = res.formValues[0] || "Shop";
    nextForm(() => {
      const form = new ActionFormData().title("Settlement account");
      for (const a of accounts) form.button(`${a.type} ${a.id}`);
      form.show(player).then((res2) => {
        if (res2.canceled) return;
        const acc = accounts[res2.selection];
        const r = finance.registerMerchant(player.name, name, acc.id);
        player.sendMessage(r.ok ? `§aMerchant §f${name} §aregistered (${r.merchant.id})` : `§c${r.error}`);
      });
    });
  });
}

function chargeCardFlow(player, finance) {
  const merchants = [...finance.merchants.values()].filter((m) => m.owner === player.name);
  if (!merchants.length) {
    player.sendMessage("§cRegister as merchant first.");
    return;
  }
  const form = new ActionFormData().title("Your merchant");
  for (const m of merchants) form.button(m.name);
  form.show(player).then((res) => {
    if (res.canceled) return;
    const m = merchants[res.selection];
    nextForm(() => {
      const modal = new ModalFormData()
        .title("Charge")
        .textField("Customer card id (card_XXXX)", "card_4001")
        .textField("PIN", "1234")
        .textField("Amount CAD", "12.50");
      modal.show(player).then((res2) => {
        if (res2.canceled) return;
        const cardId = res2.formValues[0];
        const pin = res2.formValues[1];
        const amount = parseFloat(res2.formValues[2]);
        const r = finance.posCharge(m.id, cardId, pin, amount);
        player.sendMessage(r.ok ? `§aCharged ${finance.formatMoney(amount)}` : `§c${r.error}`);
      });
    });
  });
}

// ---------- Drawer / Vault ----------
function showDrawer(player, finance, block) {
  const dim = block.dimension.id;
  const key = `${dim}:${block.x},${block.y},${block.z}`;
  let d = finance.drawers.get(key);
  if (!d) {
    d = finance.registerDrawer(block.x, block.y, block.z, dim, "rbc", 500);
  }
  const form = new ActionFormData()
    .title("Cash Drawer")
    .body(`§7On hand: §a${finance.formatMoney(d.cash)}`)
    .button("Add float (+100)")
    .button("Remove (50)")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return;
    if (res.selection === 0) {
      d.cash = Math.round((d.cash + 100) * 100) / 100;
      finance.save();
      player.sendMessage(`§aFloat ${finance.formatMoney(d.cash)}`);
    }
    if (res.selection === 1) {
      d.cash = Math.max(0, Math.round((d.cash - 50) * 100) / 100);
      finance.save();
      player.sendMessage(`§aFloat ${finance.formatMoney(d.cash)}`);
    }
  });
}

function showVault(player, finance, block) {
  const dim = block.dimension.id;
  const key = `${dim}:${block.x},${block.y},${block.z}`;
  let v = finance.vaults.get(key);
  if (!v) {
    v = finance.registerVault(block.x, block.y, block.z, dim, "rbc", 0);
  }
  const form = new ActionFormData()
    .title("Bank Vault")
    .body(`§7Vault cash: §a${finance.formatMoney(v.cash)}`)
    .button("Deposit 500 to vault")
    .button("Withdraw 500 from vault")
    .button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return;
    if (res.selection === 0) {
      v.cash = Math.round((v.cash + 500) * 100) / 100;
      finance.save();
      player.sendMessage(`§aVault ${finance.formatMoney(v.cash)}`);
    }
    if (res.selection === 1) {
      v.cash = Math.max(0, Math.round((v.cash - 500) * 100) / 100);
      finance.save();
      player.sendMessage(`§aVault ${finance.formatMoney(v.cash)}`);
    }
  });
}
