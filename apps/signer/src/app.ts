import type { TLSSocket } from "node:tls";

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

const createKeyBodySchema = z.object({
  sodexAccountId: z.uuid(),
  name: z.string().regex(/^[0-9a-zA-Z_-]{1,36}$/),
  expiresAt: z.iso.datetime({ offset: false }),
});

export interface SignerDeps {
  pool: pg.Pool;
  vault: VaultTransit;
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

  return app;
}
