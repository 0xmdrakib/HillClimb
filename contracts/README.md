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
- The app computes flat metadata and artwork IPFS CIDs locally, waits for a successful `RunMinted` receipt, then sends their matching multi-root CAR archive to the protected Lighthouse upload route. The contract stores the marketplace-friendly `ipfs://<metadata CID>` URI.
- Finalization succeeds only after both metadata and artwork are readable from Lighthouse. The route then asks OpenSea to refresh the minted token.
- Keep `LIGHTHOUSE_API_KEY` and `OPENSEA_API_KEY` server-only. Never add a `NEXT_PUBLIC_` prefix to either key.
