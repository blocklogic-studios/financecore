import { world, system, ItemStack, EquipmentSlot } from "@minecraft/server";

const DEFAULT_INSTITUTIONS = [
  { id: "rbc", name: "RBC Royal Bank", type: "bank", routing: "0003" },
  { id: "td", name: "TD Canada Trust", type: "bank", routing: "0004" },
  { id: "scotiabank", name: "Scotiabank", type: "bank", routing: "0002" },
  { id: "bmo", name: "BMO Bank of Montreal", type: "bank", routing: "0001" },
  { id: "cibc", name: "CIBC", type: "bank", routing: "0010" },
  { id: "national", name: "National Bank", type: "bank", routing: "0006" },
  { id: "desjardins", name: "Desjardins", type: "credit_union", routing: "0815" },
  { id: "vancity", name: "Vancity", type: "credit_union", routing: "0809" },
  { id: "servus", name: "Servus Credit Union", type: "credit_union", routing: "0839" },
  { id: "coastcapital", name: "Coast Capital", type: "credit_union", routing: "0802" },
  { id: "tangerine", name: "Tangerine", type: "bank", routing: "0614" },
  { id: "eqbank", name: "EQ Bank", type: "bank", routing: "0627" }
];

const TENDER_CAD = {
  "financecore:bill_5": 5,
  "financecore:bill_10": 10,
  "financecore:bill_20": 20,
  "financecore:bill_50": 50,
  "financecore:bill_100": 100,
  "financecore:coin_nickel": 0.05,
  "financecore:coin_dime": 0.1,
  "financecore:coin_quarter": 0.25,
  "financecore:coin_loonie": 1,
  "financecore:coin_toonie": 2
};

const TENDER_USD = {
  "financecore:usd_bill_100": 100,
  "financecore:usd_bill_50": 50,
  "financecore:usd_bill_20": 20,
  "financecore:usd_bill_10": 10,
  "financecore:usd_bill_5": 5,
  "financecore:usd_bill_1": 1,
  "financecore:usd_coin_dollar": 1,
  "financecore:usd_coin_half": 0.5,
  "financecore:usd_coin_quarter": 0.25,
  "financecore:usd_coin_dime": 0.1,
  "financecore:usd_coin_nickel": 0.05,
  "financecore:usd_coin_penny": 0.01
};

const TENDER = { ...TENDER_CAD, ...TENDER_USD };

const DISPENSE_ORDER_CAD = [
  ["financecore:bill_100", 100],
  ["financecore:bill_50", 50],
  ["financecore:bill_20", 20],
  ["financecore:bill_10", 10],
  ["financecore:bill_5", 5],
  ["financecore:coin_toonie", 2],
  ["financecore:coin_loonie", 1],
  ["financecore:coin_quarter", 0.25],
  ["financecore:coin_dime", 0.1],
  ["financecore:coin_nickel", 0.05]
];

const DISPENSE_ORDER_USD = [
  ["financecore:usd_bill_100", 100],
  ["financecore:usd_bill_50", 50],
  ["financecore:usd_bill_20", 20],
  ["financecore:usd_bill_10", 10],
  ["financecore:usd_bill_5", 5],
  ["financecore:usd_bill_1", 1],
  ["financecore:usd_coin_dollar", 1],
  ["financecore:usd_coin_half", 0.5],
  ["financecore:usd_coin_quarter", 0.25],
  ["financecore:usd_coin_dime", 0.1],
  ["financecore:usd_coin_nickel", 0.05],
  ["financecore:usd_coin_penny", 0.01]
];

const DISPENSE_ORDER = DISPENSE_ORDER_CAD;

const CARRIER_PLANS = [
  { id: "basic_talk", name: "Basic Talk", price: 25, dataGb: 0, talkMin: 200, desc: "Talk-focused prepaid" },
  { id: "basic_data", name: "Basic Data 5GB", price: 35, dataGb: 5, talkMin: 100, desc: "Light data prepaid" },
  { id: "plus_15", name: "Plus 15GB", price: 55, dataGb: 15, talkMin: 500, desc: "Everyday plan" },
  { id: "unlimited", name: "Unlimited", price: 85, dataGb: 50, talkMin: 9999, desc: "Heavy use" },
  { id: "business_fleet", name: "Business Fleet", price: 120, dataGb: 40, talkMin: 2000, desc: "Business lines" }
];

const ACCOUNT_TYPES = {
  chequing: { label: "Chequing", interest: 0 },
  savings: { label: "Savings", interest: 0.0001 },
  business_chequing: { label: "Business Chequing", interest: 0 },
  business_savings: { label: "Business Savings", interest: 0.00008 }
};

/** Ticks ~1 day for credit statement (configurable feel) */
const STATEMENT_INTERVAL = 24000;
const ETRANSFER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export class FinanceManager {
  constructor() {
    this.institutions = new Map();
    this.accounts = new Map();
    this.cards = new Map();
    this.transfers = [];
    this.merchants = new Map();
    this.vaults = new Map();
    this.drawers = new Map();
    this.directDeposits = new Map(); // id -> recurring DD
    this.cheques = new Map();
    this.phoneAliases = new Map(); // phone digits -> playerName (local)
    this.atms = new Map(); // dim:x,y,z -> { institutionId, color, networks, label }
    this.nextIds = {
      account: 1000,
      card: 4000,
      transfer: 1,
      merchant: 1,
      dd: 1,
      cheque: 1000
    };
    this.settings = {
      costPerBlock: 0,
      currency: "CAD", // CAD | USD
      etransferFee: 0,
      gstRate: 0.05,
      hstRate: 0.13,
      useHst: false,
      fxUsdToCad: 1.35 // display helper when mixing
    };
    this.plans = new Map(); // phone -> plan purchase records

    this._tick = 0;
  }

  load() {
    try {
      const raw = world.getDynamicProperty("financecore:state");
      if (raw && typeof raw === "string") {
        const data = JSON.parse(raw);
        this.nextIds = { ...this.nextIds, ...(data.nextIds || {}) };
        this.settings = { ...this.settings, ...(data.settings || {}) };
        if (data.institutions) this.institutions = new Map(data.institutions);
        if (data.accounts) this.accounts = new Map(data.accounts);
        if (data.cards) this.cards = new Map(data.cards);
        if (data.transfers) this.transfers = data.transfers;
        if (data.merchants) this.merchants = new Map(data.merchants);
        if (data.vaults) this.vaults = new Map(data.vaults);
        if (data.drawers) this.drawers = new Map(data.drawers);
        if (data.directDeposits) this.directDeposits = new Map(data.directDeposits);
        if (data.cheques) this.cheques = new Map(data.cheques);
        if (data.phoneAliases) this.phoneAliases = new Map(data.phoneAliases);
        if (data.plans) this.plans = new Map(data.plans);
        if (data.atms) this.atms = new Map(data.atms);
      }
    } catch (e) {
      console.warn("[FinanceCore] load:", e);
    }
    if (this.institutions.size === 0) {
      for (const inst of DEFAULT_INSTITUTIONS) {
        this.institutions.set(inst.id, {
          ...inst,
          staff: [],
          creditProducts: {
            personal: { limitDefault: 2000, apr: 0.1999, name: "Personal Credit" },
            business: { limitDefault: 15000, apr: 0.1499, name: "Business Credit" }
          }
        });
      }
      this.save();
    }
    console.log(
      `[FinanceCore] ${this.institutions.size} institutions, ${this.accounts.size} accounts, ${this.cards.size} cards`
    );
  }

  save() {
    try {
      const data = {
        nextIds: this.nextIds,
        settings: this.settings,
        institutions: [...this.institutions.entries()],
        accounts: [...this.accounts.entries()],
        cards: [...this.cards.entries()],
        transfers: this.transfers.slice(-100),
        merchants: [...this.merchants.entries()],
        vaults: [...this.vaults.entries()],
        drawers: [...this.drawers.entries()],
        directDeposits: [...this.directDeposits.entries()],
        cheques: [...this.cheques.entries()],
        phoneAliases: [...this.phoneAliases.entries()],
        plans: [...this.plans.entries()],
        atms: [...this.atms.entries()]
      };
      world.setDynamicProperty("financecore:state", JSON.stringify(data));
    } catch (e) {
      console.warn("[FinanceCore] save:", e);
    }
  }

  tick() {
    this._tick++;
    // Interest ~ every 10 min, scaled so ~1 real day ≈ 1 day of APR
    // 12000 ticks ≈ 10 min → 144 intervals/day → rate = daily/144
    if (this._tick % 12000 === 0) {
      for (const [, acc] of this.accounts) {
        const meta = ACCOUNT_TYPES[acc.type];
        if (meta?.interest > 0 && acc.balance > 0 && acc.type !== "credit") {
          // meta.interest was tuned as a small per-interval bump; scale similarly
          const perInterval = meta.interest / 144;
          acc.balance = round2(acc.balance * (1 + perInterval));
        }
        if (acc.type === "credit" && acc.balance > 0) {
          const daily = (acc.apr || 0.1999) / 365;
          const perInterval = daily / 144;
          acc.balance = round2(acc.balance * (1 + perInterval));
        }
      }
      this.save();
    }
    // Credit statement cycle
    if (this._tick % STATEMENT_INTERVAL === 0) {
      for (const [, acc] of this.accounts) {
        if (acc.type !== "credit" || acc.status !== "open") continue;
        const owed = round2(acc.balance || 0);
        // Never require more than what's owed; if under $10, min = full balance
        let minPay = 0;
        if (owed > 0) {
          minPay = owed < 10 ? owed : round2(Math.max(10, owed * 0.03));
          if (minPay > owed) minPay = owed;
        }
        acc.statementBalance = owed;
        acc.minPayment = minPay;
        acc.statementAt = Date.now();
        if (acc.lastMinDue && owed > 0 && (acc.paidTowardStatement || 0) < acc.lastMinDue) {
          acc.overdue = true;
        } else {
          acc.overdue = false;
        }
        acc.lastMinDue = minPay;
        acc.paidTowardStatement = 0;
      }
      this.save();
    }
    // Recurring direct deposits every 20 ticks check schedule
    if (this._tick % 20 === 0) {
      const now = Date.now();
      for (const [, dd] of this.directDeposits) {
        if (!dd.active) continue;
        if (now >= (dd.nextAt || 0)) {
          const r = this.directDeposit(dd.toAccountId, dd.amount, dd.source || "Payroll", dd.memo || "", dd.fromAccountId || null);
          if (r.ok) {
            dd.nextAt = now + (dd.intervalMs || 24 * 60 * 60 * 1000);
            dd.lastAt = now;
            dd.lastOk = true;
          } else {
            dd.lastOk = false;
            dd.lastError = r.error;
          }
        }
      }
      // Expire e-transfers
      for (const t of this.transfers) {
        if (
          (t.status === "pending" || t.status === "pending_unresolved") &&
          t.createdAt &&
          now - t.createdAt > ETRANSFER_EXPIRY_MS
        ) {
          const fromAcc = t.fromAccountId ? this.accounts.get(t.fromAccountId) : null;
          if (fromAcc && fromAcc.status === "open" && t.amount) {
            this.deposit(t.fromAccountId, round2(t.amount + (t.fee || 0)));
            t.refunded = true;
          } else {
            t.refunded = false;
            t.refundError = "Source account closed or missing";
          }
          t.status = "expired";
        }
      }
      this.save();
    }
  }

  listInstitutions() {
    return [...this.institutions.values()];
  }

  getInstitution(id) {
    return this.institutions.get(id);
  }

  // ---------- Accounts ----------
  openAccount(playerName, institutionId, type = "chequing", businessName = null) {
    const inst = this.institutions.get(institutionId);
    if (!inst) return { ok: false, error: "Unknown institution" };
    if (!ACCOUNT_TYPES[type] && type !== "credit") return { ok: false, error: "Invalid account type" };
    const id = `acc_${this.nextIds.account++}`;
    const isBiz = type.startsWith("business") || !!businessName;
    const acc = {
      id,
      institutionId,
      type,
      owner: playerName,
      businessName: businessName || null,
      balance: 0,
      limit: type === "credit" ? (isBiz ? 15000 : 2000) : 0,
      apr: type === "credit" ? (isBiz ? 0.1499 : 0.1999) : 0,
      status: "open",
      createdAt: Date.now(),
      statementBalance: 0,
      minPayment: 0,
      overdue: false,
      paidTowardStatement: 0,
      ledger: []
    };
    this.accounts.set(id, acc);
    this.save();
    return { ok: true, account: acc };
  }

  getPlayerAccounts(playerName) {
    return [...this.accounts.values()].filter((a) => a.owner === playerName && a.status === "open");
  }

  getAccount(id) {
    return this.accounts.get(id);
  }

  deposit(accountId, amount) {
    const acc = this.accounts.get(accountId);
    if (!acc || acc.status !== "open") return { ok: false, error: "Account not found" };
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    if (acc.type === "credit") {
      const before = acc.balance;
      acc.balance = round2(Math.max(0, acc.balance - amount));
      const applied = round2(before - acc.balance);
      acc.paidTowardStatement = round2((acc.paidTowardStatement || 0) + applied);
      if (acc.balance <= 0) {
        acc.balance = 0;
        acc.overdue = false;
        acc.paidTowardStatement = acc.lastMinDue || 0;
      } else if (acc.overdue && (acc.paidTowardStatement || 0) >= (acc.lastMinDue || 0)) {
        acc.overdue = false;
      }
    } else {
      acc.balance = round2(acc.balance + amount);
    }
    this.save();
    return { ok: true, balance: acc.balance };
  }

  withdraw(accountId, amount) {
    const acc = this.accounts.get(accountId);
    if (!acc || acc.status !== "open") return { ok: false, error: "Account not found" };
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    if (acc.type === "credit") {
      if (acc.overdue) return { ok: false, error: "Card overdue — pay minimum first" };
      if (acc.balance + amount > acc.limit) return { ok: false, error: "Over credit limit" };
      acc.balance = round2(acc.balance + amount);
    } else {
      if (acc.balance < amount) return { ok: false, error: "Insufficient funds" };
      acc.balance = round2(acc.balance - amount);
    }
    this.save();
    return { ok: true, balance: acc.balance };
  }

  transferInternal(fromId, toId, amount) {
    const w = this.withdraw(fromId, amount);
    if (!w.ok) return w;
    const d = this.deposit(toId, amount);
    if (!d.ok) {
      this.deposit(fromId, amount);
      return d;
    }
    return { ok: true };
  }

  // ---------- Cards ----------
  playerHasBlankCard(player) {
    try {
      const inv = player.getComponent("inventory")?.container;
      if (!inv) return false;
      for (let i = 0; i < inv.size; i++) {
        const it = inv.getItem(i);
        if (it && it.typeId === "financecore:blank_card" && it.amount > 0) return true;
      }
    } catch (e) {}
    return false;
  }

  consumeBlankCard(player) {
    try {
      const inv = player.getComponent("inventory")?.container;
      if (!inv) return false;
      for (let i = 0; i < inv.size; i++) {
        const it = inv.getItem(i);
        if (!it || it.typeId !== "financecore:blank_card") continue;
        if (it.amount <= 1) inv.setItem(i, undefined);
        else {
          it.amount -= 1;
          inv.setItem(i, it);
        }
        return true;
      }
    } catch (e) {}
    return false;
  }

  embossCard(player, accountId, cardType, pin) {
    const playerName = player.name;
    const acc = this.accounts.get(accountId);
    if (!acc || acc.owner !== playerName) return { ok: false, error: "Account not found" };
    if (!this.playerHasBlankCard(player)) return { ok: false, error: "Need a blank card in inventory" };
    if (!["debit", "credit", "business"].includes(cardType)) {
      return { ok: false, error: "Invalid card type" };
    }
    let linkAccountId = accountId;
    if (cardType === "credit" && acc.type !== "credit") {
      // Business source account → business credit limits; else personal
      const isBiz =
        !!acc.businessName ||
        (typeof acc.type === "string" && acc.type.startsWith("business"));
      const opened = this.openAccount(
        playerName,
        acc.institutionId,
        "credit",
        isBiz ? acc.businessName || `${playerName} Business` : null
      );
      if (!opened.ok) return opened;
      linkAccountId = opened.account.id;
    }
    const pinStr = String(pin || "0000").replace(/\D/g, "").padStart(4, "0").slice(0, 4);
    if (pinStr.length !== 4) return { ok: false, error: "PIN must be 4 digits" };
    if (!this.consumeBlankCard(player)) return { ok: false, error: "Could not consume blank card" };

    const id = `card_${this.nextIds.card++}`;
    const last4 = String(this.nextIds.card).slice(-4).padStart(4, "0");
    const inst = this.institutions.get(acc.institutionId);
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 3);
    const expStr = `${String(expiry.getMonth() + 1).padStart(2, "0")}/${String(expiry.getFullYear()).slice(-2)}`;

    const card = {
      id,
      accountId: linkAccountId,
      owner: playerName,
      type: cardType === "business" ? "debit" : cardType,
      isBusiness: cardType === "business" || !!acc.businessName,
      institutionId: acc.institutionId,
      institutionName: inst ? inst.name : acc.institutionId,
      last4,
      pin: pinStr,
      status: "active",
      expiry: expStr,
      createdAt: Date.now()
    };
    this.cards.set(id, card);
    this.save();

    const itemId =
      cardType === "credit"
        ? "financecore:credit_card"
        : cardType === "business"
          ? "financecore:business_card"
          : "financecore:debit_card";

    const lore = [
      `§8${card.institutionName}`,
      `§7•••• •••• •••• ${card.last4}`,
      `§8Exp ${card.expiry}`,
      `§7id:${card.id}`
    ];

    try {
      const stack = new ItemStack(itemId, 1);
      stack.setLore(lore);
      stack.nameTag = `${card.institutionName} ••${card.last4}`;
      const inv = player.getComponent("inventory")?.container;
      if (inv) {
        const leftover = inv.addItem(stack);
        if (leftover) player.dimension.spawnItem(leftover, player.location);
      } else {
        player.runCommandAsync(`give @s ${itemId} 1`);
      }
    } catch (e) {
      player.runCommandAsync(`give @s ${itemId} 1`);
    }

    return { ok: true, card, itemId };
  }

  parseCardIdFromItem(item) {
    if (!item) return null;
    try {
      const lore = item.getLore?.() || [];
      for (const line of lore) {
        const m = String(line).match(/id:(card_\d+)/);
        if (m) return m[1];
      }
      const name = item.nameTag || "";
      const m2 = name.match(/card_\d+/);
      if (m2) return m2[0];
    } catch (e) {}
    return null;
  }

  getCard(cardId) {
    return this.cards.get(cardId);
  }

  getPlayerCards(playerName) {
    return [...this.cards.values()].filter((c) => c.owner === playerName);
  }


  /** Read card id from held or offhand item lore */
  getHeldCardId(player) {
    try {
      const equip = player.getComponent("equippable");
      if (equip) {
        const slots = [];
        const slotList = [];
        try { slotList.push(EquipmentSlot.Mainhand, EquipmentSlot.Offhand); } catch (e) {
          slotList.push("Mainhand", "Offhand");
        }
        for (const slot of slotList) {
          try {
            const it = equip.getEquipment(slot);
            if (!it) continue;
            if (
              it.typeId === "financecore:debit_card" ||
              it.typeId === "financecore:credit_card" ||
              it.typeId === "financecore:business_card"
            ) {
              const id = this.parseCardIdFromItem(it);
              if (id) return id;
            }
          } catch (e) {}
        }
      }
      // Fallback: scan hotbar for a card (first found)
      try {
        const inv = player.getComponent("inventory")?.container;
        if (inv) {
          for (let i = 0; i < 9; i++) {
            const it = inv.getItem(i);
            if (!it) continue;
            if (
              it.typeId === "financecore:debit_card" ||
              it.typeId === "financecore:credit_card" ||
              it.typeId === "financecore:business_card"
            ) {
              const id = this.parseCardIdFromItem(it);
              if (id) return id;
            }
          }
        }
      } catch (e) {}
    } catch (e) {}
    return null;
  }

  getHeldChequeId(player) {
    try {
      const equip = player.getComponent("equippable");
      if (equip) {
        for (const slot of ["Mainhand", "Offhand"]) {
          try {
            const it = equip.getEquipment(slot);
            if (!it || it.typeId !== "financecore:cheque") continue;
            const lore = it.getLore?.() || [];
            for (const line of lore) {
              const m = String(line).match(/chq_\d+/);
              if (m) return m[0];
            }
            if (it.nameTag) {
              const m = String(it.nameTag).match(/chq_\d+/);
              if (m) return m[0];
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    return null;
  }

  isCardOwnedBy(cardId, playerName) {
    const card = this.cards.get(cardId);
    return !!(card && card.owner === playerName);
  }

    isCardExpired(card) {
    if (!card || !card.expiry) return false;
    try {
      const [mm, yy] = String(card.expiry).split("/");
      const expMonth = parseInt(mm, 10);
      const expYear = 2000 + parseInt(yy, 10);
      if (!expMonth || !expYear) return false;
      const now = new Date();
      // expires end of month
      if (now.getFullYear() > expYear) return true;
      if (now.getFullYear() === expYear && now.getMonth() + 1 > expMonth) return true;
    } catch (e) {}
    return false;
  }

  verifyPin(cardId, pin) {
    const card = this.cards.get(cardId);
    if (!card) return { ok: false, error: "Card not found" };
    if (card.status === "frozen") return { ok: false, error: "Card frozen" };
    if (card.status === "lost") return { ok: false, error: "Card reported lost" };
    if (card.status === "locked") return { ok: false, error: "Card locked — too many wrong PINs" };
    if (card.status !== "active") return { ok: false, error: "Card not active" };
    if (this.isCardExpired(card)) return { ok: false, error: "Card expired" };
    const ok = card.pin === String(pin).replace(/\D/g, "").padStart(4, "0").slice(0, 4);
    if (!ok) {
      card.pinFails = (card.pinFails || 0) + 1;
      if (card.pinFails >= 3) {
        card.status = "locked";
        this.save();
        return { ok: false, error: "Card locked after 3 wrong PINs" };
      }
      this.save();
      return { ok: false, error: `Invalid PIN (${card.pinFails}/3)` };
    }
    card.pinFails = 0;
    this.save();
    return { ok: true };
  }

  changePin(cardId, ownerName, oldPin, newPin) {
    const card = this.cards.get(cardId);
    if (!card || card.owner !== ownerName) return { ok: false, error: "Card not found" };
    const pinCheck = this.verifyPin(cardId, oldPin);
    if (!pinCheck.ok) return { ok: false, error: pinCheck.error || "Wrong PIN" };
    const n = String(newPin).replace(/\D/g, "").padStart(4, "0").slice(0, 4);
    if (n.length !== 4) return { ok: false, error: "PIN must be 4 digits" };
    card.pin = n;
    this.save();
    return { ok: true };
  }

  setCardStatus(cardId, ownerName, status) {
    const card = this.cards.get(cardId);
    if (!card || card.owner !== ownerName) return { ok: false, error: "Card not found" };
    if (!["active", "frozen", "lost", "locked"].includes(status)) return { ok: false, error: "Invalid status" };
    card.status = status;
    if (status === "active") card.pinFails = 0;
    this.save();
    return { ok: true };
  }

  // ---------- Tender ----------

  getCurrency() {
    return (this.settings.currency || "CAD").toUpperCase() === "USD" ? "USD" : "CAD";
  }

  setCurrency(code) {
    const c = String(code || "CAD").toUpperCase();
    this.settings.currency = c === "USD" ? "USD" : "CAD";
    this.save();
    return this.settings.currency;
  }

  getDispenseOrder() {
    return this.getCurrency() === "USD" ? DISPENSE_ORDER_USD : DISPENSE_ORDER_CAD;
  }

  getTenderMap() {
    return this.getCurrency() === "USD" ? TENDER_USD : TENDER_CAD;
  }

  isCarrierCorePresent() {
    try {
      const raw = world.getDynamicProperty("carriercore:network");
      return !!(raw && typeof raw === "string");
    } catch (e) {
      return false;
    }
  }

  listCarrierPlans() {
    return CARRIER_PLANS.slice();
  }

  /** currency: "CAD" | "USD" | "ALL" (default ALL for deposits) */
  getTenderMapFor(currency = "ALL") {
    if (currency === "CAD") return TENDER_CAD;
    if (currency === "USD") return TENDER_USD;
    return TENDER; // both
  }

  getDispenseOrderFor(currency = "ALL") {
    if (currency === "CAD") return DISPENSE_ORDER_CAD;
    if (currency === "USD") return DISPENSE_ORDER_USD;
    // Merge both, largest denomination first
    return [...DISPENSE_ORDER_CAD, ...DISPENSE_ORDER_USD].sort((a, b) => b[1] - a[1]);
  }

  countInventoryCash(player, currency = "ALL") {
    let total = 0;
    const map = this.getTenderMapFor(currency);
    try {
      const inv = player.getComponent("inventory")?.container;
      if (!inv) return 0;
      for (let i = 0; i < inv.size; i++) {
        const it = inv.getItem(i);
        if (!it) continue;
        const v = map[it.typeId];
        if (v) total += v * it.amount;
      }
    } catch (e) {}
    return round2(total);
  }

  countInventoryCashSplit(player) {
    return {
      cad: this.countInventoryCash(player, "CAD"),
      usd: this.countInventoryCash(player, "USD"),
      total: this.countInventoryCash(player, "ALL")
    };
  }

  takeTenderFromPlayer(player, amount, currency = "ALL") {
    amount = round2(amount);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    let need = amount;
    try {
      const inv = player.getComponent("inventory")?.container;
      if (!inv) return 0;
      for (const [typeId, val] of this.getDispenseOrderFor(currency)) {
        if (need < val - 0.001) continue;
        for (let i = 0; i < inv.size && need >= val - 0.001; i++) {
          const it = inv.getItem(i);
          if (!it || it.typeId !== typeId) continue;
          const canTake = Math.min(it.amount, Math.floor((need + 0.001) / val));
          if (canTake <= 0) continue;
          const left = it.amount - canTake;
          if (left <= 0) inv.setItem(i, undefined);
          else {
            it.amount = left;
            inv.setItem(i, it);
          }
          need = round2(need - canTake * val);
        }
      }
    } catch (e) {
      console.warn("[FinanceCore] takeTender", e);
    }
    return round2(amount - need);
  }

  giveTenderToPlayer(player, amount) {
    amount = round2(amount);
    let left = amount;
    try {
      for (const [typeId, val] of this.getDispenseOrder()) {
        if (left < val - 0.001) continue;
        let n = Math.floor((left + 0.001) / val);
        // Prefer breaking with smaller notes if remainder would be ugly — still greedy OK for game
        if (n <= 0) continue;
        let remain = n;
        while (remain > 0) {
          const qty = Math.min(64, remain);
          try {
            const stack = new ItemStack(typeId, qty);
            const inv = player.getComponent("inventory")?.container;
            if (inv) {
              const leftover = inv.addItem(stack);
              if (leftover) player.dimension.spawnItem(leftover, player.location);
            } else {
              player.runCommandAsync(`give @s ${typeId} ${qty}`);
            }
          } catch (e) {
            player.runCommandAsync(`give @s ${typeId} ${qty}`);
          }
          remain -= qty;
        }
        left = round2(left - n * val);
      }
      // leftover cents as nickels if any
      if (this.getCurrency() === "USD") {
        if (left >= 0.01) {
          const n = Math.floor(left / 0.01);
          if (n > 0) player.runCommandAsync(`give @s financecore:usd_coin_penny ${n}`);
        }
      } else if (left >= 0.05) {
        const n = Math.floor(left / 0.05);
        if (n > 0) player.runCommandAsync(`give @s financecore:coin_nickel ${n}`);
        left = round2(left - n * 0.05);
      }
    } catch (e) {
      console.warn("[FinanceCore] giveTender", e);
    }
    return { remainder: left };
  }

  withdrawCash(accountId, amount, player) {
    const w = this.withdraw(accountId, amount);
    if (!w.ok) return w;
    this.giveTenderToPlayer(player, amount);
    return { ok: true, balance: w.balance, cash: amount };
  }

  depositCash(accountId, player, maxAmount = null, currency = "ALL") {
    const available = this.countInventoryCash(player, currency);
    let amount = available;
    if (maxAmount != null && Number.isFinite(maxAmount)) amount = Math.min(amount, maxAmount);
    amount = round2(amount);
    if (amount <= 0) {
      const split = this.countInventoryCashSplit(player);
      return {
        ok: false,
        error: `No tender in inventory (CAD $${split.cad.toFixed(2)}, USD $${split.usd.toFixed(2)})`
      };
    }
    const taken = this.takeTenderFromPlayer(player, amount, currency);
    if (taken <= 0) return { ok: false, error: "Could not take tender from inventory" };
    const r = this.deposit(accountId, taken);
    if (!r.ok) return r;
    return { ok: true, balance: r.balance, deposited: taken };
  }

  // ---------- e-Transfer ----------
  registerPhoneAlias(playerName, phone) {
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length < 7) return { ok: false, error: "Invalid phone" };
    this.phoneAliases.set(digits, playerName);
    this.save();
    return { ok: true };
  }

  resolvePhoneToPlayer(phone) {
    phone = String(phone).replace(/\D/g, "");
    if (this.phoneAliases.has(phone)) return this.phoneAliases.get(phone);
    for (const [k, v] of this.phoneAliases) {
      if (k.endsWith(phone) || phone.endsWith(k)) return v;
    }
    try {
      const raw = world.getDynamicProperty("carriercore:network");
      if (raw && typeof raw === "string") {
        const data = JSON.parse(raw);
        if (data.sims) {
          const entries = Array.isArray(data.sims) ? data.sims : Object.entries(data.sims || {});
          for (const entry of entries) {
            const sim = Array.isArray(entry) ? entry[1] : entry;
            if (!sim) continue;
            const num = String(sim.number || sim.phone || "").replace(/\D/g, "");
            if (num && (num === phone || num.endsWith(phone) || phone.endsWith(num))) {
              return sim.ownerName || sim.owner || sim.player || null;
            }
          }
        }
      }
    } catch (e) {}
    return null;
  }

  sendETransfer(fromAccountId, toPhone, amount, message, senderName, securityQuestion = "", securityAnswer = "") {
    const from = this.accounts.get(fromAccountId);
    if (!from || from.owner !== senderName) return { ok: false, error: "Account not found" };
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    const fee = this.settings.etransferFee || 0;
    const total = round2(amount + fee);
    const w = this.withdraw(fromAccountId, total);
    if (!w.ok) return w;
    const recipientPlayer = this.resolvePhoneToPlayer(toPhone);
    const id = `et_${this.nextIds.transfer++}`;
    const transfer = {
      id,
      fromAccountId,
      fromOwner: senderName,
      toPhone: String(toPhone).replace(/\D/g, ""),
      toPlayer: recipientPlayer,
      amount,
      fee,
      message: (message || "").slice(0, 80),
      securityQuestion: (securityQuestion || "").slice(0, 60),
      securityAnswer: (securityAnswer || "").toLowerCase().trim().slice(0, 40),
      status: recipientPlayer ? "pending" : "pending_unresolved",
      createdAt: Date.now()
    };
    this.transfers.push(transfer);
    this.save();
    return { ok: true, transfer, recipientPlayer };
  }

  acceptETransfer(transferId, toAccountId, playerName, securityAnswer = "") {
    const t = this.transfers.find((x) => x.id === transferId);
    if (!t || (t.status !== "pending" && t.status !== "pending_unresolved")) {
      return { ok: false, error: "Transfer not found" };
    }
    // Must match resolved player OR unresolved + answer if set
    if (t.toPlayer && t.toPlayer !== playerName) {
      return { ok: false, error: "Not addressed to you" };
    }
    if (!t.toPlayer && t.status === "pending_unresolved") {
      // Must own a phone alias matching destination
      const dest = String(t.toPhone || "").replace(/\D/g, "");
      let phoneMatch = false;
      for (const [phone, owner] of this.phoneAliases) {
        if (owner !== playerName) continue;
        if (phone === dest || phone.endsWith(dest) || dest.endsWith(phone)) {
          phoneMatch = true;
          break;
        }
      }
      if (!phoneMatch) {
        return { ok: false, error: "Not addressed to your phone" };
      }
      if (t.securityAnswer) {
        if (String(securityAnswer).toLowerCase().trim() !== t.securityAnswer) {
          return { ok: false, error: "Wrong security answer" };
        }
      }
    }
    if (t.securityAnswer && t.toPlayer) {
      if (String(securityAnswer).toLowerCase().trim() !== t.securityAnswer) {
        return { ok: false, error: "Wrong security answer" };
      }
    }
    const to = this.accounts.get(toAccountId);
    if (!to || to.owner !== playerName) return { ok: false, error: "Account not found" };
    this.deposit(toAccountId, t.amount);
    t.status = "completed";
    t.toAccountId = toAccountId;
    t.completedAt = Date.now();
    this.save();
    return { ok: true };
  }

  cancelETransfer(transferId, senderName) {
    const t = this.transfers.find((x) => x.id === transferId);
    if (!t || t.fromOwner !== senderName) return { ok: false, error: "Not found" };
    if (t.status !== "pending" && t.status !== "pending_unresolved") {
      return { ok: false, error: "Cannot cancel" };
    }
    this.deposit(t.fromAccountId, round2(t.amount + (t.fee || 0)));
    t.status = "cancelled";
    this.save();
    return { ok: true };
  }

  getPendingTransfersFor(playerName) {
    // Resolve this player's registered phones
    const myPhones = [];
    for (const [phone, owner] of this.phoneAliases) {
      if (owner === playerName) myPhones.push(phone);
    }
    return this.transfers.filter((t) => {
      if (t.status !== "pending" && t.status !== "pending_unresolved") return false;
      // Explicitly addressed to this player
      if (t.toPlayer === playerName) return true;
      // Unresolved: only if their registered phone matches the destination
      if (t.status === "pending_unresolved" && t.toPhone) {
        const dest = String(t.toPhone).replace(/\D/g, "");
        return myPhones.some(
          (p) => p === dest || p.endsWith(dest) || dest.endsWith(p)
        );
      }
      return false;
    });
  }

  // ---------- Direct deposit ----------
  directDeposit(toAccountId, amount, sourceLabel = "Direct Deposit", memo = "", fromAccountId = null) {
    const to = this.accounts.get(toAccountId);
    if (!to || to.status !== "open") return { ok: false, error: "Account not found" };
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    // If source account provided, pull funds from it (real payroll)
    if (fromAccountId) {
      const from = this.accounts.get(fromAccountId);
      if (!from || from.status !== "open") return { ok: false, error: "Source account not found" };
      if (from.id === to.id) return { ok: false, error: "Source and destination must differ" };
      const w = this.withdraw(fromAccountId, amount);
      if (!w.ok) return { ok: false, error: w.error || "Source has insufficient funds" };
    }
    const r = this.deposit(toAccountId, amount);
    if (!r.ok) {
      if (fromAccountId) this.deposit(fromAccountId, amount); // rollback
      return r;
    }
    if (!to.ledger) to.ledger = [];
    to.ledger.push({
      type: "direct_deposit",
      amount,
      source: sourceLabel,
      memo: (memo || "").slice(0, 60),
      fromAccountId: fromAccountId || null,
      at: Date.now()
    });
    if (to.ledger.length > 40) to.ledger = to.ledger.slice(-40);
    this.save();
    return { ok: true, balance: to.balance };
  }

  scheduleDirectDeposit(ownerName, toAccountId, amount, intervalHours, source = "Payroll", fromAccountId = null) {
    const to = this.accounts.get(toAccountId);
    if (!to || to.owner !== ownerName) return { ok: false, error: "Account not found" };
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    if (!fromAccountId) return { ok: false, error: "Source account required for payroll" };
    const from = this.accounts.get(fromAccountId);
    if (!from || from.status !== "open") return { ok: false, error: "Source account not found" };
    if (from.id === to.id) return { ok: false, error: "Source and destination must differ" };
    // Owner must control source OR be admin-scheduled; require same owner for non-op path
    if (from.owner !== ownerName) return { ok: false, error: "You must own the source account" };
    const hours = Math.max(0.25, Number(intervalHours) || 24);
    const id = `dd_${this.nextIds.dd++}`;
    const dd = {
      id,
      owner: ownerName,
      toAccountId,
      fromAccountId,
      amount,
      source,
      intervalMs: hours * 60 * 60 * 1000,
      nextAt: Date.now() + hours * 60 * 60 * 1000,
      active: true
    };
    this.directDeposits.set(id, dd);
    this.save();
    return { ok: true, dd };
  }

  listDirectDeposits(ownerName) {
    return [...this.directDeposits.values()].filter((d) => d.owner === ownerName);
  }

  // ---------- POS + tax ----------
  registerMerchant(playerName, name, accountId) {
    const acc = this.accounts.get(accountId);
    if (!acc || acc.owner !== playerName) return { ok: false, error: "Account not found" };
    const id = `merch_${this.nextIds.merchant++}`;
    const m = { id, name, owner: playerName, accountId, createdAt: Date.now() };
    this.merchants.set(id, m);
    this.save();
    return { ok: true, merchant: m };
  }

  posCharge(merchantId, cardId, pin, amount, applyTax = true) {
    const m = this.merchants.get(merchantId);
    if (!m) return { ok: false, error: "Merchant not found" };
    const card = this.cards.get(cardId);
    if (!card) return { ok: false, error: "Card not found" };
    if (this.isCardExpired(card)) return { ok: false, error: "Card expired" };
    const pinCheck = this.verifyPin(cardId, pin);
    if (!pinCheck.ok) return { ok: false, error: pinCheck.error || "Invalid PIN" };
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    let tax = 0;
    if (applyTax) {
      const rate = this.settings.useHst ? this.settings.hstRate : this.settings.gstRate;
      tax = round2(amount * (rate || 0));
    }
    const total = round2(amount + tax);
    const w = this.withdraw(card.accountId, total);
    if (!w.ok) return w;
    this.deposit(m.accountId, total);
    const payer = this.accounts.get(card.accountId);
    if (payer) {
      if (!payer.ledger) payer.ledger = [];
      payer.ledger.push({
        type: "pos",
        amount: total,
        subtotal: amount,
        tax,
        merchantId: m.id,
        merchant: m.name,
        at: Date.now()
      });
      if (payer.ledger.length > 40) payer.ledger = payer.ledger.slice(-40);
    }
    this.save();
    return { ok: true, subtotal: amount, tax, total };
  }

  // ---------- Cheques ----------
  issueCheque(fromAccountId, ownerName, payTo, amount, memo = "") {
    const from = this.accounts.get(fromAccountId);
    if (!from || from.owner !== ownerName) return { ok: false, error: "Account not found" };
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    // Hold funds
    const w = this.withdraw(fromAccountId, amount);
    if (!w.ok) return w;
    const id = `chq_${this.nextIds.cheque++}`;
    const chq = {
      id,
      fromAccountId,
      owner: ownerName,
      payTo: (payTo || "").slice(0, 40),
      amount,
      memo: (memo || "").slice(0, 40),
      status: "issued",
      createdAt: Date.now()
    };
    this.cheques.set(id, chq);
    this.save();
    return { ok: true, cheque: chq };
  }

  depositCheque(chequeId, toAccountId, playerName) {
    const chq = this.cheques.get(chequeId);
    if (!chq) return { ok: false, error: "Cheque not found" };
    if (chq.status === "cleared") return { ok: false, error: "Cheque already cleared" };
    if (chq.status === "cancelled") return { ok: false, error: "Cheque cancelled" };
    if (chq.status !== "issued") return { ok: false, error: `Cheque status: ${chq.status}` };
    const to = this.accounts.get(toAccountId);
    if (!to || to.owner !== playerName) return { ok: false, error: "Account not found" };
    const r = this.deposit(toAccountId, chq.amount);
    if (!r.ok) return r;
    chq.status = "cleared";
    chq.clearedAt = Date.now();
    chq.depositedTo = toAccountId;
    this.save();
    return { ok: true, amount: chq.amount };
  }

  // ---------- Vault / drawer ----------
  registerVault(x, y, z, dim, institutionId, cash = 0) {
    const key = `${dim}:${x},${y},${z}`;
    this.vaults.set(key, { key, x, y, z, dim, institutionId, cash: round2(cash) });
    this.save();
    return this.vaults.get(key);
  }

  registerDrawer(x, y, z, dim, institutionId, cash = 500) {
    const key = `${dim}:${x},${y},${z}`;
    this.drawers.set(key, { key, x, y, z, dim, institutionId, cash: round2(cash) });
    this.save();
    return this.drawers.get(key);
  }

  tryChargeBlockPlace(playerName) {
    if (!this.settings.costPerBlock || this.settings.costPerBlock <= 0) return { ok: true };
    const charge = this.settings.costPerBlock;
    const accounts = this.getPlayerAccounts(playerName).filter((a) => a.type !== "credit");
    accounts.sort((a, b) => b.balance - a.balance);
    for (const acc of accounts) {
      if (acc.balance >= charge) {
        this.withdraw(acc.id, charge);
        return { ok: true, charged: charge };
      }
    }
    return { ok: false, error: "Insufficient funds for block cost" };
  }


  /** Move physical tender from player into vault float */
  vaultDepositTender(key, player, maxAmount = null) {
    const v = this.vaults.get(key);
    if (!v) return { ok: false, error: "Vault not registered" };
    const available = this.countInventoryCash(player);
    let amount = available;
    if (maxAmount != null) amount = Math.min(amount, maxAmount);
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "No CAD tender" };
    const taken = this.takeTenderFromPlayer(player, amount);
    if (taken <= 0) return { ok: false, error: "Could not take tender" };
    v.cash = round2((v.cash || 0) + taken);
    this.save();
    return { ok: true, cash: v.cash, deposited: taken };
  }

  vaultWithdrawTender(key, player, amount) {
    const v = this.vaults.get(key);
    if (!v) return { ok: false, error: "Vault not registered" };
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    if ((v.cash || 0) < amount) return { ok: false, error: "Insufficient vault cash" };
    v.cash = round2(v.cash - amount);
    this.giveTenderToPlayer(player, amount);
    this.save();
    return { ok: true, cash: v.cash };
  }

  drawerDepositTender(key, player, maxAmount = null) {
    const d = this.drawers.get(key);
    if (!d) return { ok: false, error: "Drawer not registered" };
    const available = this.countInventoryCash(player);
    let amount = available;
    if (maxAmount != null) amount = Math.min(amount, maxAmount);
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "No CAD tender" };
    const taken = this.takeTenderFromPlayer(player, amount);
    if (taken <= 0) return { ok: false, error: "Could not take tender" };
    d.cash = round2((d.cash || 0) + taken);
    this.save();
    return { ok: true, cash: d.cash, deposited: taken };
  }

  drawerWithdrawTender(key, player, amount) {
    const d = this.drawers.get(key);
    if (!d) return { ok: false, error: "Drawer not registered" };
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    if ((d.cash || 0) < amount) return { ok: false, error: "Insufficient drawer float" };
    d.cash = round2(d.cash - amount);
    this.giveTenderToPlayer(player, amount);
    this.save();
    return { ok: true, cash: d.cash };
  }


  /**
   * Online payment to a phone number (CarrierCore-aware).
   * Charges fromAccount, credits recipient account if resolved, else pending like e-Transfer.
   */
  onlinePay(fromAccountId, toPhone, amount, memo, senderName) {
    if (!validAmount(amount)) return { ok: false, error: "Invalid amount" };
    amount = round2(amount);
    const from = this.accounts.get(fromAccountId);
    if (!from || from.owner !== senderName) return { ok: false, error: "Account not found" };
    const w = this.withdraw(fromAccountId, amount);
    if (!w.ok) return w;
    const recipient = this.resolvePhoneToPlayer(toPhone);
    if (recipient) {
      const accounts = this.getPlayerAccounts(recipient).filter((a) => a.type !== "credit");
      if (accounts.length) {
        accounts.sort((a, b) => b.balance - a.balance);
        this.deposit(accounts[0].id, amount);
        this._pushBridgeEvent({
          type: "online_pay",
          from: senderName,
          to: recipient,
          phone: String(toPhone),
          amount,
          memo: (memo || "").slice(0, 60),
          at: Date.now()
        });
        return { ok: true, mode: "instant", recipient, balance: w.balance };
      }
    }
    // fall back to pending e-transfer style
    const id = `et_${this.nextIds.transfer++}`;
    this.transfers.push({
      id,
      fromAccountId,
      fromOwner: senderName,
      toPhone: String(toPhone).replace(/\D/g, ""),
      toPlayer: recipient,
      amount,
      fee: 0,
      message: (memo || "Online pay").slice(0, 80),
      securityQuestion: "",
      securityAnswer: "",
      status: recipient ? "pending" : "pending_unresolved",
      createdAt: Date.now(),
      online: true
    });
    this.save();
    return { ok: true, mode: "pending", recipient, transferId: id };
  }

  /**
   * Purchase a mobile plan for a phone number; charges account.
   * Writes bridge so CarrierCore (or future packs) can apply service.
   */
  purchasePlan(playerName, accountId, planId, phone) {
    const plan = CARRIER_PLANS.find((p) => p.id === planId);
    if (!plan) return { ok: false, error: "Unknown plan" };
    const acc = this.accounts.get(accountId);
    if (!acc || acc.owner !== playerName) return { ok: false, error: "Account not found" };
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length < 7) return { ok: false, error: "Invalid phone" };
    const w = this.withdraw(accountId, plan.price);
    if (!w.ok) return w;
    const record = {
      planId: plan.id,
      planName: plan.name,
      price: plan.price,
      dataGb: plan.dataGb,
      talkMin: plan.talkMin,
      phone: digits,
      owner: playerName,
      carrierCore: this.isCarrierCorePresent(),
      purchasedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
    };
    this.plans.set(digits, record);
    this._pushBridgeEvent({
      type: "plan_purchase",
      ...record
    });
    // Also try to annotate carriercore bridge property
    try {
      let bridge = {};
      const raw = world.getDynamicProperty("carriercore:finance_bridge");
      if (raw && typeof raw === "string") bridge = JSON.parse(raw);
      if (!bridge.plans) bridge.plans = {};
      bridge.plans[digits] = record;
      if (!bridge.events) bridge.events = [];
      bridge.events.push({ type: "plan_purchase", phone: digits, planId: plan.id, at: Date.now() });
      if (bridge.events.length > 40) bridge.events = bridge.events.slice(-40);
      world.setDynamicProperty("carriercore:finance_bridge", JSON.stringify(bridge));
    } catch (e) {
      console.warn("[FinanceCore] bridge write", e);
    }
    this.save();
    return { ok: true, plan: record, carrierCore: record.carrierCore };
  }

  getPlanForPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return this.plans.get(digits) || null;
  }

  _pushBridgeEvent(evt) {
    try {
      let bridge = {};
      const raw = world.getDynamicProperty("financecore:carrier_bridge");
      if (raw && typeof raw === "string") bridge = JSON.parse(raw);
      if (!bridge.events) bridge.events = [];
      bridge.events.push(evt);
      if (bridge.events.length > 50) bridge.events = bridge.events.slice(-50);
      world.setDynamicProperty("financecore:carrier_bridge", JSON.stringify(bridge));
    } catch (e) {}
  }


  static ATM_NETWORKS = ["Interac", "Visa Debit", "Mastercard", "Plus", "Cirrus", "THE EXCHANGE"];

  static ATM_COLORS = [
    { id: "bank_default", label: "Bank default" },
    { id: "blue", label: "Blue" },
    { id: "green", label: "Green" },
    { id: "red", label: "Red" },
    { id: "black", label: "Black" },
    { id: "orange", label: "Orange" },
    { id: "white", label: "White / silver" }
  ];

  static BANK_ATM_BLOCKS = {
    generic: "financecore:atm_generic",
    rbc: "financecore:atm_rbc",
    td: "financecore:atm_td",
    bmo: "financecore:atm_bmo",
    scotiabank: "financecore:atm_scotiabank",
    cibc: "financecore:atm_cibc",
    national: "financecore:atm_national",
    desjardins: "financecore:atm_desjardins",
    vancity: "financecore:atm_vancity",
    tangerine: "financecore:atm_tangerine",
    servus: "financecore:atm_generic",
    coastcapital: "financecore:atm_generic",
    eqbank: "financecore:atm_generic"
  };

  atmKey(dim, x, y, z) {
    return `${dim}:${x},${y},${z}`;
  }

  getAtmConfig(dim, x, y, z) {
    const key = this.atmKey(dim, x, y, z);
    let cfg = this.atms.get(key);
    if (!cfg) {
      cfg = {
        key,
        institutionId: "generic",
        color: "bank_default",
        networks: ["Interac", "Visa Debit"],
        label: "Network ATM"
      };
      this.atms.set(key, cfg);
    }
    return cfg;
  }

  setAtmConfig(dim, x, y, z, patch) {
    const cfg = this.getAtmConfig(dim, x, y, z);
    Object.assign(cfg, patch || {});
    if (cfg.institutionId) {
      const inst = this.institutions.get(cfg.institutionId);
      cfg.label = inst ? `${inst.name} ATM` : cfg.label || "ATM";
    }
    this.atms.set(cfg.key, cfg);
    this.save();
    return cfg;
  }

  /**
   * Swap the world block to the bank-branded ATM type.
   */
  applyAtmBlockType(dimension, x, y, z, institutionId) {
    const typeId = FinanceManager.BANK_ATM_BLOCKS[institutionId] || "financecore:atm_generic";
    try {
      const block = dimension.getBlock({ x, y, z });
      if (!block) return { ok: false, error: "No block" };
      block.setType(typeId);
      return { ok: true, typeId };
    } catch (e) {
      try {
        dimension.runCommand(`setblock ${x} ${y} ${z} ${typeId}`);
        return { ok: true, typeId };
      } catch (e2) {
        return { ok: false, error: String(e2) };
      }
    }
  }

  formatMoney(n) {
    const c = this.getCurrency();
    return `$${round2(n).toFixed(2)} ${c}`;
  }
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return NaN;
  return Math.round(x * 100) / 100;
}

/** Reject non-finite / non-positive where required */
function validAmount(n, { allowZero = false } = {}) {
  const x = Number(n);
  if (!Number.isFinite(x)) return false;
  if (allowZero) return x >= 0;
  return x > 0;
}
