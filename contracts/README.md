# Remix deployment (Base mainnet)

Deploy **two** contracts on Base mainnet:

1) `JesseHillClimbScoreboard.sol`
2) `JesseHillClimbRunNFT.sol`

## Steps

1. Open Remix.
2. Create two files and paste the contract code.
3. In "Deploy & Run Transactions":
   - Environment: **Injected Provider** (your wallet)
   - Network: **Base mainnet** (chainId 8453)
4. Deploy:
   - Scoreboard has no constructor args.
   - RunNFT has no constructor args.
5. Copy deployed addresses and put them in your `.env.local`:

```bash
NEXT_PUBLIC_SCOREBOARD_ADDRESS=0x...
NEXT_PUBLIC_RUNNFT_ADDRESS=0x...
NEXT_PUBLIC_LIGHTHOUSE_GATEWAY_URL=https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs
LIGHTHOUSE_API_KEY=...
OPENSEA_API_KEY=...
```

## Notes
- `submitScore(meters)` always emits an event, but only updates `bestMeters[address]` if the submitted meters is higher.
- `mintRun(meters, driverId, tokenURI)` mints sequential tokenIds: 1,2,3...
- The app computes flat metadata and artwork IPFS CIDs locally and keeps each CAR package in a browser recovery queue until `RunMinted` succeeds and the public Lighthouse gateway serves the exact bytes. The protected finalizer verifies the receipt and package before uploading `metadata.json` and `run.jpg` under those exact CIDs.
- New tokens use immutable, content-addressed URLs from the project's paid Lighthouse gateway for `tokenURI` and the primary image. NFT artwork is a focused 960x960 square so marketplace viewers do not add empty letterbox bands; metadata also retains the canonical `ipfs://<image CID>` in `properties.files`.
- The mint UI returns as soon as Lighthouse accepts the exact CIDs. Gateway verification and marketplace refresh continue in the background; the local recovery copy is removed only after a byte-for-byte paid-gateway check succeeds.
- Keep `LIGHTHOUSE_API_KEY` and the optional `OPENSEA_API_KEY` server-only. Never add a `NEXT_PUBLIC_` prefix to either key.
