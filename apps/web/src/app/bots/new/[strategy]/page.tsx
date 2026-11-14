import { notFound } from "next/navigation";

import {
  ClaudeDraftCreate,
  CreateBot,
  isLaunched,
  MmMarketsPage,
  presetMarket,
  VolumeGate,
} from "@/features/bots";
import { CopyFlowPage } from "@/features/copy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bot khối lượng: chỉ mở được khi admin bật cho tài khoản (DEC-80), kiểm tra ở client bằng /api/v1/features.
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ strategy: string }>;
  searchParams: Promise<{
    suggestion?: string;
    market?: string;
    engine?: string;
    leader?: string;
    draft?: string;
  }>;
}) {
  const { strategy } = await params;
  const { suggestion, market, engine, leader, draft } = await searchParams;
  if (!isLaunched(strategy)) notFound();
  // Copy Trade (DEC-163): luồng 3 bước Budget and safety → Review and start, trader chọn ở Find traders.
  if (strategy === "copy_trade")
    return (
      <VolumeGate strategy="copy_trade">
        <CopyFlowPage leader={leader ?? null} />
      </VolumeGate>
    );
  // `?market=&engine=` từ Watchlist (DEC-74); có `suggestion` thì giá trị AI đã lưu thắng.
  const preset =
    suggestion === undefined &&
    market !== undefined &&
    /^[A-Za-z0-9_-]{1,40}$/.test(market) &&
    (engine === "spot" || engine === "perps")
      ? (presetMarket(strategy, market, engine) ?? undefined)
      : undefined;
  // Market Making chưa chọn market: bước 1 xếp hạng market theo chi phí / $1M (DEC-227).
  const pickMarket =
    strategy === "volume_maker" &&
    preset === undefined &&
    suggestion === undefined &&
    !UUID.test(draft ?? "");
  // Bản nháp từ Claude (MCP, DEC-223): điền sẵn từ `bot_drafts`, người dùng tự Save / Start.
  const page = pickMarket ? (
    <MmMarketsPage />
  ) : UUID.test(draft ?? "") ? (
    <ClaudeDraftCreate strategy={strategy} draftId={draft ?? ""} />
  ) : (
    <CreateBot
      strategy={strategy}
      preset={preset}
      {...(suggestion === undefined ? {} : { suggestionId: suggestion })}
    />
  );
  return strategy === "volume_maker" ||
    strategy === "volume_farm" ||
    strategy === "adaptive_dca" ? (
    <VolumeGate strategy={strategy}>{page}</VolumeGate>
  ) : (
    page
  );
}
