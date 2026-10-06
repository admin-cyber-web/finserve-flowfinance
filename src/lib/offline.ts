/**
 * Offline field mode.
 *
 * Eligible collection operations can be recorded while the device is offline.
 * Each queued item carries a client-generated idempotency key, so replaying it
 * can never create a duplicate financial transaction — the server dedupes on
 * `collections.idempotencyKey`.
 */
export type SyncStatus = "PENDING" | "SYNCING" | "SYNCED" | "FAILED";

export interface QueuedCollection {
  id: string;
  loanId: string;
  clientId: string;
  clientName: string;
  amount: number;
  mode: "CASH" | "UPI" | "BANK";
  remarks?: string;
  idempotencyKey: string;
  queuedAt: number;
  status: SyncStatus;
  error?: string;
}

const KEY = "finserve.offline.collections.v1";

export function readQueue(): QueuedCollection[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeQueue(items: QueuedCollection[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export function queueCount(): number {
  return readQueue().filter((i) => i.status === "PENDING" || i.status === "FAILED")
    .length;
}

export function enqueueCollection(
  input: Omit<QueuedCollection, "id" | "queuedAt" | "status" | "idempotencyKey"> & { idempotencyKey: string },
): QueuedCollection {
  const item: QueuedCollection = {
    ...input,
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    queuedAt: Date.now(),
    status: "PENDING",
  };
  writeQueue([...readQueue(), item]);
  return item;
}

export function patchQueueItem(
  id: string,
  patch: Partial<QueuedCollection>,
): void {
  writeQueue(
    readQueue().map((i) => (i.id === id ? { ...i, ...patch } : i)),
  );
}

export function clearSynced(): void {
  writeQueue(readQueue().filter((i) => i.status !== "SYNCED"));
}

/** A stable idempotency key for one logical payment. */
export function newIdempotencyKey(prefix = "pay"): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}
