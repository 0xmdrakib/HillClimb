"use client";

import { LIGHTHOUSE_DELIVERY_GATEWAY } from "@/lib/nftGateway";
import { nftUploadMessage } from "@/lib/nftUploadMessage";
import { assertNftWalletAccount, signNftUploadMessage, type ConnectedWallet } from "@/lib/onchain";
import type { RunNftPackage } from "@/lib/nftPackage";

export class NftPreparationError extends Error {
  constructor(readonly reason: string) {
    super("Could not prepare this NFT. No mint transaction was sent.");
    this.name = "NftPreparationError";
  }
}

export type PreparedNft = {
  ok: true;
  availability: "verified";
  rootCid: string;
  tokenUri: string;
  metadataUrl: string;
  artworkUrl: string;
  verifiedAt: number;
  expiresAt: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** This check is repeated immediately before the mint call, not just on fetch. */
export function assertPreparedNft(value: unknown, nftPackage: RunNftPackage): asserts value is PreparedNft {
  const now = Date.now();
  if (!record(value) || value.ok !== true || value.availability !== "verified"
    || value.rootCid !== nftPackage.rootCid || value.tokenUri !== nftPackage.tokenUri
    || value.metadataUrl !== `${LIGHTHOUSE_DELIVERY_GATEWAY}/${nftPackage.rootCid}`
    || typeof value.artworkUrl !== "string"
    || !value.artworkUrl.startsWith(`${LIGHTHOUSE_DELIVERY_GATEWAY}/`)
    || !/^b[a-z2-7]{40,100}$/.test(value.artworkUrl.slice(LIGHTHOUSE_DELIVERY_GATEWAY.length + 1))
    || typeof value.verifiedAt !== "number" || !Number.isSafeInteger(value.verifiedAt)
    || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
    || value.verifiedAt > now + 5_000 || value.verifiedAt < now - 60_000
    || value.expiresAt <= now || value.expiresAt <= value.verifiedAt
    || value.expiresAt > value.verifiedAt + 60_000) {
    throw new NftPreparationError("unverified_or_expired_preparation");
  }
}

async function postJson(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      redirect: "error", cache: "no-store",
    });
  } catch { throw new NftPreparationError("storage_request_failed"); }
  const value: unknown = await response.json().catch(() => null);
  if (response.status !== 200 || !record(value)) {
    throw new NftPreparationError(record(value) && typeof value.error === "string" ? value.error : "preparation_failed");
  }
  return value;
}

export async function prepareRunNft(input: {
  nftPackage: RunNftPackage;
  wallet: ConnectedWallet;
  contract: string;
  meters: number;
  driverId: number;
  origin: string;
  isCurrent: () => boolean;
  onStage: (stage: string) => void;
}): Promise<PreparedNft> {
  const { nftPackage, wallet, contract, meters, driverId, origin, isCurrent, onStage } = input;
  const stillCurrent = () => { if (!isCurrent()) throw new NftPreparationError("run_changed"); };
  stillCurrent();
  await assertNftWalletAccount(wallet);
  stillCurrent();
  const challenge = await postJson("/api/nft/challenge", {
    address: wallet.address, rootCid: nftPackage.rootCid, tokenUri: nftPackage.tokenUri, meters, driverId,
  }, 10_000);
  stillCurrent();
  if (challenge.ok !== true || typeof challenge.challenge !== "string" || challenge.challenge.length > 8_000
    || typeof challenge.nonce !== "string" || !/^[0-9a-f]{64}$/.test(challenge.nonce)
    || typeof challenge.expiresAt !== "number" || !Number.isSafeInteger(challenge.expiresAt)
    || challenge.expiresAt <= Date.now() || challenge.expiresAt > Date.now() + 305_000) {
    throw new NftPreparationError("invalid_upload_challenge");
  }
  const message = nftUploadMessage({
    address: wallet.address, rootCid: nftPackage.rootCid, tokenUri: nftPackage.tokenUri,
    meters, driverId, origin, contract, nonce: challenge.nonce, expiresAt: challenge.expiresAt,
  });
  if (message !== challenge.message) throw new NftPreparationError("invalid_upload_challenge");
  onStage("Approve upload…");
  const signature = await signNftUploadMessage(message, wallet);
  stillCurrent();
  await assertNftWalletAccount(wallet);
  stillCurrent();
  onStage("Preparing NFT…");
  const prepared = await postJson("/api/nft/prepare", {
    challenge: challenge.challenge, signature, carBase64: nftPackage.carBase64,
  }, 55_000);
  stillCurrent();
  assertPreparedNft(prepared, nftPackage);
  return prepared;
}
