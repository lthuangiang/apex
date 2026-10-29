import { decimalStringSchema } from "@drift/shared";
import { z } from "zod";

// Schema zod cho response SoDEX (docs/SODEX.md mục 5.6). Chỉ khai báo field DRIFT dùng;
// field thừa được bỏ qua. Dữ liệu từ ngoài luôn đi qua đây (CODING_STANDARDS C2).

/** uint64: số an toàn, bigint (từ parseSodexJson) hoặc chuỗi số. */
export const uint64Schema = z
  .union([z.number().int().nonnegative(), z.bigint().nonnegative(), z.string().regex(/^\d+$/)])
  .transform((value) => BigInt(value));

/** Số thập phân SoDEX trả dạng chuỗi; "0" ở một số filter nghĩa là không giới hạn. */
const decimal = decimalStringSchema;

export const successEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({ code: z.literal(0), timestamp: z.number(), data });

export const errorEnvelopeSchema = z.object({
  code: z.number().int().negative(),
  error: z.string(),
  timestamp: z.number().optional(),
});

export const subaccountsSchema = z.object({
  userID: uint64Schema,
  primaryAccountID: uint64Schema,
  subaccounts: z.array(z.object({ id: uint64Schema, evmAddress: z.string() })).default([]),
});
export type Subaccounts = z.infer<typeof subaccountsSchema>;

export const SymbolStatus = { trading: "TRADING", halt: "HALT" } as const;

const symbolBase = {
  id: uint64Schema,
  name: z.string(),
  displayName: z.string().optional(),
  pricePrecision: z.number().int(),
  tickSize: decimal,
  minPrice: decimal,
  maxPrice: decimal,
  quantityPrecision: z.number().int(),
  stepSize: decimal,
  minQuantity: decimal,
  maxQuantity: decimal,
  marketMinQuantity: decimal,
  marketMaxQuantity: decimal,
  minNotional: decimal,
  maxNotional: decimal,
  status: z.enum([SymbolStatus.trading, SymbolStatus.halt]),
};

export const spotSymbolSchema = z.object({
  ...symbolBase,
  baseCoin: z.string(),
  quoteCoin: z.string(),
});
export type SpotSymbol = z.infer<typeof spotSymbolSchema>;

export const perpsSymbolSchema = z.object({
  ...symbolBase,
  baseCoin: z.string().optional(),
  quoteCoin: z.string().optional(),
  maxLeverage: z.number().int().positive(),
  /** Giây, bội số của 3600. */
  fundingInterval: z.number().int().positive(),
});
export type PerpsSymbol = z.infer<typeof perpsSymbolSchema>;

export const builderApprovalSchema = z.object({
  userID: uint64Schema.optional(),
  builderID: uint64Schema,
  feeRate: z.number().int().nonnegative(),
});

export const builderApprovalsSchema = z.object({
  spot: z
    .array(builderApprovalSchema)
    .nullable()
    .transform((v) => v ?? []),
  perps: z
    .array(builderApprovalSchema)
    .nullable()
    .transform((v) => v ?? []),
});
export type BuilderApprovals = z.infer<typeof builderApprovalsSchema>;

export const apiKeySchema = z.object({
  name: z.string(),
  type: z.string(),
  publicKey: z.string(),
  expiresAt: uint64Schema,
  permissions: uint64Schema.optional(),
});

export const apiKeysSchema = z.object({
  spot: z
    .array(apiKeySchema)
    .nullable()
    .transform((v) => v ?? []),
  perps: z
    .array(apiKeySchema)
    .nullable()
    .transform((v) => v ?? []),
});
export type ApiKeys = z.infer<typeof apiKeysSchema>;
