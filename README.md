# Jesse Hill Climb

Jesse Hill Climb is a physics-based hill climb racing game built as a Base App-compatible web app, with optional onchain score saving on Base.

**Live app:** https://hillclimb.rakibhq.xyz

---

## Overview

Jesse Hill Climb turns the classic hill-climb driving loop into a Base-native mini game. Players drive as far as possible across rough terrain, manage fuel, collect coins, unlock upgrades, and save their best runs onchain.

The game is designed to work inside the Base App browser and in standard web browsers. It supports mobile-friendly controls, injected wallet connection, onchain score submission, and collectible run NFTs generated from the crash snapshot.

## Features

- Physics-based hill climb gameplay with gas and brake controls
- Swappable driver heads between **Jesse** and **Brian**
- Multiple vehicles including Jeep, Drift Bike, and Sports Car
- Multiple maps with different terrain behavior, gravity, grip, and visual style
- Local coin system for vehicle unlocks and upgrades
- Upgrade categories for engine, suspension, tires, and fuel tank
- Achievement system with coin rewards
- Onchain best-score saving on Base mainnet
- Run NFT minting with locally optimized artwork and Lighthouse IPFS storage
- Base App support through standard injected wallets and the Web Share API
- Optional paymaster proxy flow for sponsored contract transactions
- Builder Code attribution support through ERC-8021 calldata suffixing

## Gameplay behavior

### Driving

Players hold **GAS** to accelerate and use **BRAKE** to control rotation. The goal is to travel as far as possible without crashing or running out of fuel.

### Vehicles

The game includes different vehicle types with separate handling profiles:

- **Jeep:** balanced off-road vehicle
- **Drift Bike:** lighter and more agile, but easier to flip
- **Sports Car:** faster, but less forgiving on rough terrain

### Maps

Players can choose from multiple environments:

- Countryside
- Desert
- Arctic
- Moon

Each map changes the driving feel through terrain, gravity, grip, fog, snow, dust, or low-gravity effects.

### Progression

Coins are stored locally and can be used to unlock vehicles and buy upgrades. Achievements reward extra coins for milestones such as first run, distance goals, flips, speed, fuel efficiency, coin collection, and map-specific challenges.

## Onchain behavior

### Score saving

After a run ends, players can connect a wallet and save their score to the deployed scoreboard contract on Base. The contract stores each player’s best distance in meters and emits an event for every score submission.

### Run NFT minting

The crash snapshot is compressed locally as a proportional landscape JPEG (up to 960×540, quality 0.9) and packaged with NFT metadata. The wallet first signs a gas-free authorization bound to that run, account, app origin, contract and expiring server challenge. The server validates the signature and archive, uploads both files with the server-only `LIGHTHOUSE_API_KEY` and Lighthouse's `X-Storage-Type: annual` selection, and verifies delivery before the application opens the mint transaction.

Primary metadata and image URLs use the project's paid Lighthouse gateway only. The server returns a short-lived preparation result only after retrieving both exact files from that host with JSON/JPEG content types and matching bytes; upload acceptance alone cannot authorize minting. The application checks the result again at the wallet-send boundary. The `ipfs://` reference in `properties.files` is content-addressed provenance, not an alternate delivery fallback. New minting does not require `OPENSEA_API_KEY` or a marketplace refresh request.

The configured `NEXT_PUBLIC_LIGHTHOUSE_GATEWAY_URL` must be an HTTPS dedicated `*.lighthouseweb3.xyz/ipfs` host without credentials, query parameters or fragments. Empty or invalid values resolve to this project's supplied paid gateway. No other delivery host is used.

The approved ordering is **upload → verify image and metadata → wallet mint → confirm the actual mint event**. An upload or verification failure stops before the mint transaction, and a confirmed mint does not wait for another storage request. Canceling the later wallet transaction leaves any files already uploaded in storage. The application retains pending new transactions only for chain confirmation; old post-mint-upload records are not automatically resumed or recovered. Existing immutable NFTs are not modified.

Preparation requires the existing `BASE_RPC_URL`, `NEXT_PUBLIC_RUNNFT_ADDRESS`, `LIGHTHOUSE_API_KEY` and a canonical HTTPS `NEXT_PUBLIC_URL`. Request origin must match that app origin. Wallet authorization, strict package limits, and per-instance wallet/IP/service quotas limit abuse; these are not distributed quotas or proof of genuine gameplay. No new environment variable is required. See [NFT storage and minting reliability](docs/nft-storage-research.md) for historical evidence and limitations. Provider availability after verification and OpenSea indexing remain external dependencies. A read-only check for an existing token is available with `node scripts/verify-nft-delivery.mjs <tokenId>`.

### Gasless support

If the connected wallet supports paymaster services and the paymaster proxy is configured, score saving can use the sponsored transaction path. If sponsorship is unavailable, the app falls back to a normal wallet transaction.

## Tech stack

- Next.js 16
- React 19
- TypeScript
- planck-js
- viem
- Solidity
- Base mainnet

---

## License

This project is licensed under the [MIT License](./LICENSE).
