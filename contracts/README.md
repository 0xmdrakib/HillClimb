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
LIGHTHOUSE_API_KEY=...
LIGHTHOUSE_GATEWAY_URL=https://your-gateway.example/ipfs
OPENSEA_API_KEY=...
```

## Notes
- `submitScore(meters)` always emits an event, but only updates `bestMeters[address]` if the submitted meters is higher.
- `mintRun(meters, driverId, tokenURI)` mints sequential tokenIds: 1,2,3...
- The app computes flat metadata and artwork IPFS CIDs locally and keeps their CAR package in the browser until `RunMinted` succeeds. The protected finalizer verifies that receipt and package, then uploads the extracted `metadata.json` and `run.jpg` as normal Lighthouse files under those exact CIDs. The contract stores the marketplace-friendly `ipfs://<metadata CID>` URI.
- Finalization succeeds only after both metadata and artwork can be fetched back byte-for-byte from a Lighthouse gateway. When an optional OpenSea API key is configured, the route also queues a metadata refresh.
- Keep `LIGHTHOUSE_API_KEY` and the optional `OPENSEA_API_KEY` server-only. Never add a `NEXT_PUBLIC_` prefix to either key.
