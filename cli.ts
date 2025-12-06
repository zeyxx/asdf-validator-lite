#!/usr/bin/env node
/**
 * asdf-validator-lite CLI
 *
 * Track creator fees for a SINGLE Pump.fun token.
 *
 * Usage:
 *   npx asdf-validator-lite --mint <ADDRESS>
 *   asdf-validator-lite -m <ADDRESS> --symbol MYTOKEN -v
 */

import {
  ValidatorLiteDaemon,
  HistoryLog,
  verifyHistoryChain,
  loadHistoryLog,
} from './daemon';
import { PublicKey } from '@solana/web3.js';
import * as fs from 'fs';

// ============================================================================
// Argument Parsing
// ============================================================================

interface CLIArgs {
  mint: string | null;
  symbol: string;
  bondingCurve: string | null;
  rpcUrl: string;
  verbose: boolean;
  showHelp: boolean;
  pollInterval: number;
  historyFile: string | null;
  verifyFile: string | null;
}

function parseArgs(args: string[]): CLIArgs {
  const result: CLIArgs = {
    mint: null,
    symbol: 'TOKEN',
    bondingCurve: null,
    rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    verbose: false,
    showHelp: false,
    pollInterval: 5000,
    historyFile: null,
    verifyFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.showHelp = true;
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true;
    } else if (arg === '--mint' || arg === '-m') {
      result.mint = args[++i];
    } else if (arg === '--symbol' || arg === '-s') {
      result.symbol = args[++i];
    } else if (arg === '--bonding-curve' || arg === '-b') {
      result.bondingCurve = args[++i];
    } else if (arg === '--rpc' || arg === '-r') {
      result.rpcUrl = args[++i];
    } else if (arg === '--interval' || arg === '-i') {
      result.pollInterval = parseInt(args[++i], 10) * 1000;
    } else if (arg === '--history' || arg === '-H') {
      result.historyFile = args[++i];
    } else if (arg === '--verify' || arg === '-V') {
      result.verifyFile = args[++i];
    } else if (arg.startsWith('--mint=')) {
      result.mint = arg.split('=')[1];
    } else if (arg.startsWith('--symbol=')) {
      result.symbol = arg.split('=')[1];
    } else if (arg.startsWith('--rpc=')) {
      result.rpcUrl = arg.split('=')[1];
    } else if (arg.startsWith('--history=')) {
      result.historyFile = arg.split('=')[1];
    } else if (arg.startsWith('--verify=')) {
      result.verifyFile = arg.split('=')[1];
    }
  }

  return result;
}

function showHelp(): void {
  console.log(`
🎯 asdf-validator-lite

Track creator fees for a SINGLE Pump.fun token with Proof-of-History.

USAGE:
  asdf-validator-lite --mint <ADDRESS> [options]
  asdf-validator-lite --verify <FILE>

REQUIRED:
  --mint, -m <ADDRESS>       Token mint address

OPTIONS:
  --symbol, -s <SYMBOL>      Token symbol (default: TOKEN)
  --bonding-curve, -b <ADDR> Bonding curve address (auto-derived if not set)
  --rpc, -r <URL>            RPC URL (default: mainnet public)
  --interval, -i <SECONDS>   Poll interval (default: 5)
  --history, -H <FILE>       Enable Proof-of-History, save to FILE
  --verify, -V <FILE>        Verify a Proof-of-History file (standalone)
  --verbose, -v              Enable verbose logging
  --help, -h                 Show this help

ENVIRONMENT:
  RPC_URL                    Default RPC URL

EXAMPLES:
  # Track fees for a specific token
  npx asdf-validator-lite -m TokenMintAddress...

  # With symbol and Proof-of-History
  npx asdf-validator-lite -m TokenMint... -s MYTOKEN -H history.json -v

  # Verify an existing history file
  npx asdf-validator-lite --verify history.json

HOW IT WORKS:
  1. Derives bonding curve from mint address
  2. Reads creator from bonding curve data
  3. Monitors creator vaults (BC + AMM) for this token's creator
  4. Tracks fees with cryptographic Proof-of-History
  5. Detects token migration to AMM

Press Ctrl+C to stop and see final stats.
`);
}

// ============================================================================
// Verify Command
// ============================================================================

function verifyHistoryFile(filePath: string): void {
  console.log('\n🔍 PROOF-OF-HISTORY VERIFICATION');
  console.log('═'.repeat(55));
  console.log(`File: ${filePath}\n`);

  // Load the file
  let log: HistoryLog;
  try {
    log = loadHistoryLog(filePath);
  } catch (error) {
    console.error(`❌ Failed to load file: ${error}`);
    process.exit(1);
  }

  // Display metadata
  console.log('📋 METADATA');
  console.log('─'.repeat(40));
  console.log(`Version:     ${log.version}`);
  console.log(`Mint:        ${log.mint}`);
  console.log(`Symbol:      ${log.symbol}`);
  console.log(`BC:          ${log.bondingCurve}`);
  console.log(`Creator:     ${log.creator}`);
  console.log(`Migrated:    ${log.migrated ? 'Yes' : 'No'}`);
  console.log(`Started:     ${log.startedAt}`);
  console.log(`Last Update: ${log.lastUpdated}`);
  console.log(`Total Fees:  ${(Number(log.totalFees) / 1e9).toFixed(9)} SOL`);
  console.log(`Entries:     ${log.entryCount}`);
  console.log(`Latest Hash: ${log.latestHash.slice(0, 16)}...`);
  console.log('');

  // Verify chain
  console.log('🔗 CHAIN VERIFICATION');
  console.log('─'.repeat(40));

  const result = verifyHistoryChain(log);

  if (result.valid) {
    console.log('✅ All hashes valid');
    console.log('✅ Chain linkage verified');
    console.log('✅ Sequence numbers correct');
    console.log('');
    console.log('═'.repeat(55));
    console.log('✅ PROOF-OF-HISTORY VERIFIED SUCCESSFULLY');
    console.log('═'.repeat(55));
  } else {
    console.log(`❌ Verification FAILED at entry ${result.entryIndex}`);
    console.log(`   Error: ${result.error}`);
    console.log('');
    console.log('═'.repeat(55));
    console.log('❌ PROOF-OF-HISTORY VERIFICATION FAILED');
    console.log('═'.repeat(55));
    process.exit(1);
  }

  // Show recent entries
  if (log.entries.length > 0) {
    console.log('\n📜 RECENT ENTRIES (last 5)');
    console.log('─'.repeat(40));
    const recent = log.entries.slice(-5);
    for (const entry of recent) {
      const amount = BigInt(entry.amount);
      const sol = (Number(amount < 0n ? -amount : amount) / 1e9).toFixed(6);
      const sign = entry.eventType === 'CLAIM' ? '-' : '+';
      const icon = entry.eventType === 'CLAIM' ? '📤' : '💰';
      console.log(`#${entry.sequence} [${entry.date.slice(0, 19)}] ${icon} ${entry.vaultType}: ${sign}${sol} SOL (${entry.eventType})`);
      console.log(`   Hash: ${entry.hash.slice(0, 32)}...`);
    }
  }

  console.log('');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Handle --verify mode (standalone)
  if (args.verifyFile) {
    verifyHistoryFile(args.verifyFile);
    process.exit(0);
  }

  if (args.showHelp || !args.mint) {
    showHelp();
    process.exit(args.showHelp ? 0 : 1);
  }

  // Validate mint address
  let mint: PublicKey;
  try {
    mint = new PublicKey(args.mint);
  } catch {
    console.error('❌ Invalid mint address');
    process.exit(1);
  }

  console.log('\n🎯 ASDF VALIDATOR LITE');
  console.log('═'.repeat(55));
  console.log(`Mint:       ${mint.toBase58()}`);
  console.log(`Symbol:     ${args.symbol}`);
  console.log(`RPC:        ${args.rpcUrl.slice(0, 50)}...`);
  console.log(`Poll:       ${args.pollInterval / 1000}s`);
  if (args.historyFile) {
    console.log(`PoH:        ${args.historyFile} ✓`);
  }
  console.log('═'.repeat(55));

  // Create daemon
  const daemon = new ValidatorLiteDaemon({
    rpcUrl: args.rpcUrl,
    mint: args.mint,
    symbol: args.symbol,
    bondingCurve: args.bondingCurve || undefined,
    pollInterval: args.pollInterval,
    verbose: args.verbose,
    historyFile: args.historyFile || undefined,

    onFeeDetected: (amount, vaultType, balance) => {
      const sol = Number(amount) / 1e9;
      const time = new Date().toISOString().slice(11, 19);
      console.log(`[${time}] 💰 ${args.symbol} (${vaultType}): +${sol.toFixed(6)} SOL`);
    },

    onHistoryEntry: args.historyFile ? (entry) => {
      const icon = entry.eventType === 'CLAIM' ? '📤' : '🔗';
      console.log(`         ${icon} Hash: ${entry.hash.slice(0, 16)}... (${entry.eventType} #${entry.sequence})`);
    } : undefined,

    onMigration: (ammVault) => {
      console.log(`\n🚀 TOKEN MIGRATED TO AMM!`);
      console.log(`   AMM Vault: ${ammVault}\n`);
    },

    onStats: (total, bcFees, ammFees) => {
      console.log('\n📊 STATS');
      console.log('─'.repeat(40));
      console.log(`Total: ${(Number(total) / 1e9).toFixed(6)} SOL`);
      if (bcFees > 0n) {
        console.log(`  BC:  ${(Number(bcFees) / 1e9).toFixed(6)} SOL`);
      }
      if (ammFees > 0n) {
        console.log(`  AMM: ${(Number(ammFees) / 1e9).toFixed(6)} SOL`);
      }
      console.log('─'.repeat(40) + '\n');
    },
  });

  // Handle shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\n\n🛑 Shutting down...');
    daemon.stop();

    const total = daemon.getTotalFees();
    const bcFees = daemon.getBCFees();
    const ammFees = daemon.getAMMFees();
    const historyLog = daemon.getHistoryLog();
    const tokenInfo = daemon.getTokenInfo();

    console.log('\n📊 FINAL STATS');
    console.log('═'.repeat(40));
    console.log(`Token: ${tokenInfo?.symbol || args.symbol}`);
    console.log(`Total fees tracked: ${(Number(total) / 1e9).toFixed(6)} SOL`);

    if (bcFees > 0n) {
      console.log(`  BC:  ${(Number(bcFees) / 1e9).toFixed(6)} SOL`);
    }
    if (ammFees > 0n) {
      console.log(`  AMM: ${(Number(ammFees) / 1e9).toFixed(6)} SOL`);
    }

    // Show PoH summary if enabled
    if (historyLog && args.historyFile) {
      console.log('');
      console.log('🔗 PROOF-OF-HISTORY');
      console.log('─'.repeat(40));
      console.log(`Entries:     ${historyLog.entryCount}`);
      console.log(`Latest hash: ${historyLog.latestHash.slice(0, 32)}...`);
      console.log(`Saved to:    ${args.historyFile}`);
      console.log('');
      console.log('Verify with: npx asdf-validator-lite --verify ' + args.historyFile);
    }

    console.log('═'.repeat(40));
    console.log('\n✅ Goodbye!\n');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start daemon
  console.log('\n▶ Starting daemon...\n');
  await daemon.start();

  const tokenInfo = daemon.getTokenInfo();
  if (tokenInfo) {
    console.log(`\n📋 TOKEN INFO`);
    console.log('─'.repeat(40));
    console.log(`Mint:        ${tokenInfo.mint.toBase58()}`);
    console.log(`BC:          ${tokenInfo.bondingCurve.toBase58()}`);
    console.log(`Creator:     ${tokenInfo.creator.toBase58()}`);
    console.log(`BC Vault:    ${tokenInfo.creatorVaultBC.toBase58()}`);
    console.log(`AMM Vault:   ${tokenInfo.creatorVaultAMM.toBase58()}`);
    console.log(`Migrated:    ${tokenInfo.migrated ? 'Yes (AMM)' : 'No (Bonding Curve)'}`);
    console.log('─'.repeat(40));
  }

  console.log('\n✅ Daemon running. Press Ctrl+C to stop.\n');
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
