import { z } from "zod";

import { isoDateTimeSchema, uuidSchema } from "../schemas";

// Kết nối SoDEX bằng hai chữ ký master wallet (DEC-25) và thẻ SoDEX access (SCREENS.md mục 8.5).

export const evmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/** Chữ ký ví 65 byte. */
export const walletSignatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/);

export const SignatureAction = {
  addApiKey: "add_api_key",
  approveBuilderFee: "approve_builder_fee",
  revokeBuilderFee: "revoke_builder_fee",
  revokeApiKeySpot: "revoke_api_key_spot",
  revokeApiKeyPerps: "revoke_api_key_perps",
} as const;
export type SignatureAction = (typeof SignatureAction)[keyof typeof SignatureAction];

export const SignatureRequestStatus = {
  pending: "pending",
  succeeded: "succeeded",
  failed: "failed",
  unknown: "unknown",
} as const;
export type SignatureRequestStatus =
  (typeof SignatureRequestStatus)[keyof typeof SignatureRequestStatus];

/** Typed data EIP-712 dạng JSON để ví ký (`eth_signTypedData_v4`); uint64 là chuỗi. */
export const typedDataSchema = z.object({
  domain: z.object({
    name: z.string(),
    version: z.string(),
    chainId: z.string(),
    verifyingContract: evmAddressSchema,
  }),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type TypedData = z.infer<typeof typedDataSchema>;

export const connectBodySchema = z.object({ address: evmAddressSchema });

export const signatureRequestSchema = z.object({
  id: uuidSchema,
  action: z.enum(SignatureAction),
  status: z.enum(SignatureRequestStatus),
  typedData: typedDataSchema,
  expiresAt: isoDateTimeSchema,
  /** Lý do SoDEX từ chối, nguyên văn; UI không hiển thị thô (CODING_STANDARDS C6). */
  sodexError: z.string().nullable(),
});
export type SignatureRequest = z.infer<typeof signatureRequestSchema>;

export const submitSignatureBodySchema = z.object({ signature: walletSignatureSchema });

/** Disconnect: dialog + 2FA, rồi master wallet ký hai request xoá key (Spot, Perps) (DEC-31). */
export const disconnectBodySchema = z.object({ twoFactorCode: z.string().min(6).max(11) });
export const disconnectResponseSchema = z.object({
  spot: signatureRequestSchema,
  perps: signatureRequestSchema,
});

export const revokeBuilderFeeBodySchema = z.object({ twoFactorCode: z.string().min(6).max(11) });

export const apiKeyViewSchema = z.object({
  /** Chỉ 4 ký tự cuối (quy tắc 1.9). */
  last4: z.string().length(4),
  /** `unusable`: còn active và còn hạn nhưng signer không giải mã được (UI_REVIEW H1, cần ký lại). */
  status: z.enum(["pending", "active", "expired", "deleted", "unusable"]),
  expiresAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema.nullable(),
  /** Quyền theo mặt nạ đã đọc lại từ SoDEX. Withdraw/transfer luôn false (quy tắc 1.1). */
  permissions: z.object({ trade: z.boolean(), withdrawTransfer: z.literal(false) }),
});

export const builderFeeViewSchema = z.object({
  builderId: z.string().regex(/^\d+$/),
  /** Mức đã đọc lại từ SoDEX (phần mười bp); null = không có approval cho DRIFT. */
  spot: z.number().int().nullable(),
  perps: z.number().int().nullable(),
  approved: z.boolean(),
  /** Account của chính builder: không thu phí, không cần approve (DEC-47). */
  exempt: z.boolean().default(false),
  readBackAt: isoDateTimeSchema,
});

export const sodexConnectionSchema = z.object({
  connection: z
    .object({
      address: evmAddressSchema,
      sodexAccountId: z.string().regex(/^\d+$/),
      status: z.enum(["connecting", "connected", "disconnected"]),
      apiKey: apiKeyViewSchema.nullable(),
      builderFee: builderFeeViewSchema.nullable(),
    })
    .nullable(),
});
export type SodexConnection = z.infer<typeof sodexConnectionSchema>;
