"use client";

import {
  AssetMode,
  botDetailSchema,
  dec,
  Decimal,
  NEWS_RULES,
  newsSignalConfigSchema,
  SIGNAL_CATALYSTS,
  type NewsSignalConfig,
} from "@drift/shared";
import { BottomSheet } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { api } from "@/lib/api";

import { clock, monthDay } from "../format";
import { useResearchVersions } from "../research/api";
import { hold } from "../research/format";
import { Na, Pill } from "../research/ui";
import { catalystName, catalystSide, versionShort } from "../research/version-text";

// Màn Settings (chỉ xem) của bot `news_signal` Mainnet (#469 phần 1, mockup docs/mockups/signal-research/news-signal-settings.html
// khung 2): cấu hình của version đang chạy (`GET /bots/:id`, version `active`). Không sửa được ở đây (Edit là phần 2).
// Thiếu dữ liệu thì "Not available", không bao giờ 0 (quy tắc 1.8). Bot cũ không có trường `leverage` đọc là 1× (schema).
// "Copied from version …" chỉ hiện khi API trả version gốc và version đó còn trong danh sách người xem thấy được.

/** Version đang chạy của bot: số, lúc áp và config đã parse (null khi đọc không được). */
export function useActiveBotVersion(botId: string | null) {
  const q = useQuery({
    queryKey: ["bot", botId],
    queryFn: () => api("GET", `/api/v1/bots/${botId ?? ""}`, botDetailSchema),
    enabled: botId !== null,
    refetchInterval: 10_000,
  });
  const active = q.data?.versions.find((v) => v.status === "active") ?? null;
  const parsed = newsSignalConfigSchema.safeParse(active?.config);
  return {
    query: q,
    version: active?.version ?? null,
    since: active?.appliedAt ?? null,
    config: parsed.success ? parsed.data : null,
  };
}

/** Ký quỹ USDC làm tròn lên 2 chữ số (không bao giờ báo thấp hơn thực tế), bỏ số 0 thừa. */
const marginText = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_UP).toString();

export function BotSettingsSheet({
  botId,
  name,
  signalVersionId,
  account,
  tz,
  onClose,
}: {
  botId: string;
  name: string;
  /** Version gốc từ API; null = không biết (ẩn dòng "Copied from"). */
  signalVersionId: string | null;
  /** "••4f2a" khi đã kết nối; null = không biết. */
  account: string | null;
  tz: string;
  onClose: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.settings");
  const te = useTranslations("signalAnalysis.research.mainnet.editor");
  const tm = useTranslations("signalAnalysis.research.mainnet");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const a = useActiveBotVersion(botId);
  const versions = useResearchVersions();
  const source =
    signalVersionId === null
      ? null
      : (versions.data?.items.find((v) => v.id === signalVersionId) ?? null);
  const cfg = a.config;
  const since =
    a.version === null || a.since === null
      ? null
      : t("since", {
          n: a.version,
          time: `${monthDay(a.since, tz)}, ${clock(a.since, tz, false)}`,
        });

  return (
    <BottomSheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={name}
      titleAside={
        <span className="flex flex-wrap items-center gap-2">
          <Pill tone="neg">{tm("strip.mainnet")}</Pill>
          {since === null ? null : (
            <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-extrabold text-ink-2">
              {since}
            </span>
          )}
        </span>
      }
      {...(source === null ? {} : { description: t("copied", { name: versionShort(source, tv) }) })}
      closeLabel={tv("sheet.close")}
      side
    >
      {a.query.isPending ? (
        <p role="status" className="m-0 text-sm text-muted">
          {tm("loading")}
        </p>
      ) : (
        <>
          <Group legend={te("botBlock")}>
            <Kv label={te("account")} mono>
              {account ?? <Na />}
            </Kv>
            <Kv label={te("leverage")}>
              {cfg === null ? <Na /> : t("leverageValue", { lev: cfg.leverage })}
            </Kv>
            <Kv label={te("size")}>{cfg === null ? <Na /> : te("usdc", { v: cfg.sizeUsdc })}</Kv>
            <Kv label={t("marginPerTrade")}>
              {cfg === null ? (
                <Na />
              ) : (
                te("usdc", { v: marginText(dec(cfg.sizeUsdc).div(cfg.leverage)) })
              )}
            </Kv>
            <Kv label={tv("sheet.maxOpen")}>{cfg === null ? <Na /> : String(cfg.maxOpenTrades)}</Kv>
            <Kv label={t("maxDay")}>
              {cfg === null ? (
                <Na />
              ) : cfg.maxNewTradesPerDay === null ? (
                t("noLimit")
              ) : (
                String(cfg.maxNewTradesPerDay)
              )}
            </Kv>
          </Group>
          <Group legend={t("signals")}>
            <Kv label={t("markets")}>{cfg === null ? <Na /> : <Markets cfg={cfg} />}</Kv>
            <Kv label={t("minLevel")}>{cfg === null ? <Na /> : tn(`levels.${cfg.minLevel}`)}</Kv>
            <Kv label={t("tpsl")}>
              {cfg === null ? <Na /> : t("tpslValue", { tp: cfg.tpMultiple, sl: cfg.slMultiple })}
            </Kv>
            <Kv label={t("maxDelay")}>
              {cfg === null ? <Na /> : t("delayValue", { n: cfg.maxSourceDelayMinutes })}
            </Kv>
          </Group>
          <fieldset className="m-0 min-w-0 rounded-tile border border-border px-3.5 pt-2 pb-3.5">
            <legend className="px-1.5 text-[15px] font-extrabold text-ink">
              {tv("sheet.newsTypes")}
            </legend>
            {cfg === null ? (
              <Na />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13.5px]">
                  <caption className="sr-only">{tv("sheet.newsTable")}</caption>
                  <thead>
                    <tr>
                      {(["colTrade", "colType", "colDir", "colHold"] as const).map((k) => (
                        <th
                          key={k}
                          scope="col"
                          className="border-b border-border px-2 py-2 text-left text-xs font-bold text-muted"
                        >
                          {tv(`sheet.${k}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {SIGNAL_CATALYSTS.map((c) => {
                      const x = cfg.news[c];
                      const type = catalystName(c, tn);
                      return (
                        <tr key={c}>
                          <td className="border-b border-border px-2 py-2">
                            <input
                              type="checkbox"
                              checked={x?.enabled === true}
                              disabled
                              readOnly
                              aria-label={tv("sheet.tradeType", { type })}
                              className="size-4 accent-accent"
                            />
                          </td>
                          <td className="border-b border-border px-2 py-2 text-ink">{type}</td>
                          <td className="border-b border-border px-2 py-2 text-ink-2">
                            {tn(`sides.${catalystSide(c)}`)}
                          </td>
                          <td className="border-b border-border px-2 py-2 text-ink-2 tabular-nums">
                            {hold(x?.maxHoldHours ?? NEWS_RULES.catalysts[c].maxHoldHours)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </fieldset>
        </>
      )}
    </BottomSheet>
  );
}

function Markets({ cfg }: { cfg: NewsSignalConfig }) {
  const t = useTranslations("signalAnalysis.research.mainnet.settings");
  const kind = !cfg.assets.stocks ? t("cryptoOnly") : !cfg.assets.crypto ? t("stocksOnly") : null;
  const list = cfg.assets.markets;
  const scope =
    cfg.assets.mode === AssetMode.only
      ? t("marketsCount", { n: list.length })
      : cfg.assets.mode === AssetMode.except && list.length > 0
        ? t("marketsExcept", { list: list.join(", ") })
        : t("marketsAll");
  return (
    <>
      <span className="block">{[kind, scope].filter((x) => x !== null).join(" · ")}</span>
      {cfg.assets.mode === AssetMode.only && list.length > 0 ? (
        <span className="block text-xs font-semibold text-muted">{list.join(", ")}</span>
      ) : null}
    </>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 min-w-0 rounded-tile border border-border px-3.5 pt-2 pb-3.5">
      <legend className="px-1.5 text-[15px] font-extrabold text-ink">{legend}</legend>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4.5 gap-y-2.5">
        {children}
      </dl>
    </fieldset>
  );
}

function Kv({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] font-bold text-muted">{label}</dt>
      <dd className={`m-0 font-extrabold break-words text-ink ${mono ? "font-mono" : ""}`}>
        {children}
      </dd>
    </div>
  );
}
