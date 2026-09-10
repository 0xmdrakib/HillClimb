"use client";

import type { RunNftPackage } from "@/lib/nftPackage";

const DATABASE_NAME = "jesse-hill-climb";
const DATABASE_VERSION = 1;
const STORE_NAME = "pending-nft";
const RECORD_KEY = "latest";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type PendingRunMint = {
  version: 1;
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
  const validTokenUri = tokenUri === `ipfs://${nftPackage?.rootCid}` || tokenUri === `ipfs://${nftPackage?.rootCid}/metadata.json`;
  return (
    pending?.version === 1 &&
    Number.isFinite(pending.savedAt) &&
    Date.now() - pending.savedAt >= 0 &&
    Date.now() - pending.savedAt <= MAX_AGE_MS &&
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

export async function savePendingRunMint(pending: Omit<PendingRunMint, "version" | "savedAt">): Promise<void> {
  await withStore("readwrite", (store) => store.put({ ...pending, version: 1, savedAt: Date.now() }, RECORD_KEY));
}

export async function loadPendingRunMint(): Promise<PendingRunMint | null> {
  if (typeof indexedDB === "undefined") return null;
  const value = await withStore<unknown>("readonly", (store) => store.get(RECORD_KEY));
  if (isValidPending(value)) return value;
  await removePendingRunMint();
  return null;
}

export async function removePendingRunMint(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await withStore("readwrite", (store) => store.delete(RECORD_KEY));
}
