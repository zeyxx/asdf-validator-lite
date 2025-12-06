# asdf-validator-lite

Track creator fees for a **SINGLE** Pump.fun token with cryptographic Proof-of-History.

## Difference from asdf-validator

| Feature | asdf-validator | asdf-validator-lite |
|---------|----------------|---------------------|
| Input | Creator address | Token mint address |
| Scope | All tokens from creator | Single token only |
| Complexity | Multi-token tracking | Lightweight |
| Use case | Creator analytics | Token-specific tracking |

## Install

```bash
npm install -g asdf-validator-lite
```

## Quick Start

```bash
# Track fees for a specific token
asdf-validator-lite --mint <TOKEN_MINT_ADDRESS>

# With symbol and Proof-of-History
asdf-validator-lite -m <MINT> -s MYTOKEN -H history.json -v

# Verify a history file
asdf-validator-lite --verify history.json
```

## What It Does

1. Derives bonding curve from mint address
2. Reads creator from bonding curve account data
3. Monitors creator vaults (BC + AMM) for this specific token
4. Tracks fees with cryptographic Proof-of-History
5. Detects token migration to AMM automatically

```
🎯 ASDF VALIDATOR LITE
═══════════════════════════════════════════════════════
Mint:       7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr
Symbol:     MYTOKEN
PoH:        history.json ✓
═══════════════════════════════════════════════════════

📋 TOKEN INFO
────────────────────────────────────────
Mint:        7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr
BC:          8Kag5u9jNtvMsoCDLMKM2VBm1LKyLdPZwq8gQT7D8KB3
Creator:     5ABC...xyz
BC Vault:    7DEF...uvw
AMM Vault:   9GHI...rst
Migrated:    No (Bonding Curve)
────────────────────────────────────────

✅ Daemon running. Press Ctrl+C to stop.

[12:34:56] 💰 MYTOKEN (BC): +0.001234 SOL
         🔗 Hash: c60d4ed93f68f412... (FEE #1)

🚀 TOKEN MIGRATED TO AMM!
   AMM Vault: 9GHI...rst

[12:45:00] 💰 MYTOKEN (AMM): +0.002345 SOL
         🔗 Hash: a164dd0b776b4f01... (FEE #2)
```

## Options

```
--mint, -m <ADDRESS>       Token mint address (required)
--symbol, -s <SYMBOL>      Token symbol (default: TOKEN)
--bonding-curve, -b <ADDR> Bonding curve address (auto-derived)
--rpc, -r <URL>            RPC URL (default: mainnet)
--interval, -i <SECONDS>   Poll interval (default: 5)
--history, -H <FILE>       Enable Proof-of-History, save to FILE
--verify, -V <FILE>        Verify a Proof-of-History file
--verbose, -v              Verbose logging
--help, -h                 Show help
```

## Proof-of-History

Same as asdf-validator - each event is recorded with:
- **SHA-256 hash** of event data
- **Chain linking** (prevHash → hash)
- **Solana slot number**
- **Timestamps** and balance snapshots

### Verify

```bash
asdf-validator-lite --verify history.json
```

### History File Format

```json
{
  "version": "1.0.0",
  "mint": "TOKEN_MINT",
  "symbol": "MYTOKEN",
  "bondingCurve": "BC_ADDRESS",
  "creator": "CREATOR_ADDRESS",
  "creatorVaultBC": "BC_VAULT",
  "creatorVaultAMM": "AMM_VAULT",
  "migrated": false,
  "totalFees": "1234567",
  "entryCount": 10,
  "entries": [...]
}
```

## Programmatic Usage

```typescript
import { ValidatorLiteDaemon } from 'asdf-validator-lite';

const daemon = new ValidatorLiteDaemon({
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  mint: 'TOKEN_MINT_ADDRESS',
  symbol: 'MYTOKEN',
  historyFile: 'history.json',
  verbose: true,

  onFeeDetected: (amount, vaultType, balance) => {
    console.log(`${vaultType}: +${Number(amount) / 1e9} SOL`);
  },

  onMigration: (ammVault) => {
    console.log(`Token migrated! AMM vault: ${ammVault}`);
  },

  onStats: (total, bcFees, ammFees) => {
    console.log(`Total: ${Number(total) / 1e9} SOL`);
  },
});

await daemon.start();

// Get token info
const tokenInfo = daemon.getTokenInfo();
console.log(`Creator: ${tokenInfo.creator.toBase58()}`);
console.log(`Migrated: ${tokenInfo.migrated}`);

// Later...
daemon.stop();
```

## API

### `ValidatorLiteDaemon`

```typescript
new ValidatorLiteDaemon(config: DaemonConfig)
```

#### Config

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `rpcUrl` | string | Yes | Solana RPC URL |
| `mint` | string | Yes | Token mint address |
| `symbol` | string | No | Token symbol (default: TOKEN) |
| `bondingCurve` | string | No | BC address (auto-derived) |
| `pollInterval` | number | No | Poll interval ms (default: 5000) |
| `verbose` | boolean | No | Enable logging |
| `historyFile` | string | No | Path to save PoH file |
| `onFeeDetected` | function | No | Fee callback |
| `onHistoryEntry` | function | No | PoH entry callback |
| `onMigration` | function | No | Migration callback |
| `onStats` | function | No | Stats callback |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `start()` | Promise | Start the daemon |
| `stop()` | void | Stop the daemon |
| `isRunning()` | boolean | Check if running |
| `getTotalFees()` | bigint | Total fees (BC + AMM) |
| `getBCFees()` | bigint | Bonding curve fees |
| `getAMMFees()` | bigint | AMM fees |
| `getTokenInfo()` | TokenInfo | Token details |
| `getHistoryLog()` | HistoryLog | PoH log |

### Utility Functions

```typescript
import {
  deriveBondingCurve,
  deriveCreatorVault,
  deriveAMMCreatorVault,
  verifyHistoryChain,
  loadHistoryLog,
} from 'asdf-validator-lite';

// Derive bonding curve from mint
const bc = deriveBondingCurve(mintPubkey);

// Derive creator vaults
const bcVault = deriveCreatorVault(creatorPubkey);
const ammVault = deriveAMMCreatorVault(creatorPubkey);

// Verify history
const history = loadHistoryLog('history.json');
const result = verifyHistoryChain(history);
```

## License

MIT
