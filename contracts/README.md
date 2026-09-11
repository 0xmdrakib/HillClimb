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
- The app builds one deterministic directory CAR locally with `metadata.json` and `run.jpg`. After the mint receipt is verified, the protected finalizer submits that CAR once through Lighthouse's official DAG-import endpoint.
- New tokens use an immutable `.../ipfs/<directory CID>/metadata.json` URL on the project's paid Lighthouse gateway. NFT artwork is a focused 960x960 square so marketplace viewers do not add empty letterbox bands; metadata also retains the canonical `ipfs://<image CID>` in `properties.files`.
- A mint is reported as successful only after the directory CID appears in the paid Lighthouse account and the paid gateway serves the exact metadata and artwork bytes. There is no browser recovery queue, delayed replay, or 30-day local copy.
- Keep `LIGHTHOUSE_API_KEY` and the optional `OPENSEA_API_KEY` server-only. Never add a `NEXT_PUBLIC_` prefix to either key.
