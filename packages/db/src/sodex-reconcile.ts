import { AppError, ErrorCode, SignatureAction, SignatureRequestStatus } from "@drift/shared";
import { blocksWithdrawAndTransfer, readDriftApproval, type SodexRestClient } from "@drift/sodex";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { getAddress, isAddressEqual, type Address } from "viem";
import { z } from "zod";

import type { Db } from "./client";
import {
  apiKeys,
  auditLog,
  builderApprovals,
  outbox,
  sodexAccounts,
  sodexSignatureRequests,
} from "./schema";

// Đối soát request ký SoDEX đã gửi mà chưa rõ kết quả (`unknown`, quy tắc 1.7): chỉ ĐỌC lại trạng thái thật trên SoDEX
// (key, builder approval), không bao giờ gửi lại. Một hàm dùng chung cho endpoint `POST .../reconciliation` của api và
// vòng đối soát nền của jobs (#327), để hai đường luôn kết luận giống nhau.

/** SoDEX chỉ nhận nonce trong (T − 2 ngày, T + 1 ngày) (SODEX.md mục 5.6): quá 2 ngày thì request không còn áp được. */
export const SODEX_NONCE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

const uint = z.string().regex(/^\d+$/).transform(BigInt);
export const addKeyMessageSchema = z.object({
  chainID: uint,
  nonce: uint,
  accountID: uint,
  name: z.string(),
  keyType: z.number().int(),
  publicKey: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  expiresAt: uint,
  permissions: uint,
});
export const approveMessageSchema = z.object({
  chainID: uint,
  nonce: uint,
  accountID: uint,
  builderID: uint,
  maxFeeRate: uint,
});

export type SignatureRequestRow = typeof sodexSignatureRequests.$inferSelect;

export interface SignatureReconcileDeps {
  db: Db;
  rest: Pick<SodexRestClient, "getApiKeys" | "getBuilderApprovals">;
  builderId: bigint;
  now: () => Date;
}

const REVOKE_KEY_ACTIONS: ReadonlySet<string> = new Set([
  SignatureAction.revokeApiKeySpot,
  SignatureAction.revokeApiKeyPerps,
]);

/**
 * Request `unknown` còn có thể được SoDEX áp dụng (nonce chưa ra khỏi cửa sổ), cũ nhất trước, tối đa `limit` dòng: việc
 * của vòng đối soát nền. Quá cửa sổ thì SoDEX không thể áp dụng nữa, đọc lại cũng không đổi được kết luận.
 */
export async function listUnknownSignatureRequests(
  db: Db,
  now: Date,
  limit: number,
): Promise<{ id: string; sodexAccountId: string }[]> {
  const oldestAcceptedNonce = now.getTime() - SODEX_NONCE_WINDOW_MS;
  return db
    .select({
      id: sodexSignatureRequests.id,
      sodexAccountId: sodexSignatureRequests.sodexAccountId,
    })
    .from(sodexSignatureRequests)
    .where(
      and(
        eq(sodexSignatureRequests.status, SignatureRequestStatus.unknown),
        sql`(${sodexSignatureRequests.message}->>'nonce')::numeric > ${oldestAcceptedNonce}`,
      ),
    )
    .orderBy(asc(sodexSignatureRequests.submittedAt), asc(sodexSignatureRequests.id))
    .limit(limit);
}

/**
 * Đọc lại trạng thái trên SoDEX cho một request `unknown` và kết luận nếu đã thấy nó được áp dụng. Request không còn
 * `unknown` thì trả nguyên. Trả dòng sau khi đối soát (có thể vẫn `unknown`). Không kiểm quyền người dùng: api kiểm
 * trước khi gọi.
 */
export async function reconcileSignatureRequest(
  deps: SignatureReconcileDeps,
  id: string,
): Promise<SignatureRequestRow> {
  const row = await loadRow(deps.db, id);
  if (row.status !== SignatureRequestStatus.unknown) return row;
  const [account] = await deps.db
    .select()
    .from(sodexAccounts)
    .where(eq(sodexAccounts.id, row.sodexAccountId))
    .limit(1);
  if (account === undefined) throw new AppError(ErrorCode.notFound, "SoDEX account not found.");
  const user = getAddress(account.address);
  const now = deps.now();

  if (row.action === SignatureAction.addApiKey) {
    const message = addKeyMessageSchema.parse(row.message);
    const keys = await deps.rest.getApiKeys(user, account.sodexAccountId);
    const matches = (list: typeof keys.spot) =>
      list.some(
        (k) =>
          k.name === message.name &&
          isAddressEqual(k.publicKey as Address, getAddress(message.publicKey)) &&
          blocksWithdrawAndTransfer(k.permissions),
      );
    if (!matches(keys.spot) || !matches(keys.perps)) return row;
    await deps.db.transaction(async (tx) => {
      if (row.apiKeyId !== null) {
        await tx.update(apiKeys).set({ status: "active" }).where(eq(apiKeys.id, row.apiKeyId));
        // Renew: key cũ thôi được dùng (engine chỉ lấy key `active`); key cũ còn trên SoDEX tới khi người dùng xoá.
        await tx
          .update(apiKeys)
          .set({ status: "expired" })
          .where(
            and(
              eq(apiKeys.sodexAccountId, account.id),
              eq(apiKeys.status, "active"),
              ne(apiKeys.id, row.apiKeyId),
            ),
          );
      }
      await tx
        .update(sodexAccounts)
        .set({ status: "connected" })
        .where(eq(sodexAccounts.id, account.id));
      await tx
        .update(sodexSignatureRequests)
        .set({ status: SignatureRequestStatus.succeeded, resolvedAt: now })
        .where(eq(sodexSignatureRequests.id, id));
    });
    return loadRow(deps.db, id);
  }

  if (REVOKE_KEY_ACTIONS.has(row.action)) {
    if (row.apiKeyId === null) throw new AppError(ErrorCode.internal, "Revoke request has no key.");
    const [key] = await deps.db.select().from(apiKeys).where(eq(apiKeys.id, row.apiKeyId)).limit(1);
    if (key === undefined) throw new AppError(ErrorCode.internal, "Revoke request has no key.");
    const keys = await deps.rest.getApiKeys(user, account.sodexAccountId);
    const present = (list: typeof keys.spot) =>
      list.some((k) => isAddressEqual(k.publicKey as Address, getAddress(key.publicKey)));
    const list = row.action === SignatureAction.revokeApiKeySpot ? keys.spot : keys.perps;
    if (present(list)) return row;
    await deps.db.transaction(async (tx) => {
      await tx
        .update(sodexSignatureRequests)
        .set({ status: SignatureRequestStatus.succeeded, resolvedAt: now })
        .where(eq(sodexSignatureRequests.id, row.id));
      if (!present(keys.spot) && !present(keys.perps)) {
        // Key không còn trên SoDEX: xoá luôn bản mã hoá, DRIFT không thể dùng lại key này.
        await tx
          .update(apiKeys)
          .set({ status: "deleted", ciphertext: "revoked" })
          .where(eq(apiKeys.id, key.id));
        await tx
          .update(sodexAccounts)
          .set({ status: "disconnected" })
          .where(eq(sodexAccounts.id, account.id));
        // Cùng bản ghi như `AuditAction.disconnected` của api.
        await tx.insert(auditLog).values({
          userId: row.userId,
          action: "sodex.disconnected",
          target: account.id,
          metadata: {},
          ip: null,
        });
      }
    });
    return loadRow(deps.db, id);
  }

  const message = approveMessageSchema.parse(row.message);
  const approval = readDriftApproval(await deps.rest.getBuilderApprovals(user), deps.builderId);
  await deps.db
    .insert(builderApprovals)
    .values({
      sodexAccountId: account.id,
      builderId: deps.builderId,
      maxFeeRateSpot: approval.spot,
      maxFeeRatePerps: approval.perps,
      readBackAt: now,
    })
    .onConflictDoUpdate({
      target: [builderApprovals.sodexAccountId, builderApprovals.builderId],
      set: { maxFeeRateSpot: approval.spot, maxFeeRatePerps: approval.perps, readBackAt: now },
    });
  const target = Number(message.maxFeeRate);
  const applied = (rate: number | null) => (rate ?? 0) === target;
  if (applied(approval.spot) && applied(approval.perps)) {
    await deps.db.transaction(async (tx) => {
      const done = await tx
        .update(sodexSignatureRequests)
        .set({ status: SignatureRequestStatus.succeeded, resolvedAt: now })
        .where(
          and(
            eq(sodexSignatureRequests.id, id),
            eq(sodexSignatureRequests.status, SignatureRequestStatus.unknown),
          ),
        )
        .returning({ id: sodexSignatureRequests.id });
      if (done.length === 0 || target === 0) return;
      // Báo team (DEC-184): đủ hai chữ ký lần đầu của account (approve lại sau revoke không báo).
      const [earlier] = await tx
        .select({ id: sodexSignatureRequests.id })
        .from(sodexSignatureRequests)
        .where(
          and(
            eq(sodexSignatureRequests.sodexAccountId, account.id),
            eq(sodexSignatureRequests.action, SignatureAction.approveBuilderFee),
            eq(sodexSignatureRequests.status, SignatureRequestStatus.succeeded),
            ne(sodexSignatureRequests.id, id),
          ),
        )
        .limit(1);
      if (earlier === undefined)
        await tx.insert(outbox).values({
          topic: "jobs.team_ops",
          payload: { type: "team_sodex_connected", userId: row.userId, sodexAccountId: account.id },
        });
    });
  }
  return loadRow(deps.db, id);
}

async function loadRow(db: Db, id: string): Promise<SignatureRequestRow> {
  const [row] = await db
    .select()
    .from(sodexSignatureRequests)
    .where(eq(sodexSignatureRequests.id, id))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Signature request not found.");
  return row;
}
