export type NftUploadMessageInput = {
  address: string;
  rootCid: string;
  tokenUri: string;
  meters: number;
  driverId: number;
  origin: string;
  contract: string;
  nonce: string;
  /** Unix time in milliseconds, matching the challenge and preparation APIs. */
  expiresAt: number;
};

/** Shared verbatim by the signer and verifier; contains no server-only imports. */
export function nftUploadMessage(input: NftUploadMessageInput): string {
  return [
    "Jesse Hill Climb: prepare NFT storage",
    "",
    `Site: ${input.origin}`,
    `Wallet: ${input.address.toLowerCase()}`,
    "Network: Base (8453)",
    `NFT contract: ${input.contract.toLowerCase()}`,
    `Metadata CID: ${input.rootCid}`,
    `Token URI: ${input.tokenUri}`,
    `Distance: ${input.meters}m`,
    `Driver ID: ${input.driverId}`,
    `Nonce: ${input.nonce}`,
    `Expires: ${new Date(input.expiresAt).toISOString()}`,
    "",
    "I authorize uploading only this run's image and metadata to Jesse Hill Climb's paid Lighthouse storage.",
    "Files may remain stored if I cancel the later NFT mint.",
    "This signature does not authorize a transaction, NFT mint, transfer, or spending.",
  ].join("\n");
}
