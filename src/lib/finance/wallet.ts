import { WALLET_TX_EFFECT, type TxDirection, type WalletTxType } from "./types";
import { round2 } from "./money";

/**
 * Staff working-wallet rules.
 *
 * THE BALANCE IS NEVER STORED AS AN EDITABLE FIELD. It is always derived from
 * the immutable wallet transaction ledger (see convex/wallet.ts). These pure
 * helpers are the single definition of "what counts as available cash".
 */

export interface WalletLedgerEntry {
  type: WalletTxType | string;
  amount: number;
  direction: TxDirection | string;
}

/** Available balance = Σ credits − Σ debits over the whole ledger. */
export function deriveBalance(entries: WalletLedgerEntry[]): number {
  let balance = 0;
  for (const e of entries) {
    const amount = Number(e.amount) || 0;
    if (e.direction === "CREDIT") balance = round2(balance + amount);
    else if (e.direction === "DEBIT") balance = round2(balance - amount);
    // "NONE" entries are audit-only and never move cash availability.
  }
  return balance;
}

/** Signed delta a transaction applies to the balance. */
export function txDelta(
  direction: TxDirection | string,
  amount: number,
): number {
  if (direction === "CREDIT") return amount;
  if (direction === "DEBIT") return -amount;
  return 0;
}

/** Default direction for a wallet transaction type (may be overridden). */
export function defaultDirection(type: WalletTxType): TxDirection {
  return WALLET_TX_EFFECT[type] ?? "NONE";
}

/** 0–100 utilisation of the approved wallet limit. */
export function utilization(balance: number, limit: number): number {
  if (!limit) return 0;
  return Math.max(0, Math.min(100, round2((balance / limit) * 100)));
}

/** Balance headroom before hitting the approved limit. */
export function headroom(balance: number, limit: number): number {
  return round2(Math.max(0, limit - balance));
}

export const LOW_WALLET_THRESHOLD = 15; // %
export function walletWarning(
  balance: number,
  limit: number,
): "low" | "critical" | null {
  const pct = utilization(balance, limit);
  if (pct <= 10) return "critical";
  if (pct <= LOW_WALLET_THRESHOLD) return "low";
  return null;
}
