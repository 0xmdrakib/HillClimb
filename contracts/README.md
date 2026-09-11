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
- The app computes flat metadata and artwork IPFS CIDs locally and keeps each CAR package queued until `RunMinted` succeeds and both files pass byte-for-byte retrieval checks. The browser waits for confirmation; the protected finalizer then independently validates the successful event before storing `run.jpg` followed by `metadata.json`. Rejected, cancelled, replaced, and reverted transactions upload nothing.
- New tokens use canonical `ipfs://<metadata CID>` and `ipfs://<image CID>` references. Public IPFS retrieval is verified for marketplace compatibility instead of making immutable NFT data depend on one paid-gateway hostname.
- The mint UI reports success and removes its pending package only after the receipt/event is confirmed and both immutable files have been fetched back with the expected bytes. Marketplace refresh happens afterward.
- Keep `LIGHTHOUSE_API_KEY` and the optional `OPENSEA_API_KEY` server-only. Never add a `NEXT_PUBLIC_` prefix to either key.
