# FinanceCore

Canadian multi-bank finance for Minecraft Bedrock **1.26+**.

## v1.1.1

Bugfix release:

- Cheques stamp `chq_…` id into item lore (deposit works)
- Amount inputs reject NaN / invalid values
- Credit & savings interest scaled (~1 day APR per real day of play)
- Min payment never exceeds balance (small balances can clear)
- Business credit emboss uses business limits
- CAD bills stack to 64
- ATM requires **your** card; POS requires cardholder online
- Block cost / tax settings: ops or `financecore_admin` tag only
- Unresolved e-Transfers only visible if your registered phone matches

## Install

1. Download **[FinanceCore-v1.1.1.mcaddon](https://github.com/blocklogic-studios/financecore/releases/download/v1.1.1/FinanceCore-v1.1.1.mcaddon)**
2. Open in Minecraft
3. Enable both packs + **Beta APIs**

## Upcoming

- US tender
- Deeper CarrierCore hooks (online payments / plan purchases)

## Studio

[Blocklogic Studio](https://github.com/blocklogic-studios)
