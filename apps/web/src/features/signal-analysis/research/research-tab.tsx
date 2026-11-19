"use client";

import type {
  ResearchClassifiers,
  ResearchPaperBot,
  ResearchRange,
  ResearchSummary,
  ResearchVersion,
  ResearchVersions,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";

import { Refreshing, StateBox, StaleNote } from "../components/bits";
import type { PageCtx } from "../components/signal-analysis-page";
import { clock } from "../format";

import { useResearchClassifiers, useResearchSummary, useResearchVersions } from "./api";
import { balance } from "./format";
import { HowItWorksDrawer, HowItWorksProvider, type HowTab } from "./how-it-works";
import { IsItWorking } from "./is-it-working";
import { ClassifierQuality } from "./labels";
import { NewsTrace, type TraceRequest } from "./news-trace";
import { ResearchBanner, VersionBar } from "./page-bar";
import { rulesList } from "./text";
import { ResearchTrades } from "./trades";
import { Block, Na, Pill } from "./ui";
import { NewsVersions } from "./versions";

// Tab "Signal research" (team, #273; thiết kế docs/mockups/signal-research, #269 v3.4). Chỉ nghiên cứu, tiền giả: tin
// được giao dịch paper khi xảy ra, whales / funding / price patterns chạy lại mỗi đêm. Không gì được gửi tới SoDEX. Mọi
// số đến từ API team của #271; thiếu thì hiện "Not available" / "Not enough trades", không bao giờ 0 (quy tắc 1.8).
// Dưới 768px theo mockup 390: News feed + funnel trace (#292), "Is it working?" (thẻ) và "Paper trades" (thẻ). #342: đầu
// trang có một bộ chọn Version (query `?version=`), dòng Progress và drawer How it works (research/how-it-works.tsx).

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
          <Body
            v={v}
            ctx={ctx}
            versionId={versionId}
            onVersion={setVersionId}
            versions={versions.data}
            classifiers={classifiers.data}
            picked={picked}
            news={
              <NewsTrace
                ctx={ctx}
                funnel={v.funnel}
                range={range}
                onRange={setRange}
                request={trace}
                versionId={versionId}
                rulesSince={rulesSinceOf(v, range)}
              />
            }
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
      </>
    );
  return (
    <HowItWorksProvider value={setHow}>
      <ResearchBanner
        sources={v === undefined ? null : { items: v.sources, now: v.computedAt }}
        tz={ctx.tz}
      />
      <VersionBar
        versions={versions.data}
        versionsError={versions.isError}
        classifiers={classifiers.data}
        context={v?.context ?? null}
        current={picked}
        onVersion={setVersionId}
        onHow={setHow}
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
      />
    </HowItWorksProvider>
  );
}

function Body({
  v,
  ctx,
  news,
  versionId,
  onVersion,
  versions,
  classifiers,
  picked,
}: {
  v: ResearchSummary;
  ctx: PageCtx;
  news: ReactNode;
  versionId: string | null;
  onVersion: (id: string) => void;
  versions: ResearchVersions | undefined;
  classifiers: ResearchClassifiers | undefined;
  picked: ResearchVersion | null;
}) {
  return (
    <>
      <PaperBots
        bots={v.bots}
        tz={ctx.tz}
        versionId={versionId}
        onVersion={onVersion}
        summaryVersion={v.version?.id ?? null}
        older={v.olderRules}
      />
      <ClassifierQuality tz={ctx.tz} />
      {news}
      <IsItWorking
        v={v}
        tz={ctx.tz}
        versions={versions}
        classifiers={classifiers}
        picked={picked}
      />
    </>
  );
}

/* ---------------------------------------------------------------- Paper bots */

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-bold text-muted">{label}</div>
      <div className="font-extrabold">{value}</div>
    </div>
  );
}

const btn =
  "inline-flex min-h-11 items-center rounded-control border border-border-input bg-surface px-4 font-bold text-ink no-underline disabled:cursor-not-allowed disabled:opacity-60";

function BotCard({
  title,
  pill,
  body,
  children,
  actions,
}: {
  title: string;
  pill: ReactNode;
  body: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-tile border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-[17px] font-extrabold">{title}</h3>
        {pill}
      </div>
      <p className="m-0 text-[13px] leading-normal text-ink-2">{body}</p>
      {children}
      {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

function BotPill({ bot }: { bot: ResearchPaperBot }) {
  const t = useTranslations("signalAnalysis.research.bots");
  if (bot.state === "paused") return <Pill tone="neutral">{t("state.paused")}</Pill>;
  return bot.mode === "live" ? (
    <Pill tone="pos">{t("state.live")}</Pill>
  ) : (
    <Pill tone="neutral">{t("state.replay")}</Pill>
  );
}

function PaperBots({
  bots,
  tz,
  versionId,
  onVersion,
  summaryVersion,
  older,
}: {
  bots: ResearchPaperBot[];
  tz: string;
  versionId: string | null;
  onVersion: (id: string) => void;
  /** Version mà tổng kết (và lãi / lỗ chưa chốt của bot News) đang mô tả. */
  summaryVersion: string | null;
  /** #321: lệnh của quy tắc cũ (v2) vẫn theo dõi ở bảng Paper trades. */
  older: ResearchSummary["olderRules"];
}) {
  const t = useTranslations("signalAnalysis.research.bots");
  const tn = useTranslations("signalAnalysis.research");
  const by = (k: ResearchPaperBot["type"]) => bots.find((b) => b.type === k);
  const news = by("news");
  const whales = by("whales");
  const funding = by("funding");
  const price = by("price");
  const group = funding ?? price;
  const bal = (b: ResearchPaperBot | undefined) =>
    b === undefined || b.balance === null ? <Na /> : balance(b.balance);
  const ver = (b: ResearchPaperBot) =>
    b.rulesVersion === null ? <Na /> : t("version", { v: b.rulesVersion });
  // #306: lane News là các News bot version (thẻ + bảng, `NewsVersions`); thẻ bot replay giữ như trước.
  const others =
    whales === undefined && group === undefined ? null : (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(290px,1fr))] gap-3.5 max-md:hidden">
        {whales === undefined ? null : (
          <BotCard
            title={t("names.whales")}
            pill={<BotPill bot={whales} />}
            body={t("body.whales")}
            actions={
              <>
                <button type="button" disabled className={btn}>
                  {t("pauseReplays")}
                </button>
                <button type="button" disabled className={btn}>
                  {t("rules")}
                </button>
              </>
            }
          >
            <div className="grid grid-cols-3 gap-2">
              <Stat label={t("balance")} value={bal(whales)} />
              <Stat
                label={t("lastRun")}
                value={
                  whales.lastRun === null ? (
                    <Na />
                  ) : (
                    t("lastRunValue", {
                      time: clock(whales.lastRun.at, tz, false),
                      n: whales.lastRun.trades,
                    })
                  )
                }
              />
              <Stat label={t("rules")} value={ver(whales)} />
            </div>
          </BotCard>
        )}
        {group === undefined ? null : (
          <BotCard title={t("names.group")} pill={<BotPill bot={group} />} body={t("body.group")}>
            <div className="grid grid-cols-2 gap-2">
              <Stat label={t("fundingBalance")} value={bal(funding)} />
              <Stat label={t("priceBalance")} value={bal(price)} />
            </div>
          </BotCard>
        )}
      </div>
    );
  return (
    <Block id="sr-bots" title={t("title")}>
      <NewsVersions
        tz={tz}
        selected={versionId}
        onSelect={onVersion}
        others={others}
        unrealized={
          summaryVersion === null || news === undefined
            ? null
            : { versionId: summaryVersion, value: news.unrealized }
        }
      />
      {older.trades === 0 ? null : (
        <p className="m-0 text-[13px] text-muted">
          {t("olderRules", { n: older.trades, versions: rulesList(older.versions, tn) })}
        </p>
      )}
    </Block>
  );
}
