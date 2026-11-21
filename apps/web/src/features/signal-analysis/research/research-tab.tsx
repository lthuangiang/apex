"use client";

import type { ResearchRange, ResearchSummary } from "@drift/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";

import { Refreshing, StateBox, StaleNote } from "../components/bits";
import type { PageCtx } from "../components/signal-analysis-page";
import { clock } from "../format";

import { useResearchClassifiers, useResearchSummary, useResearchVersions } from "./api";
import { BOTS_LABELS_ID, BotsAndLabels } from "./bots-labels";
import { BotsLabelsProvider } from "./bots-labels-context";
import { HowItWorksDrawer, HowItWorksProvider, type HowTab } from "./how-it-works";
import { IsItWorking } from "./is-it-working";
import { LABELS_ID } from "./labels";
import { NewsTrace, type TraceRequest } from "./news-trace";
import { SummaryStrip } from "./summary-strip";
import { ResearchTrades } from "./trades";

// Tab "Signal research" (team, #273; thiết kế docs/mockups/signal-research, #269 v3.4). Chỉ nghiên cứu, tiền giả: tin
// được giao dịch paper khi xảy ra, whales / funding / price patterns chạy lại mỗi đêm. Không gì được gửi tới SoDEX. Mọi
// số đến từ API team của #271; thiếu thì hiện "Not available" / "Not enough trades", không bao giờ 0 (quy tắc 1.8).
// Dưới 768px theo mockup 390: News feed + funnel trace (#292), "Is it working?" (thẻ) và "Paper trades" (thẻ). #342: một
// bộ chọn Version cho cả trang (query `?version=`) và drawer How it works (research/how-it-works.tsx). Trang gọn (mockup
// compact-*.html, duyệt 2026-11-20): dải tóm tắt → From headline to trade → Is it working? → Paper trades → Bots & labels
// (gập sẵn).

const RANGE_MS: Record<ResearchRange, number> = { "1d": 86_400_000, "7d": 7 * 86_400_000 };

/**
 * #321: phễu chỉ đếm quy tắc hiện tại; quy tắc đó bắt đầu sau đầu khoảng đã chọn thì trả mốc để ghi "Since rules v3
 * started …" (không thì người xem tưởng thu tin bị hỏng). null khi quy tắc đã chạy hết khoảng hoặc thiếu số.
 */
export function rulesSinceOf(
  v: Pick<ResearchSummary, "computedAt" | "newsRulesSince" | "newsRulesVersion">,
  range: ResearchRange,
): { v: number; at: string; sameDay: boolean } | null {
  if (v.newsRulesSince === null || v.newsRulesVersion === null) return null;
  const age = Date.parse(v.computedAt) - Date.parse(v.newsRulesSince);
  if (age >= RANGE_MS[range]) return null;
  return { v: v.newsRulesVersion, at: v.newsRulesSince, sameDay: age < RANGE_MS["1d"] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readVersion(): string | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("version");
  return v !== null && UUID.test(v) ? v : null;
}

/** #342: version của cả trang nằm ở query `?version=` (chia sẻ / tải lại giữ nguyên); null = Baseline. */
function useVersionParam(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(readVersion);
  const set = useCallback((next: string | null) => {
    setId(next);
    const url = new URL(window.location.href);
    if (next === null) url.searchParams.delete("version");
    else url.searchParams.set("version", next);
    window.history.replaceState(null, "", url);
  }, []);
  return [id, set];
}

export function ResearchTab({ ctx }: { ctx: PageCtx }) {
  const t = useTranslations("signalAnalysis.research");
  const [range, setRange] = useState<ResearchRange>("1d");
  const [trace, setTrace] = useState<TraceRequest | null>(null);
  const [how, setHow] = useState<HowTab | null>(null);
  // Khu "Bots & labels": gập sẵn; "Manage versions" / "Label signals" mở rồi cuộn tới.
  const [blOpen, setBlOpen] = useState(false);
  const [labelSeq, setLabelSeq] = useState(0);
  const [scrollTo, setScrollTo] = useState<{ id: string; seq: number } | null>(null);
  // #306 / #342: một News bot version cho cả trang (tổng kết, feed, trace, bảng lệnh, drawer); null = Baseline.
  const [versionId, setVersionId] = useVersionParam();
  const versions = useResearchVersions();
  const classifiers = useResearchClassifiers();
  const items = versions.data?.items;
  useEffect(() => {
    // Id trong URL không còn trong danh sách: quay về Baseline thay vì hỏi API một version không có.
    if (items !== undefined && versionId !== null && !items.some((x) => x.id === versionId))
      setVersionId(null);
  }, [items, versionId, setVersionId]);
  const picked = items?.find((x) => x.id === versionId) ?? items?.find((x) => x.isBaseline) ?? null;
  const q = useResearchSummary(range, versionId);
  const v = q.data;
  const { onMeta, onForbidden } = ctx;
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.code === "FORBIDDEN") onForbidden();
  }, [q.error, onForbidden]);
  useEffect(() => {
    onMeta(v === undefined ? null : { bots: null, computedAt: v.computedAt });
  }, [v, onMeta]);
  useEffect(() => {
    // Sau khi <details> đã mở (lần render này), cuộn tới và chuyển focus vào đó cho người dùng bàn phím.
    if (scrollTo === null) return;
    const el = document.getElementById(scrollTo.id);
    if (el === null) return;
    // jsdom (test) không có matchMedia / scrollIntoView.
    const still =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if ("scrollIntoView" in el)
      el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    const target = el.matches("section") ? el.querySelector("summary") : el;
    target?.focus({ preventScroll: true });
  }, [scrollTo]);
  const actions = useMemo(
    () => ({
      openVersions: () => {
        setBlOpen(true);
        setScrollTo((x) => ({ id: BOTS_LABELS_ID, seq: (x?.seq ?? 0) + 1 }));
      },
      openLabels: () => {
        setBlOpen(true);
        setLabelSeq((n) => n + 1);
        setScrollTo((x) => ({ id: LABELS_ID, seq: (x?.seq ?? 0) + 1 }));
      },
    }),
    [],
  );

  let body: ReactNode;
  if (q.isPending) body = <StateBox kind="loading" what={t("states.what")} />;
  else if (q.isError && v === undefined)
    body = <StateBox kind="error" what="" onRetry={() => void q.refetch()} />;
  else if (v === undefined) body = null;
  else if (
    v.sources.length === 0 &&
    v.bots.length === 0 &&
    v.funnel === null &&
    v.rows.length === 0
  )
    body = (
      <StateBox
        kind="empty"
        what=""
        emptyTitle={t("states.emptyTitle")}
        emptyBody={t("states.emptyBody")}
      />
    );
  else
    body = (
      <>
        {q.isError ? <StaleNote time={clock(v.computedAt, ctx.tz, false)} /> : null}
        <Refreshing on={q.isPlaceholderData}>
          <NewsTrace
            ctx={ctx}
            funnel={v.funnel}
            range={range}
            onRange={setRange}
            request={trace}
            versionId={versionId}
            rulesSince={rulesSinceOf(v, range)}
            cycleMinutes={v.cycleMinutes}
          />
          <IsItWorking
            v={v}
            tz={ctx.tz}
            versions={versions.data}
            classifiers={classifiers.data}
            picked={picked}
          />
        </Refreshing>
        <ResearchTrades
          ctx={ctx}
          assets={v.assets}
          versionId={versionId}
          older={v.olderRules}
          onTrace={(id) => {
            setTrace((x) => ({ id, seq: (x?.seq ?? 0) + 1 }));
          }}
        />
        <BotsAndLabels
          open={blOpen}
          onOpenChange={setBlOpen}
          labelSeq={labelSeq}
          bots={v.bots}
          tz={ctx.tz}
          versionId={versionId}
          onVersion={setVersionId}
          summaryVersion={v.version?.id ?? null}
          older={v.olderRules}
          versions={versions.data}
          onHow={setHow}
        />
      </>
    );
  const summaryVersion = v?.version?.id ?? null;
  const newsBot = v?.bots.find((b) => b.type === "news");
  const newsRow = v?.rows.find((r) => r.type === "news" && r.label === "live");
  return (
    <HowItWorksProvider value={setHow}>
      <BotsLabelsProvider value={actions}>
        <SummaryStrip
          sources={v === undefined ? null : { items: v.sources, now: v.computedAt }}
          tz={ctx.tz}
          versions={versions.data}
          versionsError={versions.isError}
          current={picked}
          context={v?.context ?? null}
          weeks={
            summaryVersion === null
              ? null
              : {
                  versionId: summaryVersion,
                  weeks: newsRow?.needs.kind === "pooled" ? newsRow.needs.weeks : null,
                }
          }
          unrealized={
            summaryVersion === null || newsBot === undefined
              ? null
              : { versionId: summaryVersion, value: newsBot.unrealized }
          }
          onVersion={setVersionId}
          onHow={setHow}
          onLabel={actions.openLabels}
          onManage={actions.openVersions}
        />
        {body}
        <HowItWorksDrawer
          tab={how}
          onTab={setHow}
          onClose={() => {
            setHow(null);
          }}
          version={picked}
          rulesVersion={v?.newsRulesVersion ?? null}
          cycleMinutes={v?.cycleMinutes ?? null}
          maxRunning={versions.data?.maxRunning ?? null}
          baselineNumber={versions.data?.items.find((x) => x.isBaseline)?.number ?? null}
        />
      </BotsLabelsProvider>
    </HowItWorksProvider>
  );
}
