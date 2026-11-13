"use client";

import { assetOf, deskMarketViewSchema, type DeskMarketView } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";

import { plainNumber } from "../bplus";

// Thẻ "Market today" (artboard BP-Home, DEC-TBD-desk-market): số 24 giờ qua trên SoDEX của market bot đang dùng, câu
// tất định (không gọi LLM). Nhãn theo biên độ (< 2% "moving sideways", > 6% "jumpy"); vế liên hệ chỉ khi đúng loại
// bot của user. Không có dữ liệu → ẩn thẻ. Không dự đoán.

type Line = DeskMarketView["items"][number];

function sentence(t: ReturnType<typeof useTranslations<"desk.market">>, l: Line): string {
  const asset = assetOf(l.market);
  const range = `${plainNumber(l.range)}%`;
  if (l.mood === "sideways")
    return l.relation === "grid"
      ? t("sidewaysGrid", { asset, range })
      : t("sideways", { asset, range });
  if (l.mood === "jumpy")
    return l.relation === "volume"
      ? t("jumpyVolume", { asset, range })
      : t("jumpy", { asset, range });
  return l.change === null
    ? t("plainRange", { asset, range })
    : t("plain", {
        asset,
        range,
        change: `${Number(l.change) > 0 ? "+" : ""}${plainNumber(l.change)}%`,
      });
}

export function MarketToday() {
  const t = useTranslations("desk.market");
  const q = useQuery({
    queryKey: ["desk", "market"],
    queryFn: () => api("GET", "/api/v1/desk/market", deskMarketViewSchema),
    staleTime: 60_000,
  });
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="market-today"
      className="flex items-start gap-3.5 rounded-[22px] border border-dashed border-border-input bg-surface px-5 py-4"
    >
      <span aria-hidden="true" className="text-[22px]">
        ☁
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="market-today" className="m-0 text-[15px] font-extrabold">
          {t("title")}
        </h2>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm leading-[1.55] text-ink-2">
          {items.map((l) => (
            <li key={l.market}>{sentence(t, l)}</li>
          ))}
        </ul>
        <p className="m-0 text-xs text-muted">{t("foot")}</p>
      </div>
    </section>
  );
}
