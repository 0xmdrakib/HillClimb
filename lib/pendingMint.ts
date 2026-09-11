"use client";

import type { RunNftPackage } from "@/lib/nftPackage";
import { LIGHTHOUSE_DELIVERY_GATEWAY } from "@/lib/nftGateway";

const DATABASE_NAME = "jesse-hill-climb";
const DATABASE_VERSION = 1;
const STORE_NAME = "pending-nft";
const RECORD_KEY = "latest";
const MAX_PENDING_MINTS = 12;

export type PendingRunMint = {
  version: 1 | 2;
  savedAt: number;
  txHash: string;
  package: RunNftPackage;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local NFT storage"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Local NFT storage failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Local NFT storage failed"));
    });
  } finally {
    database.close();
  }
}

function isValidPending(value: unknown): value is PendingRunMint {
  const pending = value as PendingRunMint;
  const nftPackage = pending?.package;
  const tokenUri = nftPackage?.tokenUri ?? "";
  const validTokenUri = tokenUri === `ipfs://${nftPackage?.rootCid}`
    || tokenUri === `ipfs://${nftPackage?.rootCid}/metadata.json`
    || tokenUri === `${LIGHTHOUSE_DELIVERY_GATEWAY}/${nftPackage?.rootCid}`
    // Preserve old records without requesting their obsolete delivery URLs.
    || (pending?.version === 1 && tokenUri.startsWith("https://") && tokenUri.endsWith(`/${nftPackage?.rootCid}`));
  return (
    (pending?.version === 1 || pending?.version === 2) &&
    Number.isFinite(pending.savedAt) &&
    Date.now() - pending.savedAt >= 0 &&
    /^0x[0-9a-fA-F]{64}$/.test(pending.txHash) &&
    /^b[a-z2-7]{40,100}$/.test(nftPackage?.rootCid ?? "") &&
    validTokenUri &&
    typeof nftPackage?.carBase64 === "string" &&
    nftPackage.carBase64.length > 0 &&
    nftPackage.carBase64.length <= 1_150_000 &&
    Number.isInteger(nftPackage.carBytes) &&
    nftPackage.carBytes > 0 &&
    nftPackage.carBytes <= 850_000
  );
}

function validPendingRecords(value: unknown): PendingRunMint[] {
  const records = Array.isArray(value) ? value : value ? [value] : [];
  return records
    .filter(isValidPending)
    .sort((left, right) => left.savedAt - right.savedAt)
    .slice(-MAX_PENDING_MINTS);
}

async function updatePendingRecords(update: (records: PendingRunMint[]) => PendingRunMint[]): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const readRequest = store.get(RECORD_KEY);
      readRequest.onsuccess = () => {
        const next = update(validPendingRecords(readRequest.result)).slice(-MAX_PENDING_MINTS);
        if (next.length) store.put(next, RECORD_KEY);
        else store.delete(RECORD_KEY);
      };
      readRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Local NFT storage failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Local NFT storage failed"));
    });
  } finally {
    database.close();
  }
}

export async function savePendingRunMint(pending: Omit<PendingRunMint, "version" | "savedAt">): Promise<void> {
  const record: PendingRunMint = { ...pending, version: 2, savedAt: Date.now() };
  await updatePendingRecords((records) => [
    ...records.filter((item) => item.txHash.toLowerCase() !== record.txHash.toLowerCase()),
    record,
  ]);
}

export async function loadPendingRunMints(): Promise<PendingRunMint[]> {
  if (typeof indexedDB === "undefined") return [];
  const value = await withStore<unknown>("readonly", (store) => store.get(RECORD_KEY));
  const records = validPendingRecords(value);
  if (!records.length) await removePendingRunMint();
  return records;
}

export async function removePendingRunMint(txHash?: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  if (!txHash) {
    await withStore("readwrite", (store) => store.delete(RECORD_KEY));
    return;
  }
  await updatePendingRecords((records) => records.filter((item) => item.txHash.toLowerCase() !== txHash.toLowerCase()));
}
