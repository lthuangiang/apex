import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// AES-256-GCM constants
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96-bit IV recommended for GCM
const TAG_BYTES = 16;  // 128-bit auth tag

/**
 * Credentials for a single exchange bot.
 * Fields mirror the env vars previously used by adapterFactory.
 */
export interface BotCredentials {
  exchange: 'sodex' | 'dango' | 'decibel' | 'hibachi' | 'ondoperps' | 'perpl';

  // SoDEX
  apiKey?: string;
  apiSecret?: string;    // EVM private key (0x...)
  subaccount?: string;   // EVM subaccount address

  // Decibel
  privateKey?: string;   // Ed25519 private key
  nodeApiKey?: string;
  builderAddress?: string;
  gasStationApiKey?: string;

  // Dango
  dangoPrivateKey?: string;  // Secp256k1 private key (no 0x)
  userAddress?: string;
  network?: 'mainnet' | 'testnet';

  // Hibachi
  hibachiApiKey?: string;
  hibachiAccountType?: 'trustless' | 'exchange_managed';
  hibachiPrivateKey?: string;   // ECDSA private key for trustless accounts (0x-prefixed)
  hibachiSecretKey?: string;    // HMAC secret for exchange_managed accounts
  hibachiAccountId?: string | number;  // Numeric account ID from Hibachi dashboard

  // OndoPerps
  apiKeyId?: string;
  apiKeySecret?: string;
  baseUrl?: string;

  // Perpl
  perplApiKey?: string;
  perplApiKeySecret?: string;  // Ed25519 private key hex
  perplChainId?: string | number;
  perplBaseUrl?: string;
}

/**
 * Encrypted credential envelope stored on disk.
 * One file per bot: `{dataDir}/credentials/{botId}.enc.json`
 */
interface EncryptedEnvelope {
  version: 1;
  iv: string;       // hex
  tag: string;      // hex
  ciphertext: string; // hex
}

/**
 * CredentialStore — per-tenant encrypted credential storage.
 *
 * Encrypts bot credentials with AES-256-GCM using MASTER_ENCRYPTION_KEY.
 * Each bot gets its own file: `{dataDir}/credentials/{botId}.enc.json`
 *
 * Security properties:
 * - Unique random IV per write — same plaintext never produces same ciphertext
 * - GCM auth tag — detects tampering before decryption
 * - Key never stored on disk — only in process.env.MASTER_ENCRYPTION_KEY
 */
export class CredentialStore {
  private readonly credsDir: string;

  constructor(private readonly dataDir: string) {
    this.credsDir = path.join(path.resolve(dataDir), 'credentials');
    fs.mkdirSync(this.credsDir, { recursive: true });
  }

  /**
   * Encrypt and persist credentials for a bot.
   * Overwrites any existing credentials for the same botId.
   */
  save(botId: string, creds: BotCredentials): void {
    const key = this._getKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const plaintext = JSON.stringify(creds);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: EncryptedEnvelope = {
      version: 1,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: encrypted.toString('hex'),
    };

    const filePath = this._filePath(botId);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);

    console.log(`[CredentialStore] Saved credentials for bot "${botId}"`);
  }

  /**
   * Load and decrypt credentials for a bot.
   * Returns null if no credentials file exists for this botId.
   * Throws if the file is tampered with (GCM auth tag mismatch).
   */
  load(botId: string): BotCredentials | null {
    const filePath = this._filePath(botId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const envelope: EncryptedEnvelope = JSON.parse(raw);

      const key = this._getKey();
      const iv = Buffer.from(envelope.iv, 'hex');
      const tag = Buffer.from(envelope.tag, 'hex');
      const ciphertext = Buffer.from(envelope.ciphertext, 'hex');

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf-8')) as BotCredentials;
    } catch (err: any) {
      // GCM auth failure or JSON parse error — treat as corrupted
      throw new Error(
        `[CredentialStore] Failed to decrypt credentials for bot "${botId}": ${err.message}`
      );
    }
  }

  /**
   * Delete credentials for a bot (called when bot is deleted).
   */
  delete(botId: string): void {
    const filePath = this._filePath(botId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[CredentialStore] Deleted credentials for bot "${botId}"`);
    }
  }

  /**
   * Check whether credentials exist for a bot.
   */
  has(botId: string): boolean {
    return fs.existsSync(this._filePath(botId));
  }

  // ---------------------------------------------------------------------------

  private _filePath(botId: string): string {
    // Sanitize botId to prevent path traversal
    const safe = botId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    return path.join(this.credsDir, `${safe}.enc.json`);
  }

  private _getKey(): Buffer {
    const raw = process.env.MASTER_ENCRYPTION_KEY;
    if (!raw) {
      throw new Error(
        '[CredentialStore] MASTER_ENCRYPTION_KEY is not set. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
    // Accept 64-char hex (32 bytes) or 32-char raw string
    if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    // Derive 32-byte key from arbitrary string via SHA-256
    return crypto.createHash('sha256').update(raw).digest();
  }
}
