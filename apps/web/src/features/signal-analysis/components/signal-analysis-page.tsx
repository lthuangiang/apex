"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Globe, Info, Lock, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { browserTimeZone, offsetLabel, offsetMinutes } from "@/features/account/market-hours-time";

import { SIGNAL_KEY } from "../api";
import { clock } from "../format";

import { AllTab } from "./all-tab";
import { MmTab } from "./mm-tab";
import { VbTab } from "./vb-tab";

// Signal Analysis (team, #233, docs/mockups/signal-analysis): tab All / Volume Builder / Market Making. Chỉ đọc, chỉ bot
// Market Making + Volume Builder tiền thật, người dùng theo account. Giờ theo múi giờ trình duyệt (có "Show in UTC") ở
// mọi tab. Mọi số đến từ `/api/v1/admin/signal-analysis/*` (role team); bundle chỉ có cách hiển thị.

export type Tab = "all" | "vb" | "mm";
const TABS: Tab[] = ["all", "vb", "mm"];

export interface PageCtx {
  tz: string;
  utc: boolean;
  /** Tab báo số bot và lúc tính để header hiện. */
  onMeta: (m: { bots: number; computedAt: string } | null) => void;
  onForbidden: () => void;
}

export function SignalAnalysisPage() {
  const t = useTranslations("signalAnalysis");
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("all");
  const [browserTz, setBrowserTz] = useState<string | null>(null);
  const [utc, setUtc] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [meta, setMeta] = useState<Record<Tab, { bots: number; computedAt: string } | null>>({
    all: null,
    vb: null,
    mm: null,
  });
  const refs = useRef(new Map<Tab, HTMLButtonElement>());

  useEffect(() => {
    setBrowserTz(browserTimeZone());
    const q = new URLSearchParams(window.location.search).get("tab");
    if (q === "vb" || q === "mm" || q === "all") setTab(q);
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
                <span className="inline-flex items-center gap-1.5 font-bold text-ink-2">
                  <Lock aria-hidden="true" size={15} />
                  {t("readOnly")}
                </span>
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
                className="flex gap-1 overflow-x-auto rounded-tile border border-border bg-surface p-1"
              >
                {TABS.map((k) => {
                  const on = k === tab;
                  const bots = meta[k]?.bots;
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
                      className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border-0 px-4 text-sm font-extrabold ${on ? "bg-accent text-white" : "bg-transparent text-ink"}`}
                    >
                      {t(`tabs.${k}`)}
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
            <div
              role="note"
              className="flex items-start gap-2.5 rounded-tile bg-accent-tint px-4 py-3 text-[13px] text-accent-ink"
            >
              <Info aria-hidden="true" size={18} className="mt-0.5 flex-none" />
              <span>{t.rich(`past.${tab}`, { b: (c) => <b className="text-ink">{c}</b> })}</span>
            </div>
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
              ) : (
                <MmTab ctx={ctx} />
              )}
            </div>
          </>
        )}
      </div>
    </Workspace>
  );
}
