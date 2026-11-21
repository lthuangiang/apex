import { SOSO_RATE_LIMIT } from "@drift/shared";
import { z } from "zod";

// SoSoValue OpenAPI (https://sosovalue-1.gitbook.io/sosovalue-api-doc): `GET /news`, header `x-soso-api-key`, phong bì
// `{ code, message, data: { page, page_size, total, list } }`. Dữ liệu thật (2026-11-18) khác tài liệu ở vài chỗ nên schema
// nhận cả hai: `release_time` là chuỗi số, `matched_currencies` có thể null và có dạng `{ currency_id, symbol, name }`
// (tài liệu: `{ id, full_name, name }`, với `name` là mã). Key không bao giờ nằm trong lỗi hay log.

export const SOSO_BASE_URL = "https://openapi.sosovalue.com/openapi/v1";
export const SOSO_PAGE_SIZE = 100;
const TIMEOUT_MS = 10_000;

const millis = z.union([z.number(), z.string().regex(/^\d+$/)]).transform((v) => Number(v));

const currencySchema = z
  .object({
    symbol: z.string().nullish(),
    name: z.string().nullish(),
    full_name: z.string().nullish(),
  })
  .transform((c) =>
    c.symbol != null
      ? { symbol: c.symbol, name: c.name ?? null }
      : { symbol: c.name ?? "", name: c.full_name ?? null },
  );

export const sosoNewsItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  release_time: millis,
  title: z.string().nullish(),
  content: z.string().nullish(),
  author: z.string().nullish(),
  category: z.number().int().nullish(),
  source_link: z.string().nullish(),
  original_link: z.string().nullish(),
  matched_currencies: z
    .array(currencySchema)
    .nullish()
    .transform((v) => (v ?? []).filter((c) => c.symbol !== "")),
});
export type SosoNewsItem = z.infer<typeof sosoNewsItemSchema>;

const envelopeSchema = z.object({
  code: z.number(),
  message: z.string().nullish(),
  data: z.object({ list: z.array(z.unknown()).nullish(), total: z.number().nullish() }).nullish(),
});

export class SosoError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "SosoError";
  }
}

/** SoSoValue từ chối vì giới hạn tốc độ: HTTP 429 hoặc `code` 42901 trong phong bì (#394). */
export function isSosoRateLimited(e: unknown): boolean {
  return e instanceof SosoError && (e.status === 429 || e.code === SOSO_RATE_LIMIT.code);
}

export interface SosoPage {
  items: SosoNewsItem[];
  /** Bài trong trang không đọc được theo schema (bỏ qua, chỉ đếm). */
  invalid: number;
  /** Header `X-RateLimit-Remaining` nếu SoSoValue trả (số nguyên ≥ 0); không có → null. */
  rateRemaining?: number | null;
}

/**
 * Chặn phía DeskLabs (#394): không quá `limit` request SoSoValue trong `windowMs` trượt (mặc định 20 / phút, theo key),
 * đếm mọi request kể cả phân trang. Sống trong tiến trình scheduler (leader), dùng chung giữa các chu kỳ. `tryTake()` false
 * = phải dừng, không gửi request.
 */
export class SosoRateLimiter {
  private readonly sent: number[] = [];

  constructor(
    private readonly now: () => number,
    private readonly limit: number = SOSO_RATE_LIMIT.perMinute,
    private readonly windowMs: number = SOSO_RATE_LIMIT.windowMs,
  ) {}

  tryTake(): boolean {
    const t = this.now();
    while (this.sent.length > 0 && (this.sent[0] ?? 0) <= t - this.windowMs) this.sent.shift();
    if (this.sent.length >= this.limit) return false;
    this.sent.push(t);
    return true;
  }

  /** Số request đã gửi trong cửa sổ hiện tại (test, log). */
  inWindow(): number {
    const t = this.now();
    return this.sent.filter((x) => x > t - this.windowMs).length;
  }
}

function remainingOf(res: Response): number | null {
  const v = res.headers.get("x-ratelimit-remaining");
  if (v === null || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
}

export interface SosoClient {
  newsPage(page: number): Promise<SosoPage>;
}

export function sosoClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = SOSO_BASE_URL,
): SosoClient {
  return {
    async newsPage(page) {
      const url = `${baseUrl}/news?page=${String(page)}&page_size=${String(SOSO_PAGE_SIZE)}`;
      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: { "x-soso-api-key": apiKey, accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        // Chỉ tên lỗi (timeout / mạng), không bao giờ đối tượng request.
        throw new SosoError(
          `SoSoValue request failed: ${e instanceof Error ? e.name : "error"}`,
          null,
          null,
        );
      }
      const body: unknown = await res.json().catch(() => null);
      const env = envelopeSchema.safeParse(body);
      if (!res.ok || !env.success || env.data.code !== 0) {
        const code = env.success ? env.data.code : null;
        throw new SosoError(`SoSoValue answered ${String(res.status)}`, res.status, code);
      }
      let invalid = 0;
      const items: SosoNewsItem[] = [];
      for (const raw of env.data.data?.list ?? []) {
        const p = sosoNewsItemSchema.safeParse(raw);
        if (p.success) items.push(p.data);
        else invalid += 1;
      }
      return { items, invalid, rateRemaining: remainingOf(res) };
    },
  };
}
