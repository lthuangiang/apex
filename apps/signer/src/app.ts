import type { TLSSocket } from "node:tls";

import { rewardsJwtSchema } from "@drift/shared";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { hexToBytes, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { z } from "zod";

import { signExchangeAction } from "./exchange-sign";
import { KeyUnusableError, type VaultTransit } from "./vault";

// signer: nơi duy nhất sinh và giải mã private key API của DRIFT (docs/ARCHITECTURE.md 3.2, 3.3.8).
// P3 chỉ có sinh key. Ký lệnh (kèm kiểm tra `epoch`) thêm ở P6.

export const REDACT_PATHS = [
  "*.privateKey",
  "*.secret",
  "*.signature",
  "*.plaintext",
  "*.ciphertext",
  "*.token",
  "req.headers.authorization",
];

export const DRIFT_KEY_PERMISSIONS_MASK = 14;

const signBodySchema = z.object({
  apiKeyId: z.uuid(),
  domain: z.enum(["spot", "futures"]),
  payloadHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  nonce: z.string().regex(/^\d+$/),
  shard: z.number().int().nonnegative(),
  epoch: z.number().int().positive(),
});

/** #558 (DEC-398): JWT rewards cần mã hoá. Chỉ dạng JWT, tối đa 4 KB. */
const rewardsEncryptBodySchema = z.object({ token: rewardsJwtSchema }).strict();
/** Giải mã theo user: signer tự đọc ciphertext của dòng `active`, không nhận ciphertext từ người gọi. */
const rewardsDecryptBodySchema = z.object({ userId: z.uuid() }).strict();

const createKeyBodySchema = z.object({
  sodexAccountId: z.uuid(),
  name: z.string().regex(/^[0-9a-zA-Z_-]{1,36}$/),
  expiresAt: z.iso.datetime({ offset: false }),
});

export interface SignerDeps {
  pool: pg.Pool;
  vault: VaultTransit;
  /**
   * #558 (DEC-398): Vault transit riêng cho phiên rewards (`drift-rewards`). Thiếu thì hai endpoint `rewards-tokens`
   * trả 503. Signer không gọi ra ngoài Vault: chỉ mã hoá / giải mã, không gọi gateway SoDEX.
   */
  rewardsVault?: VaultTransit;
  logLevel: string;
  /** Thay stream log trong test. */
  logStream?: NodeJS.WritableStream;
  /** mTLS: https + bắt buộc client cert do `ca` ký; CN của client quyết định endpoint được gọi. */
  tls?: { cert: string; key: string; ca: string };
}

/** CN được phép gọi từng endpoint (least privilege): chỉ api tạo key, chỉ engine ký lệnh. */
export const SIGNER_CALLERS = {
  createKey: ["api"],
  sign: ["engine"],
  verifyKey: ["api", "engine"],
  /** #558: api mã hoá phiên rewards lúc người dùng bật báo box mới. */
  rewardsEncrypt: ["api"],
  /**
   * #558: scheduler giải mã phiên rewards để đọc định kỳ (chỉ dòng `active`, theo `userId`). DEC-398: prod chưa có
   * cert `scheduler` (volume cert không có ca.key nên không cấp lẻ được) nên scheduler dùng chung cert client của api;
   * vì vậy CN `api` cũng được giải mã. Chấp nhận được: CN `api` vốn đã thấy plaintext lúc người dùng bật (nhận token
   * để mã hoá) và không có quyền `sign` (chỉ engine). Phần quyền scheduler có thêm khi dùng cert api: createKey (key
   * `pending`, SoDEX chưa xác nhận), verifyKey, encrypt rewards. Giữ CN `scheduler` cho môi trường có cert riêng và
   * lần tạo lại toàn bộ cert sau (docs/DEPLOY.md 2.4.1).
   */
  rewardsDecrypt: ["scheduler", "api"],
} as const;

export function buildSignerApp(deps: SignerDeps): FastifyInstance {
  const app = Fastify({
    ...(deps.tls === undefined
      ? {}
      : {
          https: {
            cert: deps.tls.cert,
            key: deps.tls.key,
            ca: deps.tls.ca,
            requestCert: true,
            rejectUnauthorized: true,
          },
        }),
    logger: {
      level: deps.logLevel,
      base: { service: "signer" },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      ...(deps.logStream === undefined ? {} : { stream: deps.logStream }),
    },
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 16 * 1024,
  });

  app.get("/healthz", () => ({ status: "ok" }));

  /** Khi chạy mTLS: chỉ CN trong danh sách mới được gọi endpoint (cert đã được TLS kiểm tra chữ ký CA). */
  const callerAllowed = (request: FastifyRequest, allowed: readonly string[]): boolean => {
    if (deps.tls === undefined) return true;
    const socket = request.raw.socket as TLSSocket;
    const cn = socket.getPeerCertificate().subject.CN;
    return typeof cn === "string" && allowed.includes(cn);
  };

  /** Sinh cặp khoá mới, mã hoá private key bằng Vault, lưu `api_keys` trạng thái `pending`. */
  app.post("/v1/api-keys", async (request, reply) => {
    if (!callerAllowed(request, SIGNER_CALLERS.createKey))
      return reply.status(403).send({ error: "caller not allowed" });
    const parsed = createKeyBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body" });
    const body = parsed.data;

    const privateKey = generatePrivateKey();
    const publicKey = privateKeyToAddress(privateKey);
    const raw = Buffer.from(hexToBytes(privateKey));
    let ciphertext: string;
    try {
      ciphertext = await deps.vault.encrypt(raw);
    } finally {
      raw.fill(0);
    }
    const id = uuidv7();
    const last4 = publicKey.slice(-4).toLowerCase();
    await deps.pool.query(
      `insert into api_keys (id, sodex_account_id, name, public_key, ciphertext, kms_key_ref, last4, permissions_mask, expires_at, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [
        id,
        body.sodexAccountId,
        body.name,
        publicKey,
        ciphertext,
        deps.vault.keyRef,
        last4,
        DRIFT_KEY_PERMISSIONS_MASK,
        body.expiresAt,
      ],
    );
    request.log.info({ apiKeyId: id, sodexAccountId: body.sodexAccountId }, "api key created");
    return reply.status(201).send({ id, publicKey, last4 });
  });

  /**
   * Ký `ExchangeAction{payloadHash, nonce}` bằng key DRIFT của account. Chỉ ký khi `epoch` gửi lên đúng là
   * epoch hiện tại của shard (fencing, ARCHITECTURE.md mục 3.3.2). Không bao giờ trả private key.
   */
  app.post("/v1/sign", async (request, reply) => {
    if (!callerAllowed(request, SIGNER_CALLERS.sign))
      return reply.status(403).send({ error: "caller not allowed" });
    const parsed = signBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body" });
    const body = parsed.data;
    const { rows: epochs } = await deps.pool.query<{ epoch: string }>(
      "select epoch from shard_epochs where shard = $1",
      [body.shard],
    );
    if (epochs[0] === undefined || Number(epochs[0].epoch) !== body.epoch) {
      request.log.warn({ shard: body.shard, epoch: body.epoch }, "stale epoch");
      return reply.status(409).send({ error: "stale_epoch" });
    }
    const { rows } = await deps.pool.query<{ ciphertext: string; status: string }>(
      "select ciphertext, status from api_keys where id = $1",
      [body.apiKeyId],
    );
    const key = rows[0];
    if (key?.status !== "active") return reply.status(404).send({ error: "key_not_active" });
    let raw: Buffer;
    try {
      raw = await deps.vault.decrypt(key.ciphertext);
    } catch (error) {
      // 422: key không dùng được (cần ký lại); 503: Vault tạm lỗi. Không ký gì trong cả hai trường hợp.
      if (error instanceof KeyUnusableError)
        return reply.status(422).send({ error: "key_unusable" });
      request.log.error({ err: error }, "vault decrypt failed");
      return reply.status(503).send({ error: "vault_unavailable" });
    }
    try {
      const account = privateKeyToAccount(toHex(raw));
      const signature = await signExchangeAction(
        account,
        body.domain,
        body.payloadHash as `0x${string}`,
        BigInt(body.nonce),
      );
      return await reply.send({ signature });
    } finally {
      raw.fill(0);
    }
  });

  /**
   * Kiểm tra key DRIFT còn dùng được (UI_REVIEW H1): giải mã rồi xoá ngay, không ký, không trả gì về secret.
   * 204 dùng được · 404 key không `active` · 422 không giải mã được / không phải private key · 503 Vault lỗi.
   */
  app.post("/v1/keys/:id/verify", async (request, reply) => {
    if (!callerAllowed(request, SIGNER_CALLERS.verifyKey))
      return reply.status(403).send({ error: "caller not allowed" });
    const parsed = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body" });
    const { rows } = await deps.pool.query<{ ciphertext: string; status: string }>(
      "select ciphertext, status from api_keys where id = $1",
      [parsed.data.id],
    );
    const key = rows[0];
    if (key?.status !== "active") return reply.status(404).send({ error: "key_not_active" });
    let raw: Buffer;
    try {
      raw = await deps.vault.decrypt(key.ciphertext);
    } catch (error) {
      if (error instanceof KeyUnusableError)
        return reply.status(422).send({ error: "key_unusable" });
      request.log.error({ err: error }, "vault decrypt failed");
      return reply.status(503).send({ error: "vault_unavailable" });
    }
    const ok = raw.length === 32;
    raw.fill(0);
    return ok ? reply.status(204).send() : reply.status(422).send({ error: "key_unusable" });
  });

  /**
   * #558 (DEC-398): mã hoá JWT rewards bằng transit `drift-rewards`, trả ciphertext cho api lưu vào `rewards_watch`.
   * Không ghi DB, không log token. 503 khi chưa cấu hình khoá rewards hoặc Vault lỗi.
   */
  app.post("/v1/rewards-tokens/encrypt", async (request, reply) => {
    if (!callerAllowed(request, SIGNER_CALLERS.rewardsEncrypt))
      return reply.status(403).send({ error: "caller not allowed" });
    const rewardsVault = deps.rewardsVault;
    if (rewardsVault === undefined) {
      request.log.warn("rewards encrypt: rewards transit key not configured");
      return reply.status(503).send({ error: "rewards_disabled" });
    }
    const parsed = rewardsEncryptBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body" });
    const raw = Buffer.from(parsed.data.token, "utf8");
    try {
      const ciphertext = await rewardsVault.encrypt(raw);
      return await reply.send({ ciphertext, keyRef: rewardsVault.keyRef });
    } catch (error) {
      request.log.error({ err: error }, "vault encrypt failed (rewards)");
      return await reply.status(503).send({ error: "vault_unavailable" });
    } finally {
      raw.fill(0);
    }
  });

  /**
   * #558 (DEC-398): giải mã phiên rewards của MỘT user cho scheduler. Signer tự đọc `token_ciphertext` của dòng
   * `rewards_watch` đang `active`; không nhận ciphertext tuỳ ý (nên CN `scheduler` không giải mã được thứ khác, ví dụ
   * API key). 404 không có dòng `active` · 422 ciphertext không giải mã được (cần người dùng ký lại) · 503 Vault lỗi.
   */
  app.post("/v1/rewards-tokens/decrypt", async (request, reply) => {
    if (!callerAllowed(request, SIGNER_CALLERS.rewardsDecrypt))
      return reply.status(403).send({ error: "caller not allowed" });
    const rewardsVault = deps.rewardsVault;
    if (rewardsVault === undefined) return reply.status(503).send({ error: "rewards_disabled" });
    const parsed = rewardsDecryptBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body" });
    const { rows } = await deps.pool.query<{ token_ciphertext: string | null; status: string }>(
      "select token_ciphertext, status from rewards_watch where user_id = $1",
      [parsed.data.userId],
    );
    const row = rows[0];
    if (row?.status !== "active" || row.token_ciphertext === null)
      return reply.status(404).send({ error: "not_active" });
    let raw: Buffer;
    try {
      raw = await rewardsVault.decrypt(row.token_ciphertext);
    } catch (error) {
      if (error instanceof KeyUnusableError)
        return reply.status(422).send({ error: "token_unusable" });
      request.log.error({ err: error }, "vault decrypt failed (rewards)");
      return reply.status(503).send({ error: "vault_unavailable" });
    }
    try {
      const token = raw.toString("utf8");
      if (!rewardsJwtSchema.safeParse(token).success)
        return await reply.status(422).send({ error: "token_unusable" });
      request.log.debug({ userId: parsed.data.userId }, "rewards token decrypted");
      return await reply.send({ token });
    } finally {
      raw.fill(0);
    }
  });

  return app;
}
