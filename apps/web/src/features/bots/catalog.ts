import { Strategy } from "@drift/shared";

// Danh mục chiến lược theo cờ tính năng của tài khoản: Strategy Lab và Landing đếm cùng một nguồn (báo cáo test E20).

export interface CatalogFeatures {
  volumeMaker: boolean;
  volumeFarm: boolean;
  adaptiveDca: boolean;
  aiDesk: boolean;
}

/** Cờ của một tài khoản mới (mặc định trong DB: `volume_bots`, `ai_desk`, `adaptive_dca` đều bật; DEC-218). */
export const DEFAULT_CATALOG_FEATURES: CatalogFeatures = {
  volumeMaker: true,
  volumeFarm: true,
  adaptiveDca: true,
  aiDesk: true,
};

/** Chiến lược có thẻ ở Strategy Lab. `news_signal` (#419) tạo từ trang Signal research, không bao giờ có thẻ. */
export type CatalogStrategy = Exclude<Strategy, typeof Strategy.newsSignal>;

const VOLUME: readonly Strategy[] = [Strategy.volumeMaker, Strategy.volumeFarm];
const EXPERIMENTAL: readonly Strategy[] = [Strategy.adaptiveDca, Strategy.copyTrade];
const isCatalog = (k: Strategy): k is CatalogStrategy => k !== Strategy.newsSignal;

/** Thứ tự thẻ: Market Making, Volume Builder (DEC-133), các chiến lược chính, rồi chiến lược theo cờ. */
export function catalogFor(
  f: CatalogFeatures,
  base: readonly CatalogStrategy[] = Object.values(Strategy).filter(
    (k): k is CatalogStrategy => isCatalog(k) && !VOLUME.includes(k) && !EXPERIMENTAL.includes(k),
  ),
): CatalogStrategy[] {
  return [
    ...(f.volumeMaker ? [Strategy.volumeMaker] : []),
    ...(f.volumeFarm ? [Strategy.volumeFarm] : []),
    ...base,
    ...(f.adaptiveDca ? [Strategy.adaptiveDca] : []),
    ...(f.aiDesk ? [Strategy.copyTrade] : []),
  ];
}
