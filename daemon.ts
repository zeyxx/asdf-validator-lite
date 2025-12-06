/**
 * asdf-validator-lite daemon
 *
 * Track creator fees for a SINGLE Pump.fun token.
 *
 * Key difference from asdf-validator:
 * - Monitors a specific bonding curve account
 * - Deserializes BC data to track exact creator fees
 * - Also monitors AMM pool fees after migration
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import * as fs from 'fs';

// ============================================================================
// Program IDs
// ============================================================================

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_SWAP_PROGRAM = new PublicKey('PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP');

// ============================================================================
// Bonding Curve Account Structure
// ============================================================================

/**
 * Pump.fun Bonding Curve Account Layout:
 *
 * discriminator:         8 bytes (anchor discriminator)
 * virtual_token_reserves: u64 (8 bytes)
 * virtual_sol_reserves:   u64 (8 bytes)
 * real_token_reserves:    u64 (8 bytes)
 * real_sol_reserves:      u64 (8 bytes)
 * token_total_supply:     u64 (8 bytes)
 * complete:               bool (1 byte)
 * creator:                Pubkey (32 bytes)
 */

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
  // Structure: 8 (discriminator) + 40 (5 u64s) + 1 (bool) + 32 (pubkey) = 81 bytes minimum
  if (data.length < 81) return null;

  try {
    // Skip 8-byte discriminator
    let offset = 8;

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

export function deriveAMMCreatorVault(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), creator.toBuffer()],
    PUMP_SWAP_PROGRAM
  );
  return pda;
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
}

export interface HistoryLog {
  version: string;
  mint: string;
  symbol: string;
  bondingCurve: string;
  creator: string;
  creatorVaultBC: string;
  creatorVaultAMM: string;
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

    // Check sequence
    if (entry.sequence !== i + 1) {
      return {
        valid: false,
        entryIndex: i,
        error: `Expected sequence ${i + 1}, got ${entry.sequence}`,
      };
    }

    // Check prevHash linkage
    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        entryIndex: i,
        error: `prevHash mismatch`,
      };
    }

    // Recompute and verify hash
    const { hash, ...entryWithoutHash } = entry;
    const computedHash = computeEntryHash(entryWithoutHash);
    if (computedHash !== hash) {
      return {
        valid: false,
        entryIndex: i,
        error: `Hash mismatch`,
      };
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
// Daemon Configuration
// ============================================================================

export interface TokenInfo {
  mint: PublicKey;
  symbol: string;
  bondingCurve: PublicKey;
  creator: PublicKey;
  creatorVaultBC: PublicKey;
  creatorVaultAMM: PublicKey;
  migrated: boolean;
}

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

  // Balance tracking
  private lastBCBalance: bigint = 0n;
  private lastAMMBalance: bigint = 0n;

  // Fee totals
  private bcFees: bigint = 0n;
  private ammFees: bigint = 0n;

  // Proof-of-History
  private historyLog: HistoryLog | null = null;

  constructor(config: DaemonConfig) {
    this.config = {
      pollInterval: 5000,
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
    this.log(`Migrated: ${this.tokenInfo.migrated}`);

    // Initialize balances
    await this.initializeBalances();

    // Initialize history if enabled
    if (this.config.historyFile) {
      this.initializeHistory();
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

    // Save history
    if (this.historyLog && this.config.historyFile) {
      this.saveHistory();
    }

    this.log('Daemon stopped');
  }

  private async initializeToken(): Promise<void> {
    const mint = new PublicKey(this.config.mint);

    // Derive or use provided bonding curve
    const bondingCurve = this.config.bondingCurve
      ? new PublicKey(this.config.bondingCurve)
      : deriveBondingCurve(mint);

    // Fetch bonding curve account to get creator
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
    const creatorVaultAMM = deriveAMMCreatorVault(creator);

    this.tokenInfo = {
      mint,
      symbol: this.config.symbol || 'TOKEN',
      bondingCurve,
      creator,
      creatorVaultBC,
      creatorVaultAMM,
      migrated: bcData.complete,
    };
  }

  private async initializeBalances(): Promise<void> {
    if (!this.tokenInfo) return;

    // Get BC vault balance
    try {
      const bcBalance = await this.connection.getBalance(this.tokenInfo.creatorVaultBC);
      this.lastBCBalance = BigInt(bcBalance);
      this.log(`BC vault initial: ${Number(this.lastBCBalance) / 1e9} SOL`);
    } catch {
      this.lastBCBalance = 0n;
    }

    // Get AMM vault balance
    try {
      const ammBalance = await this.connection.getBalance(this.tokenInfo.creatorVaultAMM);
      this.lastAMMBalance = BigInt(ammBalance);
      this.log(`AMM vault initial: ${Number(this.lastAMMBalance) / 1e9} SOL`);
    } catch {
      this.lastAMMBalance = 0n;
    }
  }

  private initializeHistory(): void {
    if (!this.tokenInfo) return;

    // Try to load existing history
    if (this.config.historyFile && fs.existsSync(this.config.historyFile)) {
      try {
        this.historyLog = loadHistoryLog(this.config.historyFile);
        this.log(`Loaded existing history with ${this.historyLog.entryCount} entries`);

        // Restore totals
        this.bcFees = BigInt(this.historyLog.totalFees);

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

      // Poll BC vault
      await this.pollVault('BC', this.tokenInfo.creatorVaultBC);

      // Poll AMM vault (if migrated or always check)
      await this.pollVault('AMM', this.tokenInfo.creatorVaultAMM);

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

  private async pollVault(vaultType: VaultType, vault: PublicKey): Promise<void> {
    try {
      const slotInfo = await this.connection.getSlot();
      const balance = await this.connection.getBalance(vault);
      const currentBalance = BigInt(balance);
      const timestamp = Date.now();

      const lastBalance = vaultType === 'BC' ? this.lastBCBalance : this.lastAMMBalance;
      const delta = currentBalance - lastBalance;

      if (delta !== 0n) {
        const eventType: HistoryEventType = delta > 0n ? 'FEE' : 'CLAIM';

        this.handleBalanceChange(eventType, vaultType, vault, delta, lastBalance, currentBalance, slotInfo, timestamp);

        if (vaultType === 'BC') {
          this.lastBCBalance = currentBalance;
        } else {
          this.lastAMMBalance = currentBalance;
        }
      }
    } catch (error) {
      this.log(`Error polling ${vaultType} vault: ${error}`);
    }
  }

  private handleBalanceChange(
    eventType: HistoryEventType,
    vaultType: VaultType,
    vault: PublicKey,
    delta: bigint,
    balanceBefore: bigint,
    balanceAfter: bigint,
    slot: number,
    timestamp: number
  ): void {
    const absDelta = delta < 0n ? -delta : delta;

    if (eventType === 'FEE') {
      if (vaultType === 'BC') {
        this.bcFees += absDelta;
      } else {
        this.ammFees += absDelta;
      }

      const sol = Number(absDelta) / 1e9;
      this.log(`${vaultType}: +${sol} SOL`);

      if (this.config.onFeeDetected) {
        this.config.onFeeDetected(absDelta, vaultType, balanceAfter);
      }
    } else {
      const sol = Number(absDelta) / 1e9;
      this.log(`${vaultType}: CLAIM -${sol} SOL`);
    }

    // Add to history
    if (this.historyLog) {
      const entry = this.createHistoryEntry(
        eventType,
        vaultType,
        vault.toBase58(),
        delta.toString(),
        balanceBefore.toString(),
        balanceAfter.toString(),
        slot,
        timestamp
      );

      this.historyLog.entries.push(entry);
      this.saveHistory();

      if (this.config.onHistoryEntry) {
        this.config.onHistoryEntry(entry);
      }
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
    timestamp: number
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

// Export everything
export default ValidatorLiteDaemon;
