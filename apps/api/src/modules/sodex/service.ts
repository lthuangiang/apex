import type { Db } from "@drift/db";
import {
  apiKeys,
  bots,
  builderApprovals,
  sodexAccounts,
  sodexSignatureRequests,
  users,
} from "@drift/db";
import {
  AppError,
  isBuilderAccount,
  isBuilderFeeApproved,
  ReasonCode,
  ErrorCode,
  SignatureAction,
  SignatureRequestStatus,
  type SignatureRequest,
  type SodexConnection,
} from "@drift/shared";
import {
  addPermissionedApiKeyRequest,
  approveBuilderFeeRequest,
  blocksWithdrawAndTransfer,
  DRIFT_API_KEY_NAME,
  DRIFT_API_KEY_TTL_MS,
  readDriftApproval,
  revokeApiKeyRequest,
  RevokeEngine,
  verifyRevokeSignature,
  verifyUniversalSignature,
  wireRevokeTypedData,
  wireTypedData,
  type SignedWriteClient,
  type SodexRestClient,
  type RevokeKeyRequest,
  type UniversalRequest,
} from "@drift/sodex";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getAddress, isAddressEqual, type Address, type Hex } from "viem";
import { z } from "zod";

import { AuditAction, audit } from "../../lib/audit";
import { iso } from "../security/service";
import { verifyTwoFactor, type TwoFactorDeps } from "../security/two-factor";

// Kết nối SoDEX bằng hai chữ ký master wallet (DEC-25, SODEX.md mục 5.2):
//   1. UserSignedAddPermissionedAPIKeyAction: key DRIFT do signer sinh, mặt nạ 14.
//   2. ApproveBuilderFeeAction: 50 (hoặc 0 khi revoke).
// Server dựng message, ví ký, server kiểm tra chữ ký, gửi SoDEX, rồi ĐỌC LẠI trước khi báo thành công.
// Không retry ghi (quy tắc 1.7): kết quả không rõ → `unknown`, chỉ đọc lại để đối soát.

/** Thời gian ví được phép ký một request; nonce phải còn trong cửa sổ của SoDEX. */
export const SIGNATURE_REQUEST_TTL_MS = 10 * 60 * 1000;

export interface SignerClient {
  createApiKey(input: { sodexAccountId: string; name: string; expiresAt: string }): Promise<{
    id: string;
    publicKey: string;
  }>;
  /**
   * Signer giải mã thử key rồi bỏ (`POST /v1/keys/:id/verify`), không ký. `unusable` = cần người dùng ký lại;
   * `unavailable` = không hỏi được signer lúc này.
   */
  verifyApiKey(id: string): Promise<"ok" | "unusable" | "unavailable">;
}

export interface SodexDeps extends TwoFactorDeps {
  rest: SodexRestClient;
  writer: SignedWriteClient;
  signer: SignerClient;
  builderId: bigint;
  /** Chỉ bật sau khi đã kiểm chứng mặt nạ 14 trên mainnet (SODEX.md mục 5.2). */
  connectEnabled: boolean;
}

const uint = z.string().regex(/^\d+$/).transform(BigInt);
const addKeyMessageSchema = z.object({
  chainID: uint,
  nonce: uint,
  accountID: uint,
  name: z.string(),
  keyType: z.number().int(),
  publicKey: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  expiresAt: uint,
  permissions: uint,
});
const approveMessageSchema = z.object({
  chainID: uint,
  nonce: uint,
  accountID: uint,
  builderID: uint,
  maxFeeRate: uint,
});

const revokeMessageSchema = z.object({ accountID: uint, name: z.string(), nonce: uint });

const REVOKE_ACTIONS: ReadonlySet<string> = new Set([
  SignatureAction.revokeApiKeySpot,
  SignatureAction.revokeApiKeyPerps,
]);

type Row = typeof sodexSignatureRequests.$inferSelect;
type AnyRequest = UniversalRequest<
  "UserSignedAddPermissionedAPIKeyAction" | "ApproveBuilderFeeAction"
>;

export async function getConnection(deps: SodexDeps, userId: string): Promise<SodexConnection> {
  const account = await currentAccount(deps.db, userId);
  if (account === undefined) return { connection: null };
  const [key] = await deps.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.sodexAccountId, account.id), ne(apiKeys.status, "pending")))
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  const [fee] = await deps.db
    .select()
    .from(builderApprovals)
    .where(
      and(
        eq(builderApprovals.sodexAccountId, account.id),
        eq(builderApprovals.builderId, deps.builderId),
      ),
    )
    .limit(1);
  const now = deps.now();
  // Bot bị pause `API_KEY_UNUSABLE` sau khi key này được tạo: engine đã không ký được bằng key này dù lần
  // verify vừa rồi có thể qua (UI_REVIEW J2). Key mới (renew) thì tín hiệu cũ không còn tính.
  const pausedForKey =
    key === undefined
      ? []
      : await deps.db
          .select({ id: bots.id })
          .from(bots)
          .where(
            and(
              eq(bots.sodexAccountId, account.id),
              eq(bots.state, "paused"),
              eq(bots.reasonCode, ReasonCode.apiKeyUnusable),
              gte(bots.updatedAt, key.createdAt),
            ),
          )
          .limit(1);
  return {
    connection: {
      address: account.address,
      sodexAccountId: account.sodexAccountId.toString(),
      status: account.status,
      apiKey:
        key === undefined
          ? null
          : {
              last4: key.last4,
              status:
                key.status === "active" && key.expiresAt <= now
                  ? "expired"
                  : key.status === "active" &&
                      (pausedForKey.length > 0 ||
                        (await deps.signer.verifyApiKey(key.id)) === "unusable")
                    ? "unusable"
                    : key.status,
              expiresAt: iso(key.expiresAt),
              lastUsedAt: key.lastUsedAt === null ? null : iso(key.lastUsedAt),
              permissions: { trade: key.status === "active", withdrawTransfer: false },
            },
      builderFee: isBuilderAccount(account.sodexAccountId, deps.builderId)
        ? {
            builderId: deps.builderId.toString(),
            spot: null,
            perps: null,
            approved: true,
            exempt: true,
            readBackAt: iso(now),
          }
        : fee === undefined
          ? null
          : {
              builderId: fee.builderId.toString(),
              spot: fee.maxFeeRateSpot,
              perps: fee.maxFeeRatePerps,
              approved:
                isBuilderFeeApproved(fee.maxFeeRateSpot) &&
                isBuilderFeeApproved(fee.maxFeeRatePerps),
              exempt: false,
              readBackAt: iso(fee.readBackAt),
            },
    },
  };
}

/** Chữ ký 1: tạo key DRIFT cho master wallet `address`. */
export async function startConnect(
  deps: SodexDeps,
  userId: string,
  address: string,
): Promise<SignatureRequest> {
  if (!deps.connectEnabled) {
    throw new AppError(ErrorCode.forbidden, "Connecting SoDEX is not enabled yet.", {
      reason: "connect_disabled",
    });
  }
  const user = getAddress(address);
  let primaryAccountID: bigint;
  try {
    primaryAccountID = (await deps.rest.getSubaccounts(user)).primaryAccountID;
  } catch (error) {
    if (error instanceof AppError && error.details.sodexError === "user not found") {
      throw new AppError(ErrorCode.sodexAccountNotFound, "No SoDEX account for this wallet.");
    }
    throw error;
  }

  const account = await upsertAccount(deps.db, userId, user, primaryAccountID);
  const nonce = await nextNonce(deps, account.id);
  const expiresAt = nonce + DRIFT_API_KEY_TTL_MS;
  const key = await deps.signer.createApiKey({
    sodexAccountId: account.id,
    name: DRIFT_API_KEY_NAME,
    expiresAt: iso(new Date(Number(expiresAt))),
  });
  const request = addPermissionedApiKeyRequest({
    user,
    accountID: primaryAccountID,
    publicKey: getAddress(key.publicKey),
    nonce,
    expiresAt,
  });
  return insertRequest(deps, userId, account.id, SignatureAction.addApiKey, request, key.id);
}

/**
 * Renew key (UI_REVIEW E9 / H1, DEC-59): key mới tên `DRIFT-<yyyymmdd>` cho account đang kết nối, một chữ ký của
 * master wallet (`UserSignedAddPermissionedAPIKeyAction`, cùng quyền). Khi SoDEX xác nhận, key cũ trong DRIFT
 * chuyển `expired` (engine / signer chỉ dùng key `active`); key cũ vẫn còn trên SoDEX cho tới khi người dùng xoá.
 */
export async function startRenew(deps: SodexDeps, userId: string): Promise<SignatureRequest> {
  const account = await currentAccount(deps.db, userId);
  if (account?.status !== "connected") {
    throw new AppError(ErrorCode.stateConflict, "No connected SoDEX account to renew.");
  }
  const day = deps.now().toISOString().slice(0, 10).replace(/-/g, "");
  const used = new Set(
    (
      await deps.db
        .select({ name: apiKeys.name })
        .from(apiKeys)
        .where(eq(apiKeys.sodexAccountId, account.id))
    ).map((k) => k.name),
  );
  let name = `${DRIFT_API_KEY_NAME}-${day}`;
  for (let i = 2; used.has(name); i += 1) name = `${DRIFT_API_KEY_NAME}-${day}-${String(i)}`;
  const nonce = await nextNonce(deps, account.id);
  const expiresAt = nonce + DRIFT_API_KEY_TTL_MS;
  const key = await deps.signer.createApiKey({
    sodexAccountId: account.id,
    name,
    expiresAt: iso(new Date(Number(expiresAt))),
  });
  const request = addPermissionedApiKeyRequest({
    user: getAddress(account.address),
    accountID: account.sodexAccountId,
    publicKey: getAddress(key.publicKey),
    nonce,
    expiresAt,
    name,
  });
  return insertRequest(deps, userId, account.id, SignatureAction.addApiKey, request, key.id);
}

/** Chữ ký 2 (approve 50) hoặc revoke (0). Revoke cần 2FA (SCREENS.md mục 8.5). */
export async function startBuilderFee(
  deps: SodexDeps,
  userId: string,
  approve: boolean,
  twoFactorCode: string | undefined,
  ip: string | null,
): Promise<SignatureRequest> {
  const account = await currentAccount(deps.db, userId);
  if (account === undefined) throw new AppError(ErrorCode.notFound, "No SoDEX account connected.");
  if (!approve) await verifyTwoFactor(deps, userId, twoFactorCode, ip);
  const request = approveBuilderFeeRequest({
    user: getAddress(account.address),
    accountID: account.sodexAccountId,
    builderID: deps.builderId,
    approve,
    nonce: await nextNonce(deps, account.id),
  });
  const action = approve ? SignatureAction.approveBuilderFee : SignatureAction.revokeBuilderFee;
  return insertRequest(deps, userId, account.id, action, request, null);
}

/**
 * Disconnect (DEC-31): 2FA, rồi hai request xoá key do master wallet ký (Spot, Perps). Key chỉ
 * coi là đã xoá khi đọc lại thấy nó biến mất ở CẢ HAI engine.
 */
export async function startDisconnect(
  deps: SodexDeps,
  userId: string,
  twoFactorCode: string,
  ip: string | null,
): Promise<{ spot: SignatureRequest; perps: SignatureRequest }> {
  const account = await currentAccount(deps.db, userId);
  if (account?.status !== "connected") {
    throw new AppError(ErrorCode.notFound, "No SoDEX account connected.");
  }
  await verifyTwoFactor(deps, userId, twoFactorCode, ip);
  const [key] = await deps.db
    .select()
    .from(apiKeys)
    .where(
      and(eq(apiKeys.sodexAccountId, account.id), inArray(apiKeys.status, ["active", "expired"])),
    )
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  if (key === undefined) throw new AppError(ErrorCode.notFound, "No DRIFT key to revoke.");

  const create = async (engine: RevokeEngine) => {
    const request = revokeApiKeyRequest({
      engine,
      accountID: account.sodexAccountId,
      name: key.name,
      nonce: await nextNonce(deps, account.id),
    });
    const action =
      engine === RevokeEngine.spot
        ? SignatureAction.revokeApiKeySpot
        : SignatureAction.revokeApiKeyPerps;
    return insertRequest(deps, userId, account.id, action, request, key.id);
  };
  const spot = await create(RevokeEngine.spot);
  const perps = await create(RevokeEngine.perps);
  return { spot, perps };
}

export async function getSignatureRequest(
  deps: SodexDeps,
  userId: string,
  id: string,
): Promise<SignatureRequest> {
  return toView(await loadRow(deps.db, userId, id));
}

/** Nhận chữ ký ví, gửi SoDEX một lần, rồi đọc lại. */
export async function submitSignature(
  deps: SodexDeps,
  userId: string,
  id: string,
  walletSignature: string,
  ip: string | null,
): Promise<SignatureRequest> {
  const row = await loadRow(deps.db, userId, id);
  if (row.status !== SignatureRequestStatus.pending) {
    throw new AppError(ErrorCode.stateConflict, "Signature request is not pending.", {
      status: row.status,
    });
  }
  if (row.expiresAt <= deps.now()) {
    throw new AppError(ErrorCode.validationFailed, "Signature request expired.", {
      reason: "expired",
    });
  }
  const account = await accountById(deps.db, row.sodexAccountId);
  const request = rebuild(row, getAddress(account.address));
  let header: Hex;
  try {
    header =
      "engine" in request
        ? await verifyRevokeSignature(request, walletSignature as Hex, getAddress(account.address))
        : await verifyUniversalSignature(
            request,
            walletSignature as Hex,
            getAddress(account.address),
          );
  } catch {
    throw new AppError(
      ErrorCode.signatureInvalid,
      "Signature does not match the connected wallet.",
    );
  }

  // Chặn gửi hai lần: chỉ một request chuyển được khỏi `pending`.
  const claimed = await deps.db
    .update(sodexSignatureRequests)
    .set({ status: SignatureRequestStatus.unknown, submittedAt: deps.now() })
    .where(
      and(
        eq(sodexSignatureRequests.id, id),
        eq(sodexSignatureRequests.status, SignatureRequestStatus.pending),
      ),
    )
    .returning({ id: sodexSignatureRequests.id });
  if (claimed.length === 0) {
    throw new AppError(ErrorCode.stateConflict, "Signature request is not pending.");
  }

  // Universal cần X-API-Chain; xoá key là action engine (domain spot/futures), gửi DELETE.
  const result = await deps.writer.write(
    "engine" in request
      ? {
          path: request.path,
          method: "DELETE",
          body: request.body,
          signature: header,
          nonce: request.nonce,
        }
      : {
          path: request.path,
          method: "POST",
          body: request.body,
          signature: header,
          nonce: request.nonce,
          chainId: request.chainId,
        },
  );
  await audit(deps.db, {
    userId,
    action: auditActionFor(row.action),
    target: row.sodexAccountId,
    ip,
    metadata: { requestId: id, outcome: result.outcome },
  });

  if (result.outcome === "rejected" && REVOKE_ACTIONS.has(row.action)) {
    await deps.db
      .update(sodexSignatureRequests)
      .set({
        status: SignatureRequestStatus.failed,
        sodexError: result.sodexError,
        resolvedAt: deps.now(),
      })
      .where(eq(sodexSignatureRequests.id, id));
    return getSignatureRequest(deps, userId, id);
  }
  if (result.outcome === "rejected") {
    // SoDEX chắc chắn không nhận: key chưa từng tồn tại ở SoDEX, xoá luôn bản mã hoá của nó.
    const apiKeyId = row.apiKeyId;
    await deps.db.transaction(async (tx) => {
      await tx
        .update(sodexSignatureRequests)
        .set({
          status: SignatureRequestStatus.failed,
          sodexError: result.sodexError,
          resolvedAt: deps.now(),
          apiKeyId: null,
        })
        .where(eq(sodexSignatureRequests.id, id));
      if (apiKeyId !== null)
        await tx
          .delete(apiKeys)
          .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.status, "pending")));
    });
    return getSignatureRequest(deps, userId, id);
  }
  // `ok` hoặc `unknown`: đọc lại mới biết chắc.
  return reconcile(deps, userId, id);
}

/** Đọc lại trạng thái từ SoDEX cho request đã gửi (`unknown`). Chỉ đọc, không gửi lại. */
export async function reconcile(
  deps: SodexDeps,
  userId: string,
  id: string,
): Promise<SignatureRequest> {
  const row = await loadRow(deps.db, userId, id);
  if (row.status !== SignatureRequestStatus.unknown) return toView(row);
  const account = await accountById(deps.db, row.sodexAccountId);
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
    if (!matches(keys.spot) || !matches(keys.perps)) return toView(row);
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
    return getSignatureRequest(deps, userId, id);
  }

  if (REVOKE_ACTIONS.has(row.action)) {
    return reconcileRevoke(deps, userId, row, account);
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
    await deps.db
      .update(sodexSignatureRequests)
      .set({ status: SignatureRequestStatus.succeeded, resolvedAt: now })
      .where(eq(sodexSignatureRequests.id, id));
  }
  return getSignatureRequest(deps, userId, id);
}

// ---------- helpers ----------

/** Key đã biến mất ở engine này chưa; khi cả hai engine đều xong thì đánh dấu đã ngắt kết nối. */
async function reconcileRevoke(
  deps: SodexDeps,
  userId: string,
  row: Row,
  account: typeof sodexAccounts.$inferSelect,
): Promise<SignatureRequest> {
  if (row.apiKeyId === null) throw new AppError(ErrorCode.internal, "Revoke request has no key.");
  const [key] = await deps.db.select().from(apiKeys).where(eq(apiKeys.id, row.apiKeyId)).limit(1);
  if (key === undefined) throw new AppError(ErrorCode.internal, "Revoke request has no key.");
  const keys = await deps.rest.getApiKeys(getAddress(account.address), account.sodexAccountId);
  const present = (list: typeof keys.spot) =>
    list.some((k) => isAddressEqual(k.publicKey as Address, getAddress(key.publicKey)));
  const list = row.action === SignatureAction.revokeApiKeySpot ? keys.spot : keys.perps;
  if (present(list)) return toView(row);

  const now = deps.now();
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
      await audit(tx, { userId, action: AuditAction.disconnected, target: account.id, ip: null });
    }
  });
  return getSignatureRequest(deps, userId, row.id);
}

/**
 * Nonce của master wallet: ms hiện tại, nhưng luôn lớn hơn nonce đã dùng cho account này, để hai
 * request ký liền nhau (cùng ms) không trùng nonce (SODEX.md mục 5.6).
 */
async function nextNonce(deps: SodexDeps, sodexAccountId: string): Promise<bigint> {
  const now = BigInt(deps.now().getTime());
  const [row] = await deps.db
    .select({
      max: sql<string | null>`max((${sodexSignatureRequests.message}->>'nonce')::numeric)::text`,
    })
    .from(sodexSignatureRequests)
    .where(eq(sodexSignatureRequests.sodexAccountId, sodexAccountId));
  const last = row?.max == null ? null : BigInt(row.max);
  return last !== null && last >= now ? last + 1n : now;
}

async function currentAccount(db: Db, userId: string) {
  const [account] = await db
    .select()
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), ne(sodexAccounts.status, "disconnected")))
    .orderBy(desc(sodexAccounts.createdAt))
    .limit(1);
  return account;
}

async function accountById(db: Db, id: string) {
  const [account] = await db.select().from(sodexAccounts).where(eq(sodexAccounts.id, id)).limit(1);
  if (account === undefined) throw new AppError(ErrorCode.notFound, "SoDEX account not found.");
  return account;
}

async function upsertAccount(db: Db, userId: string, address: Address, accountId: bigint) {
  const [existing] = await db
    .select()
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.network, "mainnet"), eq(sodexAccounts.sodexAccountId, accountId)))
    .limit(1);
  if (existing !== undefined) {
    if (existing.userId === userId) return existing;
    // Chỉ chặn khi một tài khoản DRIFT khác (chưa xoá) đang giữ kết nối. Account đã Disconnect (key của DRIFT
    // đã bị xoá phía SoDEX) hoặc thuộc tài khoản đã xoá thì chuyển cho người đang kết nối (DEC-45).
    const [owner] = await db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, existing.userId))
      .limit(1);
    const held = existing.status !== "disconnected" && owner?.deletedAt === null;
    if (held) {
      throw new AppError(
        ErrorCode.sodexAccountInUse,
        "This SoDEX account is connected to another DRIFT user.",
      );
    }
    const [moved] = await db
      .update(sodexAccounts)
      .set({ userId, address, status: "connecting" })
      .where(eq(sodexAccounts.id, existing.id))
      .returning();
    if (moved === undefined) throw new AppError(ErrorCode.internal, "Could not update account.");
    return moved;
  }
  const [created] = await db
    .insert(sodexAccounts)
    .values({
      userId,
      address,
      sodexAccountId: accountId,
      network: "mainnet",
      status: "connecting",
    })
    .returning();
  if (created === undefined) throw new AppError(ErrorCode.internal, "Could not create account.");
  return created;
}

async function insertRequest(
  deps: SodexDeps,
  userId: string,
  sodexAccountId: string,
  action: SignatureAction,
  request: AnyRequest | RevokeKeyRequest,
  apiKeyId: string | null,
): Promise<SignatureRequest> {
  const [row] = await deps.db
    .insert(sodexSignatureRequests)
    .values({
      userId,
      sodexAccountId,
      action,
      apiKeyId,
      // Lưu đủ để dựng lại đúng request; `nonce` luôn có để tính nonce kế tiếp.
      message:
        "engine" in request
          ? {
              accountID: request.accountID.toString(),
              name: request.name,
              nonce: request.nonce.toString(),
            }
          : wireTypedData(request).message,
      status: SignatureRequestStatus.pending,
      expiresAt: new Date(deps.now().getTime() + SIGNATURE_REQUEST_TTL_MS),
    })
    .returning();
  if (row === undefined)
    throw new AppError(ErrorCode.internal, "Could not create signature request.");
  return toView(row);
}

async function loadRow(db: Db, userId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(sodexSignatureRequests)
    .where(and(eq(sodexSignatureRequests.id, id), eq(sodexSignatureRequests.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Signature request not found.");
  return row;
}

/** Dựng lại request từ message đã lưu, nên chữ ký luôn được kiểm tra trên đúng message server dựng. */
function rebuild(row: Row, user: Address): AnyRequest | RevokeKeyRequest {
  if (REVOKE_ACTIONS.has(row.action)) {
    const m = revokeMessageSchema.parse(row.message);
    return revokeApiKeyRequest({
      engine:
        row.action === SignatureAction.revokeApiKeySpot ? RevokeEngine.spot : RevokeEngine.perps,
      accountID: m.accountID,
      name: m.name,
      nonce: m.nonce,
    });
  }
  if (row.action === SignatureAction.addApiKey) {
    const m = addKeyMessageSchema.parse(row.message);
    return addPermissionedApiKeyRequest({
      user,
      accountID: m.accountID,
      publicKey: getAddress(m.publicKey),
      nonce: m.nonce,
      expiresAt: m.expiresAt,
      name: m.name,
    });
  }
  const m = approveMessageSchema.parse(row.message);
  return approveBuilderFeeRequest({
    user,
    accountID: m.accountID,
    builderID: m.builderID,
    approve: m.maxFeeRate !== 0n,
    nonce: m.nonce,
  });
}

function toView(row: Row): SignatureRequest {
  // Chỉ cần typed data; path (có địa chỉ ví) không dùng ở đây.
  const request = rebuild(row, "0x0000000000000000000000000000000000000000");
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    typedData: "engine" in request ? wireRevokeTypedData(request) : wireTypedData(request),
    expiresAt: iso(row.expiresAt),
    sodexError: row.sodexError,
  };
}

function auditActionFor(action: SignatureAction): AuditAction {
  switch (action) {
    case SignatureAction.addApiKey:
      return AuditAction.apiKeyAdded;
    case SignatureAction.approveBuilderFee:
      return AuditAction.builderFeeApproved;
    case SignatureAction.revokeBuilderFee:
      return AuditAction.builderFeeRevoked;
    case SignatureAction.revokeApiKeySpot:
    case SignatureAction.revokeApiKeyPerps:
      return AuditAction.apiKeyRevoked;
  }
}
