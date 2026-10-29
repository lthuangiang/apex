import { notFound } from "next/navigation";

import { CreateBot, isLaunched, presetMarket } from "@/features/bots";

// Volume Maker: route trả 404 khi VOLUME_MAKER_ENABLED tắt (VOLUME_MAKER.md mục 17.5).
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ strategy: string }>;
  searchParams: Promise<{ suggestion?: string; market?: string; engine?: string }>;
}) {
  const { strategy } = await params;
  const { suggestion, market, engine } = await searchParams;
  if (!isLaunched(strategy)) notFound();
  if (strategy === "volume_maker" && process.env.VOLUME_MAKER_ENABLED !== "true") notFound();
  // `?market=&engine=` từ Watchlist (DEC-74); có `suggestion` thì giá trị AI đã lưu thắng.
  const preset =
    suggestion === undefined &&
    market !== undefined &&
    /^[A-Za-z0-9_-]{1,40}$/.test(market) &&
    (engine === "spot" || engine === "perps")
      ? (presetMarket(strategy, market, engine) ?? undefined)
      : undefined;
  return (
    <CreateBot
      strategy={strategy}
      preset={preset}
      {...(suggestion === undefined ? {} : { suggestionId: suggestion })}
    />
  );
}
