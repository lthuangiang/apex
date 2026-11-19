"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Globe, Info, Lock, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { browserTimeZone, offsetLabel, offsetMinutes } from "@/features/account/market-hours-time";

import { SIGNAL_KEY } from "../api";
import { clock } from "../format";
import { ResearchTab } from "../research/research-tab";

import { AllTab } from "./all-tab";
import { MmTab } from "./mm-tab";
import { VbTab } from "./vb-tab";

// Signal Analysis (team, #233, docs/mockups/signal-analysis): tab All / Volume Builder / Market Making. Chỉ đọc, chỉ bot
// Market Making + Volume Builder tiền thật, người dùng theo account. Giờ theo múi giờ trình duyệt (có "Show in UTC") ở
// mọi tab. Mọi số đến từ `/api/v1/admin/signal-analysis/*` (role team); bundle chỉ có cách hiển thị. Tab Signal research
// (#273, docs/mockups/signal-research) đọc `/api/v1/admin/signal-research/*` (#271): chỉ nghiên cứu, tiền giả.

type Meta = { bots: number | null; computedAt: string } | null;

export type Tab = "all" | "vb" | "mm" | "research";
const TABS: Tab[] = ["all", "vb", "mm", "research"];
/** Nhãn ngắn dưới 768px (mockup signal-research/mobile.html). */
const SHORT: Partial<Record<Tab, "vbShort" | "mmShort">> = { vb: "vbShort", mm: "mmShort" };

export interface PageCtx {
  tz: string;
  utc: boolean;
  /** Tab báo số bot (null = không hiện trên tab) và lúc tính để header hiện. */
  onMeta: (m: Meta) => void;
  onForbidden: () => void;
}

export function SignalAnalysisPage() {
  const t = useTranslations("signalAnalysis");
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("all");
  const [browserTz, setBrowserTz] = useState<string | null>(null);
  const [utc, setUtc] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [meta, setMeta] = useState<Record<Tab, Meta>>({
    all: null,
    vb: null,
    mm: null,
    research: null,
  });
  const refs = useRef(new Map<Tab, HTMLButtonElement>());

  useEffect(() => {
    setBrowserTz(browserTimeZone());
    const q = new URLSearchParams(window.location.search).get("tab");
    if (q === "vb" || q === "mm" || q === "all" || q === "research") setTab(q);
  }, []);
  const choose = (next: Tab) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  };
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d === 0) return;
    e.preventDefault();
    const next = TABS[(i + d + TABS.length) % TABS.length] ?? "all";
    choose(next);
    refs.current.get(next)?.focus();
  };

  const tzLocal = browserTz ?? "UTC";
  const tz = utc ? "UTC" : tzLocal;
  const offset = useMemo(() => offsetMinutes(tzLocal, new Date()), [tzLocal]);
  const ready = browserTz !== null;
  const cur = meta[tab];
  const ctx: PageCtx = {
    tz,
    utc,
    onMeta: (m) => {
      setMeta((x) =>
        x[tab]?.computedAt === m?.computedAt && x[tab]?.bots === m?.bots ? x : { ...x, [tab]: m },
      );
    },
    onForbidden: () => {
      setForbidden(true);
    },
  };

  return (
    <Workspace current="signalAnalysis">
      <div className="flex flex-col gap-3">
        <PageHead
          title={t("title")}
          subtitle={t(`lede.${tab}`)}
          action={
            forbidden ? undefined : (
              <div className="flex flex-wrap items-center gap-3 text-[13px]">
                {tab === "research" ? (
                  // #342: tab nghiên cứu chỉ đọc giá mainnet, không gửi gì tới SoDEX (dải cảnh báo ở dưới).
                  <span className="inline-flex min-h-8 items-center rounded-full border border-border bg-surface px-3 font-bold text-ink-2">
                    {t("pricesMainnet")}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-bold text-ink-2">
                    <Lock aria-hidden="true" size={15} />
                    {t("readOnly")}
                  </span>
                )}
                {cur === null ? null : (
                  <span className="text-muted">
                    {t("updated", { time: clock(cur.computedAt, tz, false) })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void qc.invalidateQueries({ queryKey: SIGNAL_KEY })}
                  className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink"
                >
                  <RefreshCw aria-hidden="true" size={16} />
                  {t("refresh")}
                </button>
              </div>
            )
          }
        />
        {forbidden ? (
          <Card>
            <div className="flex flex-col items-center gap-1.5 py-8 text-center">
              <strong className="text-base">{t("states.notTeamTitle")}</strong>
              <span className="text-sm text-muted">{t("states.notTeamBody")}</span>
            </div>
          </Card>
        ) : (
          <>
            <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-4">
              <div
                role="tablist"
                aria-label={t("tabsLabel")}
                // #342: dưới 768px thanh tab cuộn ngang, mép phải mờ dần (mockup redesign-full-page-mobile).
                className="flex gap-1 overflow-x-auto rounded-tile border border-border bg-surface p-1 max-md:mask-r-from-85%"
              >
                {TABS.map((k) => {
                  const on = k === tab;
                  const bots = meta[k]?.bots ?? undefined;
                  const short = SHORT[k];
                  return (
                    <button
                      key={k}
                      ref={(el) => {
                        if (el === null) refs.current.delete(k);
                        else refs.current.set(k, el);
                      }}
                      type="button"
                      role="tab"
                      id={`sa-tab-${k}`}
                      aria-selected={on}
                      aria-controls="sa-panel"
                      tabIndex={on ? 0 : -1}
                      onKeyDown={onKey}
                      onClick={() => {
                        choose(k);
                      }}
                      className={`inline-flex min-h-11 flex-none cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border-0 px-4 text-sm font-extrabold ${on ? "bg-accent text-white" : "bg-transparent text-ink"}`}
                    >
                      {short === undefined ? (
                        t(`tabs.${k}`)
                      ) : (
                        <>
                          <span className="md:hidden">{t(`tabs.${short}`)}</span>
                          <span className="max-md:hidden">{t(`tabs.${k}`)}</span>
                        </>
                      )}
                      {bots === undefined ? null : (
                        <span className={`text-xs font-bold ${on ? "text-white" : "text-muted"}`}>
                          {t("tabs.bots", { n: bots })}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-control bg-surface-2 py-1 pr-1 pl-3 text-[12.5px] font-bold">
                <Globe aria-hidden="true" size={15} />
                <span>
                  {utc ? t("tzUtc") : t("tzLocal", { tz: tzLocal, offset: offsetLabel(offset) })}
                </span>
                <button
                  type="button"
                  aria-pressed={utc}
                  onClick={() => {
                    setUtc((x) => !x);
                  }}
                  className="min-h-11 cursor-pointer rounded-[9px] border border-border-input bg-surface px-3 text-[12.5px] font-bold text-ink"
                >
                  {utc ? t("showLocal") : t("showUtc")}
                </button>
              </div>
            </div>
            {tab === "research" ? null : (
              // Tab Signal research có dải "Research only · fake money" riêng (#342, research/page-bar.tsx).
              <div
                role="note"
                className="flex items-start gap-2.5 rounded-tile bg-accent-tint px-4 py-3 text-[13px] text-accent-ink"
              >
                <Info aria-hidden="true" size={18} className="mt-0.5 flex-none" />
                <span>{t.rich(`past.${tab}`, { b: (c) => <b className="text-ink">{c}</b> })}</span>
              </div>
            )}
            <div
              id="sa-panel"
              role="tabpanel"
              aria-labelledby={`sa-tab-${tab}`}
              className="flex min-w-0 flex-col gap-3"
            >
              {!ready ? null : tab === "all" ? (
                <AllTab ctx={ctx} />
              ) : tab === "vb" ? (
                <VbTab ctx={ctx} />
              ) : tab === "mm" ? (
                <MmTab ctx={ctx} />
              ) : (
                <ResearchTab ctx={ctx} />
              )}
            </div>
          </>
        )}
      </div>
    </Workspace>
  );
}
