import { world, system } from "@minecraft/server";

/** Built-in Canadian institutions */
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


const TENDER = {
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

/** Prefer large bills when dispensing cash */
const DISPENSE_ORDER = [
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

const ACCOUNT_TYPES = {
  chequing: { label: "Chequing", interest: 0 },
  savings: { label: "Savings", interest: 0.0001 }, // per tick interval approx
  business_chequing: { label: "Business Chequing", interest: 0 },
  business_savings: { label: "Business Savings", interest: 0.00008 }
};

export class FinanceManager {
  constructor() {
    this.institutions = new Map();
    this.accounts = new Map();
    this.cards = new Map();
    this.transfers = []; // pending e-Transfers
    this.merchants = new Map();
    this.vaults = new Map();
    this.drawers = new Map();
    this.nextIds = { account: 1000, card: 4000, transfer: 1, merchant: 1 };
    this.settings = {
      costPerBlock: 0, // CAD charged on place if > 0
      currency: "CAD",
      etransferFee: 0
    };
    this._interestTick = 0;
  }

  load() {
    try {
      const raw = world.getDynamicProperty("financecore:state");
      if (raw && typeof raw === "string") {
        const data = JSON.parse(raw);
        this.nextIds = data.nextIds || this.nextIds;
        this.settings = { ...this.settings, ...(data.settings || {}) };
        if (data.institutions) this.institutions = new Map(data.institutions);
        if (data.accounts) this.accounts = new Map(data.accounts);
        if (data.cards) this.cards = new Map(data.cards);
        if (data.transfers) this.transfers = data.transfers;
        if (data.merchants) this.merchants = new Map(data.merchants);
        if (data.vaults) this.vaults = new Map(data.vaults);
        if (data.drawers) this.drawers = new Map(data.drawers);
      }
    } catch (e) {
      console.warn("[FinanceCore] load error:", e);
    }
    // Seed default institutions if empty
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
      `[FinanceCore] Loaded ${this.institutions.size} institutions, ${this.accounts.size} accounts, ${this.cards.size} cards`
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
        transfers: this.transfers.slice(-80),
        merchants: [...this.merchants.entries()],
        vaults: [...this.vaults.entries()],
        drawers: [...this.drawers.entries()]
      };
      world.setDynamicProperty("financecore:state", JSON.stringify(data));
    } catch (e) {
      console.warn("[FinanceCore] save error:", e);
    }
  }

  tick() {
    this._interestTick++;
    // Interest roughly daily-ish in game terms: every 12000 ticks (~10 min)
    if (this._interestTick % 12000 === 0) {
      for (const [, acc] of this.accounts) {
        const meta = ACCOUNT_TYPES[acc.type];
        if (meta && meta.interest > 0 && acc.balance > 0) {
          acc.balance = round2(acc.balance * (1 + meta.interest));
        }
        // Credit interest on balances owed
        if (acc.type === "credit" && acc.balance > 0) {
          const apr = acc.apr || 0.1999;
          const daily = apr / 365;
          acc.balance = round2(acc.balance * (1 + daily));
        }
      }
      this.save();
    }
  }

  // ---------- Institutions ----------
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
    if (!ACCOUNT_TYPES[type] && type !== "credit") {
      return { ok: false, error: "Invalid account type" };
    }
    const id = `acc_${this.nextIds.account++}`;
    const acc = {
      id,
      institutionId,
      type,
      owner: playerName,
      businessName: businessName || null,
      balance: type === "credit" ? 0 : 0,
      limit: type === "credit" ? (businessName ? 15000 : 2000) : 0,
      apr: type === "credit" ? (businessName ? 0.1499 : 0.1999) : 0,
      status: "open",
      createdAt: Date.now()
    };
    this.accounts.set(id, acc);
    this.save();
    return { ok: true, account: acc };
  }

  getPlayerAccounts(playerName) {
    return [...this.accounts.values()].filter(
      (a) => a.owner === playerName && a.status === "open"
    );
  }

  getAccount(id) {
    return this.accounts.get(id);
  }

  deposit(accountId, amount) {
    const acc = this.accounts.get(accountId);
    if (!acc || acc.status !== "open") return { ok: false, error: "Account not found" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    if (acc.type === "credit") {
      // payment toward credit balance
      acc.balance = round2(Math.max(0, acc.balance - amount));
    } else {
      acc.balance = round2(acc.balance + amount);
    }
    this.save();
    return { ok: true, balance: acc.balance };
  }

  withdraw(accountId, amount) {
    const acc = this.accounts.get(accountId);
    if (!acc || acc.status !== "open") return { ok: false, error: "Account not found" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    if (acc.type === "credit") {
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
    const from = this.accounts.get(fromId);
    const to = this.accounts.get(toId);
    if (!from || !to) return { ok: false, error: "Account not found" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    const w = this.withdraw(fromId, amount);
    if (!w.ok) return w;
    const d = this.deposit(toId, amount);
    if (!d.ok) {
      this.deposit(fromId, amount); // rollback
      return d;
    }
    return { ok: true };
  }

  // ---------- Cards / embossing ----------
  embossCard(playerName, accountId, cardType, pin) {
    const acc = this.accounts.get(accountId);
    if (!acc || acc.owner !== playerName) return { ok: false, error: "Account not found" };
    if (!["debit", "credit", "business"].includes(cardType)) {
      return { ok: false, error: "Invalid card type" };
    }
    if (cardType === "credit" && acc.type !== "credit") {
      // open a credit account linked
      const opened = this.openAccount(
        playerName,
        acc.institutionId,
        "credit",
        cardType === "business" ? acc.businessName || `${playerName} Business` : null
      );
      if (!opened.ok) return opened;
      accountId = opened.account.id;
    }
    if (cardType === "business" && !acc.businessName && acc.type !== "credit") {
      // prefer business account
      const biz = this.getPlayerAccounts(playerName).find(
        (a) => a.type.startsWith("business") && a.institutionId === acc.institutionId
      );
      if (biz) accountId = biz.id;
    }
    const pinStr = String(pin || "0000").padStart(4, "0").slice(0, 4);
    const id = `card_${this.nextIds.card++}`;
    const last4 = String(this.nextIds.card).slice(-4).padStart(4, "0");
    const inst = this.institutions.get(acc.institutionId);
    const card = {
      id,
      accountId,
      owner: playerName,
      type: cardType === "business" ? "debit" : cardType,
      isBusiness: cardType === "business" || !!acc.businessName,
      institutionId: acc.institutionId,
      institutionName: inst ? inst.name : acc.institutionId,
      last4,
      pin: pinStr,
      status: "active",
      createdAt: Date.now()
    };
    this.cards.set(id, card);
    this.save();
    return { ok: true, card };
  }

  getCard(cardId) {
    return this.cards.get(cardId);
  }

  getPlayerCards(playerName) {
    return [...this.cards.values()].filter((c) => c.owner === playerName && c.status === "active");
  }

  verifyPin(cardId, pin) {
    const card = this.cards.get(cardId);
    if (!card || card.status !== "active") return false;
    return card.pin === String(pin).padStart(4, "0").slice(0, 4);
  }

  // ---------- e-Transfer (CarrierCore phone aware) ----------
  /**
   * Resolve a phone number to a player name.
   * Uses CarrierCore SIM registry when present; else FinanceCore local map.
   */
  resolvePhoneToPlayer(phone) {
    phone = String(phone).replace(/\D/g, "");
    // CarrierCore bridge
    try {
      const raw = world.getDynamicProperty("carriercore:network");
      if (raw && typeof raw === "string") {
        const data = JSON.parse(raw);
        if (data.sims) {
          const sims = data.sims instanceof Array ? data.sims : Object.entries(data.sims || {});
          for (const entry of sims) {
            const sim = Array.isArray(entry) ? entry[1] : entry;
            if (!sim) continue;
            const num = String(sim.number || sim.phone || "").replace(/\D/g, "");
            if (num && (num === phone || num.endsWith(phone) || phone.endsWith(num))) {
              return sim.ownerName || sim.owner || sim.player || null;
            }
          }
        }
      }
    } catch (e) {
      /* solo mode */
    }
    // Local fallback: match account owner names stored as phone aliases later
    return null;
  }

  sendETransfer(fromAccountId, toPhone, amount, message, senderName) {
    const from = this.accounts.get(fromAccountId);
    if (!from || from.owner !== senderName) return { ok: false, error: "Account not found" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    const fee = this.settings.etransferFee || 0;
    const total = round2(amount + fee);
    if (from.type !== "credit" && from.balance < total) {
      return { ok: false, error: "Insufficient funds" };
    }
    const w = this.withdraw(fromAccountId, total);
    if (!w.ok) return w;

    const recipientPlayer = this.resolvePhoneToPlayer(toPhone);
    const id = `et_${this.nextIds.transfer++}`;
    const transfer = {
      id,
      fromAccountId,
      fromOwner: senderName,
      toPhone: String(toPhone),
      toPlayer: recipientPlayer,
      amount,
      fee,
      message: (message || "").slice(0, 80),
      status: recipientPlayer ? "pending" : "pending_unresolved",
      createdAt: Date.now()
    };
    this.transfers.push(transfer);
    this.save();
    return { ok: true, transfer, recipientPlayer };
  }

  acceptETransfer(transferId, toAccountId, playerName) {
    const t = this.transfers.find((x) => x.id === transferId);
    if (!t || t.status !== "pending" && t.status !== "pending_unresolved") {
      return { ok: false, error: "Transfer not found" };
    }
    if (t.toPlayer && t.toPlayer !== playerName) {
      return { ok: false, error: "Not addressed to you" };
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

  getPendingTransfersFor(playerName) {
    return this.transfers.filter(
      (t) =>
        (t.status === "pending" || t.status === "pending_unresolved") &&
        (t.toPlayer === playerName || !t.toPlayer)
    );
  }

  // ---------- Merchants / POS ----------
  registerMerchant(playerName, name, accountId) {
    const acc = this.accounts.get(accountId);
    if (!acc || acc.owner !== playerName) return { ok: false, error: "Account not found" };
    const id = `merch_${this.nextIds.merchant++}`;
    const m = { id, name, owner: playerName, accountId, createdAt: Date.now() };
    this.merchants.set(id, m);
    this.save();
    return { ok: true, merchant: m };
  }

  posCharge(merchantId, cardId, pin, amount) {
    const m = this.merchants.get(merchantId);
    if (!m) return { ok: false, error: "Merchant not found" };
    const card = this.cards.get(cardId);
    if (!card || card.status !== "active") return { ok: false, error: "Card not found" };
    if (!this.verifyPin(cardId, pin)) return { ok: false, error: "Invalid PIN" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    const w = this.withdraw(card.accountId, amount);
    if (!w.ok) return w;
    this.deposit(m.accountId, amount);
    return { ok: true };
  }

  // ---------- Vault / cash drawer ----------
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

  // ---------- Cost per block ----------
  tryChargeBlockPlace(playerName, amount) {
    if (!this.settings.costPerBlock || this.settings.costPerBlock <= 0) return { ok: true };
    const charge = amount ?? this.settings.costPerBlock;
    const accounts = this.getPlayerAccounts(playerName).filter((a) => a.type !== "credit");
    accounts.sort((a, b) => b.balance - a.balance);
    for (const acc of accounts) {
      if (acc.balance >= charge) {
        this.withdraw(acc.id, charge);
        return { ok: true, charged: charge, accountId: acc.id };
      }
    }
    return { ok: false, error: "Insufficient funds for block cost" };
  }


  // ---------- Physical CAD tender ----------
  getTenderValue(typeId) {
    return TENDER[typeId] || 0;
  }

  /** Count CAD tender in player inventory */
  countInventoryCash(player) {
    let total = 0;
    try {
      const inv = player.getComponent("inventory")?.container;
      if (!inv) return 0;
      for (let i = 0; i < inv.size; i++) {
        const it = inv.getItem(i);
        if (!it) continue;
        const v = TENDER[it.typeId];
        if (v) total += v * it.amount;
      }
    } catch (e) {}
    return round2(total);
  }

  /** Remove tender items totaling up to amount; returns amount actually removed */
  takeTenderFromPlayer(player, amount) {
    amount = round2(amount);
    let need = amount;
    try {
      const inv = player.getComponent("inventory")?.container;
      if (!inv) return 0;
      // Take largest denominations first
      for (const [typeId, val] of DISPENSE_ORDER) {
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

  /** Give physical bills/coins for amount (greedy) */
  giveTenderToPlayer(player, amount) {
    amount = round2(amount);
    let left = amount;
    const given = [];
    try {
      for (const [typeId, val] of DISPENSE_ORDER) {
        if (left < val - 0.001) continue;
        const n = Math.floor((left + 0.001) / val);
        if (n <= 0) continue;
        const stacks = Math.ceil(n / 64);
        let remain = n;
        for (let s = 0; s < stacks; s++) {
          const qty = Math.min(64, remain);
          player.runCommandAsync(`give @s ${typeId} ${qty}`);
          remain -= qty;
        }
        left = round2(left - n * val);
        given.push([typeId, n]);
      }
    } catch (e) {
      console.warn("[FinanceCore] giveTender", e);
    }
    return { given, remainder: left };
  }

  /** ATM: withdraw balance → physical cash */
  withdrawCash(accountId, amount, player) {
    const w = this.withdraw(accountId, amount);
    if (!w.ok) return w;
    this.giveTenderToPlayer(player, amount);
    return { ok: true, balance: w.balance, cash: amount };
  }

  /** ATM/teller: physical cash → deposit */
  depositCash(accountId, player, maxAmount = null) {
    const available = this.countInventoryCash(player);
    let amount = available;
    if (maxAmount != null) amount = Math.min(amount, maxAmount);
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "No CAD tender in inventory" };
    const taken = this.takeTenderFromPlayer(player, amount);
    if (taken <= 0) return { ok: false, error: "Could not take tender" };
    return this.deposit(accountId, taken);
  }

  // ---------- Direct deposit ----------
  /**
   * Employer/system pays straight into an account (no cash items).
   * sourceLabel e.g. "Payroll", "GST Refund", "Merchant Settlement"
   */
  directDeposit(toAccountId, amount, sourceLabel = "Direct Deposit", memo = "") {
    const to = this.accounts.get(toAccountId);
    if (!to || to.status !== "open") return { ok: false, error: "Account not found" };
    amount = round2(amount);
    if (amount <= 0) return { ok: false, error: "Invalid amount" };
    if (to.type === "credit") {
      to.balance = round2(Math.max(0, to.balance - amount)); // pays down credit
    } else {
      to.balance = round2(to.balance + amount);
    }
    if (!to.ledger) to.ledger = [];
    to.ledger.push({
      type: "direct_deposit",
      amount,
      source: sourceLabel,
      memo: (memo || "").slice(0, 60),
      at: Date.now()
    });
    if (to.ledger.length > 30) to.ledger = to.ledger.slice(-30);
    this.save();
    return { ok: true, balance: to.balance };
  }

  /** Player-triggered: deposit from another of their accounts as "payroll style" transfer label */
  setupDirectDepositLink(fromAccountId, toAccountId, ownerName) {
    const from = this.accounts.get(fromAccountId);
    const to = this.accounts.get(toAccountId);
    if (!from || !to || from.owner !== ownerName || to.owner !== ownerName) {
      return { ok: false, error: "Accounts not found" };
    }
    to.directDepositFrom = fromAccountId;
    this.save();
    return { ok: true };
  }

  formatMoney(n) {
    return `$${round2(n).toFixed(2)} CAD`;
  }
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
