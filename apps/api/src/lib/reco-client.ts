import {
  AppError,
  ErrorCode,
  type AccountMetrics,
  type RecoPlan,
  type Suggestion,
} from "@drift/shared";

// Client gọi service `reco` (HTTP nội bộ). Chậm quá 5 s hoặc lỗi → RECO_UNAVAILABLE; UI cho nhập tay
// (SCREENS.md mục 8.2, bước 7). Không bao giờ chặn việc tạo bot.

export interface RecoCommon {
  account: AccountMetrics | null;
  accountLeverageCap: number | null;
  timeZone: string;
  now: number;
}

export interface RecoClient {
  plan(
    body: RecoCommon & {
      goals: { goal: string; capital: string; maxDrop: string; assets: readonly string[] };
    },
  ): Promise<RecoPlan>;
  /** null khi engine không tính được tham số cho market này (422 / 404). */
  params(
    body: RecoCommon & { strategy: string; market: string; capital: string; maxDrop: string },
  ): Promise<Suggestion | null>;
}

export const RECO_TIMEOUT_MS = 5_000;

export function httpRecoClient(baseUrl: string): RecoClient {
  const base = baseUrl.replace(/\/+$/, "");
  async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RECO_TIMEOUT_MS),
      });
      return { status: res.status, json: await res.json() };
    } catch {
      throw new AppError(ErrorCode.recoUnavailable, "AI parameters unavailable.");
    }
  }
  return {
    async plan(body) {
      const r = await post("/v1/plan", body);
      if (r.status !== 200)
        throw new AppError(ErrorCode.recoUnavailable, "AI parameters unavailable.");
      return r.json as RecoPlan;
    },
    async params(body) {
      const r = await post("/v1/params", body);
      if (r.status === 404 || r.status === 422) return null;
      if (r.status !== 200)
        throw new AppError(ErrorCode.recoUnavailable, "AI parameters unavailable.");
      return r.json as Suggestion;
    },
  };
}
