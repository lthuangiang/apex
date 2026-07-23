import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { BotCredentials } from './CredentialStore.js';

// AES-256-GCM constants (same as CredentialStore)
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Supported exchange types for Account Registry.
 */
export type AccountExchange = 'sodex' | 'dango' | 'decibel' | 'hibachi' | 'ondoperps' | 'perpl';

/**
 * Account connection type for UI grouping.
 */
export type AccountType = 'cex' | 'dex-wallet' | 'perp-dex';

/**
 * Public metadata for a connected exchange account (safe to send to frontend).
 * Credentials are stored separately in the encrypted file.
 */
export interface AccountEntry {
  /** Unique account identifier (uuid) */
  id: string;
  /** Exchange name */
  exchange: AccountExchange;
  /** Account connection type */
  type: AccountType;
  /** User-friendly label (e.g. "My SoDEX Main") */
  label: string;
  /** Truncated address or API key for display (e.g. "0x1234...abcd") */
  truncatedKey: string;
  /** ISO timestamp when the account was connected */
  createdAt: string;
  /** ISO timestamp of last balance sync (null if never synced) */
  lastSyncAt: string | null;
  /** Last known balance in USD (null if never fetched) */
  balanceUsd: number | null;
}

/**
 * Full account data including encrypted credentials (internal only).
 */
interface AccountRecord {
  meta: AccountEntry;
  credentials: BotCredentials;
}

/**
 * Encrypted envelope stored on disk for the full accounts file.
 */
interface EncryptedAccountsEnvelope {
  version: 1;
  iv: string;       // hex
  tag: string;      // hex
  ciphertext: string; // hex
}

/**
 * AccountRegistry — per-tenant exchange account storage.
 *
 * Allows users to connect exchange accounts ONCE and reuse them across
 * multiple bots. Credentials are encrypted with AES-256-GCM using the
 * same MASTER_ENCRYPTION_KEY as CredentialStore.
 *
 * Storage: `{dataDir}/accounts.enc.json` (single encrypted file per tenant)
 *
 * Design rationale:
 * - Single encrypted file (vs per-account files) for simpler listing/iteration
 * - Same encryption key derivation as CredentialStore for consistency
 * - Public metadata (AccountEntry) is derived at runtime from decrypted data
 */
export class AccountRegistry {
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    const resolvedDir = path.resolve(dataDir);
    fs.mkdirSync(resolvedDir, { recursive: true });
    this.filePath = path.join(resolvedDir, 'accounts.enc.json');
  }

  /**
   * Add a new exchange account.
   * Returns the created AccountEntry (public metadata).
   */
  add(label: string, type: AccountType, credentials: BotCredentials): AccountEntry {
    const records = this._loadAll();

    const id = crypto.randomUUID();
    const entry: AccountEntry = {
      id,
      exchange: credentials.exchange,
      type,
      label,
      truncatedKey: this._truncateKey(credentials),
      createdAt: new Date().toISOString(),
      lastSyncAt: null,
      balanceUsd: null,
    };

    records.push({ meta: entry, credentials });
    this._saveAll(records);

    console.log(`[AccountRegistry] Added account "${label}" (${credentials.exchange}) id=${id}`);
    return entry;
  }

  /**
   * List all connected accounts (public metadata only, no secrets).
   */
  list(): AccountEntry[] {
    return this._loadAll().map(r => r.meta);
  }

  /**
   * Get a single account's public metadata by ID.
   */
  get(accountId: string): AccountEntry | null {
    const record = this._loadAll().find(r => r.meta.id === accountId);
    return record?.meta ?? null;
  }

  /**
   * Get the decrypted credentials for an account (used internally when creating bots).
   */
  getCredentials(accountId: string): BotCredentials | null {
    const record = this._loadAll().find(r => r.meta.id === accountId);
    return record?.credentials ?? null;
  }

  /**
   * Delete an account by ID. Returns true if found and deleted.
   */
  delete(accountId: string): boolean {
    const records = this._loadAll();
    const idx = records.findIndex(r => r.meta.id === accountId);
    if (idx === -1) return false;

    const removed = records.splice(idx, 1)[0];
    this._saveAll(records);

    console.log(`[AccountRegistry] Deleted account "${removed.meta.label}" id=${accountId}`);
    return true;
  }

  /**
   * Update balance and lastSyncAt for an account.
   */
  updateBalance(accountId: string, balanceUsd: number): void {
    const records = this._loadAll();
    const record = records.find(r => r.meta.id === accountId);
    if (!record) return;

    record.meta.balanceUsd = balanceUsd;
    record.meta.lastSyncAt = new Date().toISOString();
    this._saveAll(records);
  }

  /**
   * Update account label.
   */
  updateLabel(accountId: string, label: string): void {
    const records = this._loadAll();
    const record = records.find(r => r.meta.id === accountId);
    if (!record) return;

    record.meta.label = label;
    this._saveAll(records);
  }

  /**
   * Check if any accounts exist.
   */
  hasAccounts(): boolean {
    return this._loadAll().length > 0;
  }

  /**
   * Get count of accounts.
   */
  count(): number {
    return this._loadAll().length;
  }

  // ─── Private Methods ──────────────────────────────────────────────────────

  /**
   * Load and decrypt all account records from disk.
   * Returns empty array if no file exists.
   */
  private _loadAll(): AccountRecord[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const envelope: EncryptedAccountsEnvelope = JSON.parse(raw);

      const key = this._getKey();
      const iv = Buffer.from(envelope.iv, 'hex');
      const tag = Buffer.from(envelope.tag, 'hex');
      const ciphertext = Buffer.from(envelope.ciphertext, 'hex');

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf-8')) as AccountRecord[];
    } catch (err: any) {
      console.error(`[AccountRegistry] Failed to decrypt accounts file: ${err.message}`);
      return [];
    }
  }

  /**
   * Encrypt and persist all account records to disk (atomic write).
   */
  private _saveAll(records: AccountRecord[]): void {
    const key = this._getKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const plaintext = JSON.stringify(records);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: EncryptedAccountsEnvelope = {
      version: 1,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: encrypted.toString('hex'),
    };

    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  /**
   * Derive the encryption key from MASTER_ENCRYPTION_KEY (same as CredentialStore).
   */
  private _getKey(): Buffer {
    const raw = process.env.MASTER_ENCRYPTION_KEY;
    if (!raw) {
      throw new Error(
        '[AccountRegistry] MASTER_ENCRYPTION_KEY is not set. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
    if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    return crypto.createHash('sha256').update(raw).digest();
  }

  /**
   * Generate a truncated display string from credentials.
   * Shows enough to identify the account without exposing secrets.
   */
  private _truncateKey(creds: BotCredentials): string {
    const exchange = creds.exchange;

    switch (exchange) {
      case 'sodex': {
        // Show truncated subaccount address
        const addr = creds.subaccount || creds.apiKey || '';
        return addr.length > 10
          ? `${addr.slice(0, 6)}...${addr.slice(-4)}`
          : addr || '(no key)';
      }
      case 'dango': {
        const addr = creds.userAddress || '';
        return addr.length > 10
          ? `${addr.slice(0, 6)}...${addr.slice(-4)}`
          : addr || '(no key)';
      }
      case 'decibel': {
        // Show truncated private key prefix
        const pk = creds.privateKey || '';
        return pk.length > 10
          ? `${pk.slice(0, 6)}...${pk.slice(-4)}`
          : pk || '(no key)';
      }
      case 'hibachi': {
        const key = creds.hibachiApiKey || '';
        return key.length > 10
          ? `${key.slice(0, 6)}...${key.slice(-4)}`
          : key || '(no key)';
      }
      case 'ondoperps': {
        const key = creds.apiKeyId || '';
        return key.length > 10
          ? `${key.slice(0, 6)}...${key.slice(-4)}`
          : key || '(no key)';
      }
      case 'perpl': {
        const key = creds.perplApiKey || '';
        return key.length > 10
          ? `${key.slice(0, 6)}...${key.slice(-4)}`
          : key || '(no key)';
      }
      default:
        return '(unknown)';
    }
  }
}
