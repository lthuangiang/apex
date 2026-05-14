/**
 * SiweAuth — Sign-In with Ethereum (EIP-4361) authentication module.
 *
 * Flow:
 *   1. Client calls GET /api/auth/nonce  → receives a one-time nonce
 *   2. Client builds an EIP-4361 message, signs it with their wallet
 *   3. Client calls POST /api/auth/verify { message, signature }
 *   4. Server verifies signature, issues a session token (same cookie mechanism
 *      as the existing passcode auth so the rest of the app is unchanged)
 *
 * No extra npm packages needed — ethers v6 (already a dependency) handles
 * EIP-191 personal_sign recovery.  The EIP-4361 message is parsed manually
 * (a minimal subset sufficient for this use-case).
 */

import { randomBytes } from 'crypto';
import { ethers } from 'ethers';

// ── Nonce store ───────────────────────────────────────────────────────────────
// Nonces are single-use and expire after 5 minutes.
const NONCE_TTL_MS = 5 * 60 * 1000;

interface NonceEntry {
  nonce: string;
  expiresAt: number;
}

const nonceStore = new Map<string, NonceEntry>();

/** Purge expired nonces (called lazily on each generate). */
function purgeExpiredNonces(): void {
  const now = Date.now();
  for (const [key, entry] of nonceStore) {
    if (now > entry.expiresAt) nonceStore.delete(key);
  }
}

/** Generate a fresh nonce and store it. Returns the nonce string. */
export function generateNonce(): string {
  purgeExpiredNonces();
  const nonce = randomBytes(16).toString('hex');
  nonceStore.set(nonce, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  return nonce;
}

/** Consume a nonce (returns true if valid + not yet used, deletes it). */
function consumeNonce(nonce: string): boolean {
  const entry = nonceStore.get(nonce);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    nonceStore.delete(nonce);
    return false;
  }
  nonceStore.delete(nonce); // single-use
  return true;
}

// ── EIP-4361 message builder ──────────────────────────────────────────────────

export interface SiweMessageParams {
  domain: string;       // e.g. "drift.app"
  address: string;      // checksummed Ethereum address
  statement?: string;
  uri: string;          // e.g. "https://drift.app"
  version?: string;     // default "1"
  chainId?: number;     // default 1 (Ethereum mainnet)
  nonce: string;
  issuedAt?: string;    // ISO-8601, defaults to now
}

/** Build a canonical EIP-4361 SIWE message string. */
export function buildSiweMessage(params: SiweMessageParams): string {
  const {
    domain,
    address,
    statement = 'Sign in to DRIFT Trading Dashboard',
    uri,
    version = '1',
    chainId = 1,
    nonce,
    issuedAt = new Date().toISOString(),
  } = params;

  // Checksum the address
  const checksummed = ethers.getAddress(address);

  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    checksummed,
    '',
    statement,
    '',
    `URI: ${uri}`,
    `Version: ${version}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

// ── Verification ──────────────────────────────────────────────────────────────

export interface SiweVerifyResult {
  ok: boolean;
  address?: string;   // checksummed address on success
  error?: string;
}

/**
 * Verify a SIWE message + signature.
 *
 * Checks:
 *  - Nonce is valid and not yet used
 *  - Signature recovers to the address in the message
 *  - Message is not expired (issuedAt within last 10 minutes)
 */
export function verifySiweMessage(
  message: string,
  signature: string,
): SiweVerifyResult {
  try {
    // ── 1. Parse address and nonce from message ───────────────────────────
    // Address is on the second line of the EIP-4361 message (after the domain line)
    const lines = message.split('\n');
    // Find the address line: a line that is exactly a 0x-prefixed 40-char hex string
    const addressLine = lines.find(l => /^0x[a-fA-F0-9]{40}$/.test(l.trim()));
    const nonceMatch  = message.match(/^Nonce:\s*([0-9a-fA-F]+)\s*$/m);
    const issuedMatch = message.match(/^Issued At:\s*(.+?)\s*$/m);

    if (!addressLine) return { ok: false, error: 'Cannot parse address from message' };
    if (!nonceMatch)  return { ok: false, error: 'Cannot parse nonce from message' };

    const claimedAddress = addressLine.trim();
    const nonce          = nonceMatch[1].toLowerCase();

    // ── 2. Validate nonce ─────────────────────────────────────────────────
    if (!consumeNonce(nonce)) {
      return { ok: false, error: 'Invalid or expired nonce' };
    }

    // ── 3. Check issuedAt freshness (10-minute window) ────────────────────
    if (issuedMatch) {
      const issuedAt = new Date(issuedMatch[1]).getTime();
      if (isNaN(issuedAt) || Date.now() - issuedAt > 10 * 60 * 1000) {
        return { ok: false, error: 'Message expired' };
      }
    }

    // ── 4. Recover signer from personal_sign (EIP-191) ────────────────────
    const recoveredAddress = ethers.verifyMessage(message, signature);

    // ── 5. Compare addresses (case-insensitive) ───────────────────────────
    if (recoveredAddress.toLowerCase() !== claimedAddress.toLowerCase()) {
      return {
        ok: false,
        error: `Signature mismatch: recovered ${recoveredAddress}, claimed ${claimedAddress}`,
      };
    }

    return { ok: true, address: ethers.getAddress(recoveredAddress) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Verification failed' };
  }
}
