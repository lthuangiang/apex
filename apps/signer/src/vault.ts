import { z } from "zod";

// Vault transit (docs/ARCHITECTURE.md mục 3.3.8): signer gửi plaintext đi mã hoá và nhận lại
// ciphertext `vault:vN:…`; khoá mã hoá không bao giờ rời Vault. Gọi bằng HTTP API, có timeout.

const TIMEOUT_MS = 5000;

export interface VaultTransit {
  readonly keyRef: string;
  encrypt(plaintext: Buffer): Promise<string>;
  decrypt(ciphertext: string): Promise<Buffer>;
}

/**
 * Vault trả 400 khi giải mã: ciphertext không thuộc khoá hiện có (khoá transit bị mất / thay) hoặc hỏng. Key
 * DRIFT khi đó không dùng được nữa, cần người dùng ký lại (UI_REVIEW H1, `API_KEY_UNUSABLE`). Lỗi khác
 * (5xx, mạng, timeout) là tạm thời.
 */
export class KeyUnusableError extends Error {
  constructor() {
    super("api key ciphertext cannot be decrypted");
  }
}

export interface VaultAuth {
  token?: string | undefined;
  roleId?: string | undefined;
  secretId?: string | undefined;
}

const loginSchema = z.object({ auth: z.object({ client_token: z.string() }) });
const encryptSchema = z.object({ data: z.object({ ciphertext: z.string().startsWith("vault:") }) });
const decryptSchema = z.object({ data: z.object({ plaintext: z.string() }) });

export async function connectVault(
  addr: string,
  auth: VaultAuth,
  key: string,
): Promise<VaultTransit> {
  const base = addr.replace(/\/+$/, "");
  let token = auth.token;
  if (token === undefined) {
    const body = await call(base, "POST", "/v1/auth/approle/login", undefined, {
      role_id: auth.roleId,
      secret_id: auth.secretId,
    });
    token = loginSchema.parse(body).auth.client_token;
  }
  const t = token;
  return {
    keyRef: `vault-transit:${key}`,
    async encrypt(plaintext) {
      const body = await call(base, "POST", `/v1/transit/encrypt/${key}`, t, {
        plaintext: plaintext.toString("base64"),
      });
      return encryptSchema.parse(body).data.ciphertext;
    },
    async decrypt(ciphertext) {
      const body = await call(base, "POST", `/v1/transit/decrypt/${key}`, t, { ciphertext }, true);
      return Buffer.from(decryptSchema.parse(body).data.plaintext, "base64");
    },
  };
}

async function call(
  base: string,
  method: string,
  path: string,
  token: string | undefined,
  body: unknown,
  decrypting = false,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["X-Vault-Token"] = token;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (decrypting && response.status === 400) throw new KeyUnusableError();
  if (!response.ok) {
    // Không đưa body của Vault vào lỗi: có thể chứa dữ liệu nhạy cảm.
    throw new Error(
      `Vault ${method} ${path.replace(/\/[^/]+$/, "/…")} failed with ${String(response.status)}`,
    );
  }
  return response.json();
}
