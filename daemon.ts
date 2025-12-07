/**
 * asdf-validator-lite daemon
 *
 * Track creator fees for a SINGLE Pump.fun token.
 *
 * Key features:
 * - Transaction-based tracking (not balance polling)
 * - Monitors BC vault (native SOL) and AMM vault (WSOL token account)
 * - Proof-of-History with transaction signatures
 * - Handles PumpXIsBack referral fees
 */

import { Connection, PublicKey, ConfirmedSignatureInfo } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { createHash } from 'crypto';
import * as fs from 'fs';

// ============================================================================
// Program IDs & Constants
// ============================================================================

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ============================================================================
// Bonding Curve Account Structure
// ============================================================================

interface BondingCurveData {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
}

function deserializeBondingCurve(data: Buffer): BondingCurveData | null {
  if (data.length < 81) return null;

  try {
    let offset = 8; // Skip discriminator

    const virtualTokenReserves = data.readBigUInt64LE(offset); offset += 8;
    const virtualSolReserves = data.readBigUInt64LE(offset); offset += 8;
    const realTokenReserves = data.readBigUInt64LE(offset); offset += 8;
    const realSolReserves = data.readBigUInt64LE(offset); offset += 8;
    const tokenTotalSupply = data.readBigUInt64LE(offset); offset += 8;
    const complete = data[offset] === 1; offset += 1;
    const creator = new PublicKey(data.subarray(offset, offset + 32));

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      creator,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// PDA Derivation
// ============================================================================

export function deriveBondingCurve(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  return pda;
}

export function deriveCreatorVault(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  return pda;
}

export function deriveAMMPool(mint: PublicKey, index: number = 0): PublicKey {
  const indexBuffer = Buffer.alloc(2);
  indexBuffer.writeUInt16LE(index);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), mint.toBuffer(), WSOL_MINT.toBuffer(), indexBuffer],
    PUMP_AMM_PROGRAM
  );
  return pda;
}

export function deriveAMMCreatorVault(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), creator.toBuffer()],
    PUMP_AMM_PROGRAM
  );
  return pda;
}

export async function deriveAMMCreatorVaultATA(creator: PublicKey): Promise<PublicKey> {
  const creatorVault = deriveAMMCreatorVault(creator);
  return getAssociatedTokenAddress(WSOL_MINT, creatorVault, true);
}

// ============================================================================
// Proof-of-History Types
// ============================================================================

export const GENESIS_HASH = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

export type HistoryEventType = 'FEE' | 'CLAIM' | 'MIGRATE';
export type VaultType = 'BC' | 'AMM';

export interface HistoryEntry {
  sequence: number;
  prevHash: string;
  eventType: HistoryEventType;
  vaultType: VaultType;
  vault: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  slot: number;
  timestamp: number;
  date: string;
  hash: string;
  txSignature: string;
}

export interface HistoryLog {
  version: string;
  mint: string;
  symbol: string;
  bondingCurve: string;
  creator: string;
  creatorVaultBC: string;
  creatorVaultAMM: string;
  pool: string;
  migrated: boolean;
  startedAt: string;
  lastUpdated: string;
  totalFees: string;
  entryCount: number;
  latestHash: string;
  entries: HistoryEntry[];
}

export function computeEntryHash(entry: Omit<HistoryEntry, 'hash'>): string {
  const data = [
    entry.sequence.toString(),
    entry.prevHash,
    entry.eventType,
    entry.vaultType,
    entry.vault,
    entry.amount,
    entry.balanceBefore,
    entry.balanceAfter,
    entry.slot.toString(),
    entry.timestamp.toString(),
    entry.txSignature,
  ].join('|');

  return createHash('sha256').update(data).digest('hex');
}

export interface VerifyResult {
  valid: boolean;
  entryIndex?: number;
  error?: string;
}

export function verifyHistoryChain(log: HistoryLog): VerifyResult {
  if (log.entries.length === 0) {
    return { valid: true };
  }

  let expectedPrevHash = GENESIS_HASH;

  for (let i = 0; i < log.entries.length; i++) {
    const entry = log.entries[i];

    if (entry.sequence !== i + 1) {
      return { valid: false, entryIndex: i, error: `Expected sequence ${i + 1}, got ${entry.sequence}` };
    }

    if (entry.prevHash !== expectedPrevHash) {
      return { valid: false, entryIndex: i, error: `prevHash mismatch` };
    }

    const { hash, ...entryWithoutHash } = entry;
    const computedHash = computeEntryHash(entryWithoutHash);
    if (computedHash !== hash) {
      return { valid: false, entryIndex: i, error: `Hash mismatch` };
    }

    expectedPrevHash = hash;
  }

  return { valid: true };
}

export function loadHistoryLog(filePath: string): HistoryLog {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as HistoryLog;
}

// ============================================================================
// Token Info
// ============================================================================

export interface TokenInfo {
  mint: PublicKey;
  symbol: string;
  bondingCurve: PublicKey;
  creator: PublicKey;
  creatorVaultBC: PublicKey;
  creatorVaultAMM: PublicKey; // WSOL ATA
  pool: PublicKey;
  migrated: boolean;
}

// ============================================================================
// Daemon Configuration
// ============================================================================

export interface DaemonConfig {
  rpcUrl: string;
  mint: string;
  symbol?: string;
  bondingCurve?: string;
  pollInterval?: number;
  verbose?: boolean;
  historyFile?: string;
  onFeeDetected?: (amount: bigint, vaultType: VaultType, balance: bigint) => void;
  onHistoryEntry?: (entry: HistoryEntry) => void;
  onMigration?: (ammVault: string) => void;
  onStats?: (totalFees: bigint, bcFees: bigint, ammFees: bigint) => void;
  statsInterval?: number;
}

// ============================================================================
// Validator Daemon
// ============================================================================

export class ValidatorLiteDaemon {
  private connection: Connection;
  private config: DaemonConfig;
  private running: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;

  // Token info
  private tokenInfo: TokenInfo | null = null;

  // Transaction tracking
  private lastBCSignature: string | null = null;
  private lastAMMSignature: string | null = null;
  private processedTxs: Set<string> = new Set();

  // Fee totals
  private bcFees: bigint = 0n;
  private ammFees: bigint = 0n;

  // Proof-of-History
  private historyLog: HistoryLog | null = null;

  constructor(config: DaemonConfig) {
    this.config = {
      pollInterval: 2000,
      statsInterval: 60000,
      ...config,
    };
    this.connection = new Connection(config.rpcUrl, 'confirmed');
  }

  private log(message: string): void {
    if (this.config.verbose) {
      const time = new Date().toISOString().slice(11, 19);
      console.log(`[${time}] ${message}`);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.log('Starting validator-lite daemon...');

    // Initialize token info
    await this.initializeToken();

    if (!this.tokenInfo) {
      throw new Error('Failed to initialize token info');
    }

    this.log(`Mint: ${this.tokenInfo.mint.toBase58()}`);
    this.log(`Symbol: ${this.tokenInfo.symbol}`);
    this.log(`Bonding Curve: ${this.tokenInfo.bondingCurve.toBase58()}`);
    this.log(`Creator: ${this.tokenInfo.creator.toBase58()}`);
    this.log(`Creator Vault (BC): ${this.tokenInfo.creatorVaultBC.toBase58()}`);
    this.log(`Creator Vault (AMM): ${this.tokenInfo.creatorVaultAMM.toBase58()}`);
    this.log(`Pool: ${this.tokenInfo.pool.toBase58()}`);
    this.log(`Migrated: ${this.tokenInfo.migrated}`);

    // Initialize history if enabled
    if (this.config.historyFile) {
      await this.initializeHistory();
    }

    this.running = true;

    // Start polling
    this.pollTimer = setInterval(() => this.poll(), this.config.pollInterval!);

    // Start stats reporting
    if (this.config.onStats) {
      this.statsTimer = setInterval(() => {
        this.config.onStats!(this.getTotalFees(), this.bcFees, this.ammFees);
      }, this.config.statsInterval!);
    }

    this.log('Daemon started');
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    if (this.historyLog && this.config.historyFile) {
      this.saveHistory();
    }

    this.log('Daemon stopped');
  }

  private async initializeToken(): Promise<void> {
    const mint = new PublicKey(this.config.mint);

    const bondingCurve = this.config.bondingCurve
      ? new PublicKey(this.config.bondingCurve)
      : deriveBondingCurve(mint);

    const bcAccountInfo = await this.connection.getAccountInfo(bondingCurve);

    if (!bcAccountInfo) {
      throw new Error(`Bonding curve account not found: ${bondingCurve.toBase58()}`);
    }

    const bcData = deserializeBondingCurve(bcAccountInfo.data);

    if (!bcData) {
      throw new Error('Failed to deserialize bonding curve data');
    }

    const creator = bcData.creator;
    const creatorVaultBC = deriveCreatorVault(creator);
    const creatorVaultAMM = await deriveAMMCreatorVaultATA(creator);
    const pool = deriveAMMPool(mint, 0);

    this.tokenInfo = {
      mint,
      symbol: this.config.symbol || 'TOKEN',
      bondingCurve,
      creator,
      creatorVaultBC,
      creatorVaultAMM,
      pool,
      migrated: bcData.complete,
    };
  }

  private async initializeHistory(): Promise<void> {
    if (!this.tokenInfo) return;

    // Try to load existing history
    if (this.config.historyFile && fs.existsSync(this.config.historyFile)) {
      try {
        this.historyLog = loadHistoryLog(this.config.historyFile);
        this.log(`Loaded existing history with ${this.historyLog.entryCount} entries`);

        // Restore totals and processed txs
        for (const entry of this.historyLog.entries) {
          this.processedTxs.add(entry.txSignature);
          const amount = BigInt(entry.amount);
          if (entry.eventType === 'FEE' && amount > 0n) {
            if (entry.vaultType === 'BC') {
              this.bcFees += amount;
            } else {
              this.ammFees += amount;
            }
          }
        }

        return;
      } catch (error) {
        this.log(`Failed to load history, starting fresh: ${error}`);
      }
    }

    // Create new history
    this.historyLog = {
      version: '1.0.0',
      mint: this.tokenInfo.mint.toBase58(),
      symbol: this.tokenInfo.symbol,
      bondingCurve: this.tokenInfo.bondingCurve.toBase58(),
      creator: this.tokenInfo.creator.toBase58(),
      creatorVaultBC: this.tokenInfo.creatorVaultBC.toBase58(),
      creatorVaultAMM: this.tokenInfo.creatorVaultAMM.toBase58(),
      pool: this.tokenInfo.pool.toBase58(),
      migrated: this.tokenInfo.migrated,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      totalFees: '0',
      entryCount: 0,
      latestHash: GENESIS_HASH,
      entries: [],
    };

    this.saveHistory();
  }

  private saveHistory(): void {
    if (!this.historyLog || !this.config.historyFile) return;

    this.historyLog.lastUpdated = new Date().toISOString();
    this.historyLog.totalFees = (this.bcFees + this.ammFees).toString();
    this.historyLog.entryCount = this.historyLog.entries.length;

    if (this.historyLog.entries.length > 0) {
      this.historyLog.latestHash = this.historyLog.entries[this.historyLog.entries.length - 1].hash;
    }

    fs.writeFileSync(this.config.historyFile, JSON.stringify(this.historyLog, null, 2));
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.tokenInfo) return;

    try {
      // Check for migration
      if (!this.tokenInfo.migrated) {
        await this.checkMigration();
      }

      // Poll BC vault transactions
      await this.pollVaultTransactions('BC', this.tokenInfo.creatorVaultBC);

      // Poll AMM vault transactions (WSOL token account)
      if (this.tokenInfo.migrated) {
        await this.pollAMMVaultTransactions();
      }

    } catch (error) {
      this.log(`Poll error: ${error}`);
    }
  }

  private async checkMigration(): Promise<void> {
    if (!this.tokenInfo) return;

    try {
      const bcAccountInfo = await this.connection.getAccountInfo(this.tokenInfo.bondingCurve);

      if (bcAccountInfo) {
        const bcData = deserializeBondingCurve(bcAccountInfo.data);

        if (bcData && bcData.complete && !this.tokenInfo.migrated) {
          this.tokenInfo.migrated = true;
          this.log('Token has migrated to AMM!');

          if (this.historyLog) {
            this.historyLog.migrated = true;
            this.saveHistory();
          }

          if (this.config.onMigration) {
            this.config.onMigration(this.tokenInfo.creatorVaultAMM.toBase58());
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  private async pollVaultTransactions(vaultType: VaultType, vault: PublicKey): Promise<void> {
    try {
      // Get recent signatures (most recent first)
      const signatures = await this.connection.getSignaturesForAddress(vault, {
        limit: 50,
      });

      if (signatures.length === 0) return;

      // On first poll, just record the latest signature (skip historical)
      if (!this.lastBCSignature) {
        this.lastBCSignature = signatures[0].signature;
        this.log(`BC: Initialized at signature ${signatures[0].signature.slice(0, 8)}...`);
        return;
      }

      // Find new transactions (those newer than lastSignature)
      const newSigs: typeof signatures = [];
      for (const sig of signatures) {
        if (sig.signature === this.lastBCSignature) break;
        if (!this.processedTxs.has(sig.signature)) {
          newSigs.push(sig);
        }
      }

      if (newSigs.length === 0) return;

      // Process in chronological order (oldest first)
      for (const sig of newSigs.reverse()) {
        await this.processTransaction(vaultType, vault, sig);
        this.processedTxs.add(sig.signature);
      }

      // Update last signature
      this.lastBCSignature = signatures[0].signature;

    } catch (error) {
      this.log(`Error polling ${vaultType} transactions: ${error}`);
    }
  }

  private async pollAMMVaultTransactions(): Promise<void> {
    if (!this.tokenInfo) return;

    const vault = this.tokenInfo.creatorVaultAMM;

    try {
      // Get recent signatures (most recent first)
      const signatures = await this.connection.getSignaturesForAddress(vault, {
        limit: 50,
      });

      if (signatures.length === 0) return;

      // On first poll, just record the latest signature (skip historical)
      if (!this.lastAMMSignature) {
        this.lastAMMSignature = signatures[0].signature;
        this.log(`AMM: Initialized at signature ${signatures[0].signature.slice(0, 8)}...`);
        return;
      }

      // Find new transactions (those newer than lastSignature)
      const newSigs: typeof signatures = [];
      for (const sig of signatures) {
        if (sig.signature === this.lastAMMSignature) break;
        if (!this.processedTxs.has(sig.signature)) {
          newSigs.push(sig);
        }
      }

      if (newSigs.length === 0) return;

      // Process in chronological order (oldest first)
      for (const sig of newSigs.reverse()) {
        await this.processAMMTransaction(vault, sig);
        this.processedTxs.add(sig.signature);
      }

      // Update last signature
      this.lastAMMSignature = signatures[0].signature;

    } catch (error) {
      this.log(`Error polling AMM transactions: ${error}`);
    }
  }

  private async processTransaction(
    vaultType: VaultType,
    vault: PublicKey,
    sigInfo: ConfirmedSignatureInfo
  ): Promise<void> {
    if (!this.tokenInfo) return;

    try {
      const tx = await this.connection.getTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta) return;

      // Get account keys
      const accountKeys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58());
      const loadedAddresses = tx.meta.loadedAddresses;
      if (loadedAddresses) {
        accountKeys.push(...loadedAddresses.writable.map(k => k.toBase58()));
        accountKeys.push(...loadedAddresses.readonly.map(k => k.toBase58()));
      }

      // Check if this transaction involves our token (mint or bonding curve present)
      const involveOurToken = accountKeys.includes(this.tokenInfo.mint.toBase58()) ||
                              accountKeys.includes(this.tokenInfo.bondingCurve.toBase58());

      if (!involveOurToken) return;

      // Find vault index and calculate delta
      const vaultIndex = accountKeys.indexOf(vault.toBase58());
      if (vaultIndex === -1) return;

      const preBalance = BigInt(tx.meta.preBalances[vaultIndex] || 0);
      const postBalance = BigInt(tx.meta.postBalances[vaultIndex] || 0);
      const delta = postBalance - preBalance;

      if (delta <= 0n) return; // Only track fees (positive delta)

      const timestamp = (tx.blockTime || 0) * 1000;

      this.bcFees += delta;

      this.log(`${vaultType}: +${Number(delta) / 1e9} SOL (${sigInfo.signature.slice(0, 8)}...)`);

      if (this.config.onFeeDetected) {
        this.config.onFeeDetected(delta, vaultType, postBalance);
      }

      // Add to history
      if (this.historyLog) {
        const entry = this.createHistoryEntry(
          'FEE',
          vaultType,
          vault.toBase58(),
          delta.toString(),
          preBalance.toString(),
          postBalance.toString(),
          tx.slot,
          timestamp,
          sigInfo.signature
        );

        this.historyLog.entries.push(entry);
        this.saveHistory();

        if (this.config.onHistoryEntry) {
          this.config.onHistoryEntry(entry);
        }
      }

    } catch (error) {
      this.log(`Error processing tx ${sigInfo.signature}: ${error}`);
    }
  }

  private async processAMMTransaction(
    vault: PublicKey,
    sigInfo: ConfirmedSignatureInfo
  ): Promise<void> {
    if (!this.tokenInfo) return;

    try {
      const tx = await this.connection.getTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta) return;

      // Get account keys
      const accountKeys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58());
      const loadedAddresses = tx.meta.loadedAddresses;
      if (loadedAddresses) {
        accountKeys.push(...loadedAddresses.writable.map(k => k.toBase58()));
        accountKeys.push(...loadedAddresses.readonly.map(k => k.toBase58()));
      }

      // Check if this transaction involves our token (mint or pool present)
      const involveOurToken = accountKeys.includes(this.tokenInfo.mint.toBase58()) ||
                              accountKeys.includes(this.tokenInfo.pool.toBase58());

      if (!involveOurToken) return;

      // Find vault in token balances (WSOL)
      const vaultAddress = vault.toBase58();
      const preTokenBalances = tx.meta.preTokenBalances || [];
      const postTokenBalances = tx.meta.postTokenBalances || [];

      // Find the token balance entry for our vault
      let preBalance = 0n;
      let postBalance = 0n;

      for (const bal of preTokenBalances) {
        if (accountKeys[bal.accountIndex] === vaultAddress) {
          preBalance = BigInt(bal.uiTokenAmount.amount);
          break;
        }
      }

      for (const bal of postTokenBalances) {
        if (accountKeys[bal.accountIndex] === vaultAddress) {
          postBalance = BigInt(bal.uiTokenAmount.amount);
          break;
        }
      }

      const delta = postBalance - preBalance;

      if (delta <= 0n) return; // Only track fees (positive delta)

      const timestamp = (tx.blockTime || 0) * 1000;

      this.ammFees += delta;

      this.log(`AMM: +${Number(delta) / 1e9} SOL (${sigInfo.signature.slice(0, 8)}...)`);

      if (this.config.onFeeDetected) {
        this.config.onFeeDetected(delta, 'AMM', postBalance);
      }

      // Add to history
      if (this.historyLog) {
        const entry = this.createHistoryEntry(
          'FEE',
          'AMM',
          vaultAddress,
          delta.toString(),
          preBalance.toString(),
          postBalance.toString(),
          tx.slot,
          timestamp,
          sigInfo.signature
        );

        this.historyLog.entries.push(entry);
        this.saveHistory();

        if (this.config.onHistoryEntry) {
          this.config.onHistoryEntry(entry);
        }
      }

    } catch (error) {
      this.log(`Error processing AMM tx ${sigInfo.signature}: ${error}`);
    }
  }

  private createHistoryEntry(
    eventType: HistoryEventType,
    vaultType: VaultType,
    vault: string,
    amount: string,
    balanceBefore: string,
    balanceAfter: string,
    slot: number,
    timestamp: number,
    txSignature: string
  ): HistoryEntry {
    const prevHash = this.historyLog!.entries.length > 0
      ? this.historyLog!.entries[this.historyLog!.entries.length - 1].hash
      : GENESIS_HASH;

    const sequence = this.historyLog!.entries.length + 1;

    const entryWithoutHash = {
      sequence,
      prevHash,
      eventType,
      vaultType,
      vault,
      amount,
      balanceBefore,
      balanceAfter,
      slot,
      timestamp,
      date: new Date(timestamp).toISOString(),
      txSignature,
    };

    const hash = computeEntryHash(entryWithoutHash);

    return { ...entryWithoutHash, hash };
  }

  // Public getters
  isRunning(): boolean {
    return this.running;
  }

  getTotalFees(): bigint {
    return this.bcFees + this.ammFees;
  }

  getBCFees(): bigint {
    return this.bcFees;
  }

  getAMMFees(): bigint {
    return this.ammFees;
  }

  getTokenInfo(): TokenInfo | null {
    return this.tokenInfo;
  }

  getHistoryLog(): HistoryLog | null {
    return this.historyLog;
  }
}

export default ValidatorLiteDaemon;
