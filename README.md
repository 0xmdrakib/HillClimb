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

Run NFT minting is temporarily disabled in the app.

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
