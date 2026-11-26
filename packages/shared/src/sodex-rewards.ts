import { z } from "zod";

import { decimalStringSchema } from "./schemas";

// Rewards API chính thức của SoDEX cho builder (DEC-397, docs/mockups/rewards/README.md, docs.sodex.com › Rewards).
// Trình duyệt gọi thẳng gateway; server DeskLabs không gọi, không lưu. Mọi response parse bằng zod ở đây.
// Trường còn [confirm] (kiểu / đơn vị chưa chốt) để lỏng (số hoặc chuỗi, có thể thiếu): trang chẩn đoán team
// (`/admin/rewards-debug`) hiện hình dạng thật để chốt, rồi các PR sau siết lại.

/** Gateway mặc định của SoDEX mainnet (docs.sodex.com › Rewards API). */
export const SODEX_REWARDS_DEFAULT_ORIGIN = "https://mainnet-gw.sodex.dev";

/**
 * Envelope của auth / lottery / sopoints: thành công khi `code === 0`; lỗi nghiệp vụ đọc `msg` (đa số) hoặc `message`
 * (`sopoints/volume-weights` trả `message`). Cybereator không có envelope.
 */
export const rewardsEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});
export type RewardsEnvelope = z.infer<typeof rewardsEnvelopeSchema>;

/** HTTP 429: `data.retryAfter` là số giây phải chờ (số hoặc chuỗi số). */
export const rewardsRetryAfterSchema = z.object({
  data: z.object({ retryAfter: z.coerce.number().nonnegative() }),
});

/** Số hoặc chuỗi: kiểu thật chưa chốt ([confirm] trong README bản phác). */
const numOrString = z.union([z.number(), z.string()]);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const rewardsNonceSchema = z.object({ message: z.string().min(1) });
/** `data.accessToken`: JWT. Chỉ giữ trong sessionStorage của trình duyệt (DEC-397). */
export const rewardsVerifySchema = z.object({ accessToken: z.string().min(1) });

export const rewardAssetSchema = z.object({
  address: z.string(),
  symbol: z.string(),
  decimals: z.number().int(),
});
export const rewardAmountSchema = z.object({
  asset: rewardAssetSchema,
  amount: decimalStringSchema,
  amountRaw: z.string().optional(),
});
export type RewardAmount = z.infer<typeof rewardAmountSchema>;

// SoPoints

export const sopointsSummarySchema = z.object({
  totalPoints: numOrString,
  basePoints: numOrString.nullish(),
  boostPoints: numOrString.nullish(),
  referralPoints: numOrString.nullish(),
  currentTier: numOrString.nullish(),
  /** Ví ở tier cao nhất thì không có tier kế tiếp. */
  nextTier: numOrString.nullish(),
  /** [confirm] ngưỡng tổng hay số điểm còn thiếu. */
  nextTierPoints: numOrString.nullish(),
  rank: numOrString.nullish(),
  totalUser: numOrString.nullish(),
});
export type SopointsSummary = z.infer<typeof sopointsSummarySchema>;

export const sopointsWeekInfoSchema = z.object({
  weekNo: z.number().int(),
  weekName: z.string(),
  weekStatus: z.string(),
  weekPoolPoints: numOrString,
  /** Unix giây. */
  nextWeekStartTime: z.number().int(),
  /** Unix giây. */
  distributionTime: z.number().int(),
});

export const sopointsWeekRowSchema = z.object({
  weekNo: z.number().int(),
  weekName: z.string(),
  /** Unix giây. */
  weekStartTime: z.number().int(),
  weekEndTime: z.number().int(),
  /** [confirm] đơn vị. */
  spotVolume: numOrString.nullish(),
  futuresVolume: numOrString.nullish(),
  rank: numOrString.nullish(),
  points: numOrString.nullish(),
  /** `CONFIRMED` = điểm đã chốt; giá trị khác [confirm]. */
  pointsStatus: z.string().nullish(),
});
export const sopointsWeekListSchema = z.array(sopointsWeekRowSchema);

export const sopointsVolumeWeightsSchema = z.object({
  activity_id: z.number().int().optional(),
  round: z.object({
    round_id: z.number().int(),
    start_ts_ms: z.number().int().optional(),
    end_ts_ms: z.number().int(),
  }),
  weights: z.array(
    z.object({
      market_type: z.string(),
      symbol_id: z.number().int().optional(),
      symbol: z.string(),
      coefficient: decimalStringSchema,
    }),
  ),
});

// Lottery (Blind Boxes; tài liệu SoDEX gọi Treasure Boxes)

export const lotteryMetaSchema = z.object({
  rewardTokens: z
    .array(z.object({ asset: rewardAssetSchema, destination: z.string().optional() }))
    .optional(),
  rules: z.object({
    mergeSize: z.record(z.string(), z.number().int()),
    limits: z.object({ maxTreasureOpen: z.number().int(), maxBoxOpen: z.number().int() }),
  }),
});

export const lotteryTreasuresSchema = z.object({
  total: z.number().int(),
  maxPerOpen: z.number().int(),
  bySource: z.record(z.string(), z.number()).nullish(),
  lifetime: z
    .object({ granted: z.number().int().nullish(), opened: z.number().int().nullish() })
    .nullish(),
});

export const lotteryBoxSchema = z.object({
  tokenId: z.number().int(),
  level: z.string(),
  source: z.string().nullish(),
  /** [confirm] định dạng (ms, giây hay ISO); open / merge chọn box cũ trước theo trường này (DEC-397). */
  mintedAt: numOrString.nullish(),
});
export type LotteryBox = z.infer<typeof lotteryBoxSchema>;

export const lotteryBoxesSchema = z.object({
  total: z.number().int(),
  maxPerOpen: z.number().int(),
  byLevel: z.array(
    z.object({
      level: z.string(),
      count: z.number().int(),
      mergeSize: z.number().int(),
      canMergeNow: z.boolean(),
      mergesAvailable: z.number().int(),
    }),
  ),
  boxes: z.array(lotteryBoxSchema),
});

export const LOTTERY_JOB_STATUSES = ["submitting", "pending", "revealed", "failed"] as const;
export const lotteryJobSchema = z.object({
  jobId: z.number().int(),
  kind: z.string(),
  status: z.enum(LOTTERY_JOB_STATUSES),
  requestId: z.number().int().nullish(),
  minted: z
    .array(z.object({ tokenId: z.number().int(), level: z.string(), source: z.string().nullish() }))
    .nullish(),
  boxes: z
    .array(
      z.object({
        tokenId: z.number().int(),
        rewardUsd: decimalStringSchema.nullish(),
        reward: rewardAmountSchema.nullish(),
        pfpTokenId: z.number().int().nullish(),
      }),
    )
    .nullish(),
  result: z
    .object({
      tokenId: z.number().int(),
      level: z.string(),
      consumedTokenIds: z.array(z.number().int()),
    })
    .nullish(),
  error: z.string().nullish(),
});
export type LotteryJob = z.infer<typeof lotteryJobSchema>;
export const lotteryJobsSchema = z.object({ jobs: z.array(lotteryJobSchema) });

/** Hình dạng item theo `kind` còn [confirm]; chỉ chắc `kind` và `tsMs`. */
export const lotteryLedgerSchema = z.object({
  total: z.number().int(),
  type: z.string().optional(),
  items: z.array(
    z.object({
      kind: z.string(),
      tsMs: z.number().int(),
      from: z.string().nullish(),
      to: z.string().nullish(),
      rewardUsd: decimalStringSchema.nullish(),
      reward: rewardAmountSchema.nullish(),
    }),
  ),
});

export const lotteryHistorySchema = z.object({
  total: z.number().int(),
  totalRewardUsd: decimalStringSchema.nullish(),
  /** [confirm] hình dạng phần tử. */
  totalRewardByAsset: z.array(z.unknown()).nullish(),
  items: z.array(
    z.object({
      requestId: z.number().int().nullish(),
      tokenId: z.number().int(),
      level: z.string().nullish(),
      rewardUsd: decimalStringSchema.nullish(),
      reward: rewardAmountSchema.nullish(),
      settledAt: numOrString.nullish(),
      pfpTokenId: z.number().int().nullish(),
    }),
  ),
});

export const lotteryDrawEntriesSchema = z.object({
  round: z.number().int(),
  /** [confirm] giá trị. */
  status: z.string(),
  deadlineMs: z.number().int().nullish(),
  tickets: z.number().int().nullish(),
  boxes: z.number().int().nullish(),
  byLevel: z.array(z.unknown()).nullish(),
  total: z.number().int().nullish(),
  /** Chỉ có khi đã có kết quả; [confirm] hình dạng. */
  wins: z.unknown().optional(),
  entries: z
    .array(
      z.object({
        tokenId: z.number().int(),
        level: z.string(),
        won: z.boolean().nullish(),
        prizeLevel: z.string().nullish(),
      }),
    )
    .nullish(),
});

export const lotteryFeedSchema = z.object({
  minLevel: z.string().optional(),
  items: z.array(
    z.object({
      kind: z.string(),
      tsMs: z.number().int(),
      /** SoDEX đã rút gọn sẵn. */
      wallet: z.string(),
      level: z.string(),
      tokenId: z.number().int(),
      rewardUsd: decimalStringSchema.nullish(),
      reward: rewardAmountSchema.nullish(),
      pfp: z.boolean().optional(),
    }),
  ),
});

export const lotteryPfpsSchema = z.object({
  total: z.number().int(),
  pfps: z.array(z.object({ profileTokenId: z.number().int(), source: z.string().nullish() })),
  won: z.array(z.unknown()).nullish(),
});

/** Cybereator trả object trực tiếp, không có envelope. */
export const cybereatorProfileSchema = z.object({
  id: z.number().int(),
  stage: z.enum(["missing", "unopened", "opening", "revealed"]),
  rarity: z.unknown().optional(),
  image: z.string().nullish(),
  thumb: z.string().nullish(),
});

/** Địa chỉ ví đăng nhập rewards so với master wallet của tài khoản (không phân biệt hoa thường). */
export function sameWallet(a: string | null | undefined, b: string | null | undefined): boolean {
  return (
    a != null &&
    b != null &&
    evmAddress.safeParse(a).success &&
    evmAddress.safeParse(b).success &&
    a.toLowerCase() === b.toLowerCase()
  );
}
