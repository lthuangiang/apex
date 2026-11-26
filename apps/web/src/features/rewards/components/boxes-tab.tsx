"use client";

import { lotteryRewardByAssetSchema, type LotteryBox, type LotteryLedgerItem } from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { LayoutGrid, List } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";

import { shortAddress } from "@/lib/format";

import { pickOldest } from "../actions";
import {
  capitalizeRaw,
  formatAssetTotal,
  formatCount,
  formatDayTime,
  formatTokenAmount,
  formatUsd,
  fromTrading,
  levelDotClass,
  mintedMs,
  rewardRange,
} from "../format";
import { REWARDS_RULES_URL, SODEX_BLIND_BOX_URL } from "../links";
import {
  firstRewardsError,
  useCybereatorProfile,
  useRewardsActiveJobs,
  useRewardsBoxes,
  useRewardsDrawEntries,
  useRewardsHistory,
  useRewardsLedger,
  useRewardsMeta,
  useRewardsPfps,
  useRewardsRetry,
  useRewardsTreasures,
  type RewardsSession,
} from "../queries";
import { pickOfJob, useBoxActions } from "../use-box-actions";

import { DoneStrip } from "./action-popup";
import { BoxArt, boxKindOf } from "./box-art";
import { CARD, CardUnavailable, FeedList, Value } from "./public-cards";
import { ACTIVE, JobLine } from "./rewards-card";
import { RewardsProblem } from "./rewards-states";

// Rewards › Blind Boxes, chỉ đọc (bản phác 10–14; DEC-397, #550). Dải "ready to claim" chỉ hiện số; Claim / Open / Merge
// vào ở #551. Không có transfer (quy tắc sản phẩm 1): dòng transfer trong History là SoDEX ghi, chỉ đọc. Mọi số lấy từ
// SoDEX; thiếu thì "Not available". Không hiện xác suất, khoảng thưởng hay mốc thời gian API không trả.

const SUBTABS = ["backpack", "history", "draw", "feed"] as const;
type SubTab = (typeof SUBTABS)[number];

/** Box mới nhất trước (`mintedAt` giảm dần; thiếu thì cuối, rồi theo `tokenId` giảm dần). */
export function newestFirst(boxes: readonly LotteryBox[]): LotteryBox[] {
  return [...boxes].sort((a, b) => {
    const ma = mintedMs(a.mintedAt);
    const mb = mintedMs(b.mintedAt);
    if (ma !== mb) return ma === null ? 1 : mb === null ? -1 : mb - ma;
    return b.tokenId - a.tokenId;
  });
}

/**
 * Nhãn "From" (PM duyệt): source trade / invitee / campaign; transfer lottery_prize → "Weekly draw prize" (+ round),
 * transfer vào → "Received", ra → "Sent". Giá trị lạ hiện nguyên chuỗi SoDEX trả.
 */
export function useFromLabel() {
  const t = useTranslations("rewards.boxes.from");
  const source = (v: string | null | undefined): string | null => {
    if (v === null || v === undefined || v === "") return null;
    if (v === "trade" || v === "invitee" || v === "campaign") return t(v);
    // Giá trị lạ (ví dụ "manual" trong dữ liệu thật): nguyên chuỗi, viết hoa chữ đầu; không đoán nghĩa.
    return capitalizeRaw(v);
  };
  const transfer = (row: Pick<LotteryLedgerItem, "reason" | "round" | "direction">): string => {
    if (row.reason === "lottery_prize")
      return row.round === null || row.round === undefined
        ? t("prize")
        : `${t("prize")} · ${t("round", { round: row.round })}`;
    if (row.direction === "out") return t("sent");
    if (row.reason !== null && row.reason !== undefined && row.reason !== "")
      return capitalizeRaw(row.reason);
    return t("received");
  };
  return { source, transfer };
}

function Level({ level }: { level: string | null | undefined }) {
  if (level === null || level === undefined || level === "") return <Value text={null} />;
  return (
    <span className="inline-flex items-center gap-1.5 font-bold">
      <span
        aria-hidden="true"
        className={`size-3 flex-none rounded-[4px] ${levelDotClass(level)}`}
      />
      {level}
    </span>
  );
}

function Rows({ rows }: { rows: number }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2.5">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-bold whitespace-nowrap text-accent-ink no-underline"
    >
      {children}
    </a>
  );
}

/**
 * Không có dữ liệu vì lỗi: lỗi mạng / nghiệp vụ hiện tại chỗ (có thử lại); 429 dừng toàn bộ gateway nên đã có dải
 * chung ở đầu tab, ở đây chỉ "Not available".
 */
function PanelError({ error }: { error: Error | null }) {
  const retry = useRewardsRetry();
  const e = firstRewardsError(error);
  return e === null || e.kind === "rate_limited" || e.kind === "expired" ? (
    <CardUnavailable />
  ) : (
    <RewardsProblem error={e} onRetry={retry} />
  );
}

/** "3 boxes ready to claim": chỉ số; nút Claim vào ở #551. */
function ReadyStrip({ session }: { session: RewardsSession }) {
  const t = useTranslations("rewards.boxes");
  const ta = useTranslations("rewards.action.claim");
  const treasures = useRewardsTreasures(session).data;
  const backpack = useRewardsBoxes(session).data?.total ?? null;
  const actions = useBoxActions(session);
  if (treasures === undefined || treasures.total <= 0) return null;
  const all = Math.min(treasures.total, treasures.maxPerOpen);
  const claim = (count: number) => {
    actions.start({ kind: "claim", count, level: null, tokenIds: [], before: backpack });
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-accent-tint bg-hero px-5 py-4">
      {/* Box chờ claim chưa có cấp: hình Mystery (dấu "?"). */}
      <div className="relative h-[72px] w-[100px] flex-none">
        <span className="absolute top-2 left-0">
          <BoxArt level={null} size={64} label={t("unclaimed")} />
        </span>
        <span className="absolute top-0 left-7">
          <BoxArt level={null} size={64} float />
        </span>
      </div>
      <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
        <b className="text-lg">{t("ready", { count: treasures.total })}</b>
        <span className="text-sm text-ink-2">{t("readyBody")}</span>
      </div>
      <div className="flex flex-wrap gap-2.5">
        <Button
          onClick={() => {
            claim(all);
          }}
        >
          {ta("all", { n: all })}
        </Button>
        {all > 1 ? (
          <Button
            variant="secondary"
            onClick={() => {
              claim(1);
            }}
          >
            {ta("n", { n: 1 })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Thẻ một cấp box (bản phác polish 01, 02): hình box theo cấp trên nền ánh màu cấp, số box, tiến độ merge theo màu cấp,
 * "Reward range · set by SoDEX" (từ `rules.rewardBands`, không có band thì không hiện), nhãn "From trading" theo
 * `rules.tradeBoxLevels`, Open / Merge. Cấp không có box: hình mờ + "No boxes at this level." (không số 0 lớn).
 */
function LevelCard({
  level: l,
  session,
  boxes,
  busy,
  maxPerOpen,
  range,
  trading,
}: {
  level: { level: string; count: number; mergeSize: number; mergesAvailable: number };
  session: RewardsSession;
  boxes: readonly LotteryBox[];
  busy: ReadonlySet<number>;
  maxPerOpen: number;
  range: string | null;
  trading: boolean;
}) {
  const t = useTranslations("rewards.boxes");
  const tl = useTranslations("rewards.boxes.level");
  const kind = boxKindOf(l.level);
  const has = l.count > 0;
  const left = l.mergeSize > 0 ? Math.max(0, l.mergeSize - l.count) : 0;
  const pct =
    l.mergeSize <= 0
      ? 0
      : l.mergesAvailable > 0
        ? 100
        : Math.min(100, (l.count / l.mergeSize) * 100);
  return (
    <li
      className="flex flex-col gap-2.5 overflow-hidden rounded-card border border-border px-[18px] pt-4 pb-[18px]"
      style={
        has
          ? {
              background: `radial-gradient(120% 70% at 50% 0%, var(--lvl-${kind}-tint), var(--surface) 70%)`,
              borderColor: `color-mix(in srgb, var(--lvl-${kind}) 35%, var(--border))`,
              boxShadow: `0 10px 30px color-mix(in srgb, var(--lvl-${kind}) 14%, transparent)`,
            }
          : { background: "var(--surface-2)" }
      }
    >
      <div className="bx-tilt flex justify-center pt-0.5 pb-1">
        <BoxArt level={l.level} size={110} faded={!has} float={has} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Level level={l.level} />
        {trading ? (
          <span className="ml-auto rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-bold text-ink-2">
            {t("fromTrading")}
          </span>
        ) : null}
      </div>
      {has ? (
        <>
          <span className="flex items-baseline gap-1.5 tabular-nums">
            <b className="text-[28px] leading-none font-extrabold">{formatCount(l.count)}</b>
            <span className="text-sm text-ink-2">{tl("unit", { n: l.count })}</span>
          </span>
          {l.mergeSize <= 0 ? (
            <span className="text-sm text-ink-2">{tl("cantMerge")}</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-2 tabular-nums">
                {tl("merge", { size: l.mergeSize })} ·{" "}
                {l.mergesAvailable > 0 ? (
                  <b className="text-ink">{tl("ready", { n: l.mergesAvailable })}</b>
                ) : (
                  tl("toMerge", { n: left })
                )}
              </span>
              <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${String(pct)}%`, background: `var(--lvl-${kind})` }}
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <span className="text-sm text-ink-2">{tl("none")}</span>
      )}
      {range === null ? null : (
        <div className="flex flex-col gap-0.5 border-t border-dashed border-border-input pt-2">
          <span className="text-xs text-ink-2">{t("rewardRange")}</span>
          <b className="text-[13px] tabular-nums">{range}</b>
        </div>
      )}
      {has ? (
        <LevelActions
          session={session}
          level={l.level}
          mergeSize={l.mergeSize}
          canMerge={l.mergesAvailable > 0}
          boxes={boxes}
          busy={busy}
          maxPerOpen={maxPerOpen}
        />
      ) : null}
    </li>
  );
}

/**
 * Open (bước chọn số) và Merge của một level (bản phác 10, 11). Chọn box cũ nhất trước, bỏ box đang trong job; Merge đúng
 * `mergeSize` box cùng level. Nút chỉ mở popup xác nhận; chưa gửi gì.
 */
function LevelActions({
  session,
  level,
  mergeSize,
  canMerge,
  boxes,
  busy,
  maxPerOpen,
}: {
  session: RewardsSession;
  level: string;
  mergeSize: number;
  canMerge: boolean;
  boxes: readonly LotteryBox[];
  busy: ReadonlySet<number>;
  maxPerOpen: number;
}) {
  const t = useTranslations("rewards.action");
  const actions = useBoxActions(session);
  const free = boxes.filter((b) => b.level === level && !busy.has(b.tokenId)).length;
  const inJob = boxes.filter((b) => b.level === level && busy.has(b.tokenId)).length;
  const max = Math.max(0, Math.min(free, maxPerOpen));
  const [n, setN] = useState(1);
  const count = Math.min(Math.max(1, n), Math.max(1, max));
  const mergeIds = canMerge && mergeSize > 0 ? pickOldest(boxes, level, mergeSize, busy) : [];
  const mergeReady = mergeIds.length === mergeSize && mergeSize > 0;
  const step =
    "flex size-9 items-center justify-center text-base font-bold disabled:text-muted disabled:cursor-not-allowed";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {max === 0 ? (
          // Mọi box của level đang trong job: "Opening…" (bản phác 11). Danh sách không có box nào của level thì không
          // có gì để mở.
          inJob > 0 ? (
            <Button disabled className="h-9 min-h-9 px-3 text-sm">
              {t("open.opening")}
            </Button>
          ) : null
        ) : (
          <>
            <span className="inline-flex items-center rounded-control border border-border-input">
              <button
                type="button"
                aria-label={t("open.fewer")}
                disabled={count <= 1}
                onClick={() => {
                  setN(count - 1);
                }}
                className={step}
              >
                −
              </button>
              <span
                className="min-w-8 text-center text-sm font-bold tabular-nums"
                aria-live="polite"
              >
                {count}
              </span>
              <button
                type="button"
                aria-label={t("open.more")}
                disabled={count >= max}
                onClick={() => {
                  setN(count + 1);
                }}
                className={step}
              >
                +
              </button>
            </span>
            <Button
              className="h-9 min-h-9 px-3 text-sm"
              onClick={() => {
                actions.start({
                  kind: "open",
                  count,
                  level,
                  tokenIds: pickOldest(boxes, level, count, busy),
                  before: null,
                });
              }}
            >
              {t("open.n", { n: count })}
            </Button>
          </>
        )}
        {mergeSize > 0 ? (
          <Button
            variant="tonal"
            disabled={!mergeReady}
            className="h-9 min-h-9 px-3 text-sm"
            onClick={() => {
              actions.start({
                kind: "merge",
                count: mergeIds.length,
                level,
                tokenIds: mergeIds,
                before: null,
              });
            }}
          >
            {t("merge.n", { n: mergeSize })}
          </Button>
        ) : null}
      </div>
      <span className="text-xs text-ink-2">
        {inJob > 0 ? t("open.inRunning", { n: inJob }) : t("open.oldestGoFirst")}
      </span>
    </>
  );
}

export function BoxesTab({ session, tz }: { session: RewardsSession; tz: string }) {
  const t = useTranslations("rewards.boxes");
  const ta = useTranslations("rewards.action");
  const [sub, setSub] = useState<SubTab>("backpack");
  const boxes = useRewardsBoxes(session);
  const jobs = useRewardsActiveJobs(session);
  const treasures = useRewardsTreasures(session);
  const retry = useRewardsRetry();
  const id = useId();
  const actions = useBoxActions(session);
  const problem = firstRewardsError(treasures.error, boxes.error, jobs.error);
  return (
    <div className="flex flex-col gap-4">
      {problem === null ? null : <RewardsProblem error={problem} onRetry={retry} />}
      <DoneStrip auth={session} />
      <JobLine
        jobs={jobs.data?.jobs ?? []}
        onView={(job) => {
          actions.view(job.jobId, pickOfJob(job), "recovered");
        }}
      />
      <ReadyStrip session={session} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label={t("sections")}
          className="flex flex-wrap gap-1 self-start rounded-[14px] border border-border bg-surface p-1"
        >
          {SUBTABS.map((key) => (
            <button
              key={key}
              id={`${id}-tab-${key}`}
              type="button"
              role="tab"
              aria-selected={sub === key}
              aria-controls={`${id}-panel`}
              onClick={() => {
                setSub(key);
              }}
              className={`flex min-h-10 items-center gap-1.5 rounded-[10px] px-3.5 text-sm font-bold ${sub === key ? "bg-surface-2 text-ink shadow-sm" : "text-ink-2"}`}
            >
              {t(`sub.${key}`)}
              {key === "backpack" && boxes.data !== undefined ? (
                <span
                  className={`rounded-full px-[7px] py-px text-[11px] tabular-nums ${sub === key ? "bg-accent text-white" : "bg-border text-ink-2"}`}
                >
                  {formatCount(boxes.data.total)}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {boxes.data === undefined ? null : (
          <span className="text-xs text-ink-2">
            {ta("open.upTo", { n: boxes.data.maxPerOpen })}
          </span>
        )}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${sub}`}>
        {sub === "backpack" ? (
          <Backpack session={session} tz={tz} />
        ) : sub === "history" ? (
          <History session={session} tz={tz} />
        ) : sub === "draw" ? (
          <Draw session={session} tz={tz} />
        ) : (
          <section className={CARD} aria-label={t("sub.feed")}>
            <FeedList tz={tz} />
          </section>
        )}
      </div>
    </div>
  );
}

// Backpack (bản phác 10, 11).

function Backpack({ session, tz }: { session: RewardsSession; tz: string }) {
  const t = useTranslations("rewards.boxes");
  const tl = useTranslations("rewards.boxes.level");
  const tr = useTranslations("rewards.page");
  const from = useFromLabel();
  const boxes = useRewardsBoxes(session);
  const jobs = useRewardsActiveJobs(session);
  const meta = useRewardsMeta();
  const listId = useId();
  // Danh sách box: lưới thẻ mặc định, chuyển được sang bảng (bản phác polish 01).
  const [view, setView] = useState<"grid" | "table">("grid");
  // Box nằm trong job chưa xong (open: boxes[], merge: result.consumedTokenIds).
  const busy = new Set<number>();
  for (const j of jobs.data?.jobs ?? []) {
    if (!ACTIVE.includes(j.status)) continue;
    for (const b of j.boxes ?? []) busy.add(b.tokenId);
    for (const id of j.result?.consumedTokenIds ?? []) busy.add(id);
  }

  if (boxes.isPending && boxes.fetchStatus !== "idle") return <Rows rows={5} />;
  const data = boxes.data;
  const voucher = (
    <p className="m-0 flex flex-wrap gap-x-2 text-xs text-ink-2">
      <span>{t("voucher")}</span>
      <ExternalLink href={SODEX_BLIND_BOX_URL}>{t("openOnSodex")}</ExternalLink>
    </p>
  );
  if (data === undefined)
    return (
      <div className="flex flex-col gap-3">
        <CardUnavailable />
        {voucher}
      </div>
    );
  const sorted = newestFirst(data.boxes);

  return (
    <div className="flex flex-col gap-5">
      {data.byLevel.length === 0 ? null : (
        <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 xl:grid-cols-4">
          {data.byLevel.map((l) => (
            <LevelCard
              key={l.level}
              level={l}
              session={session}
              boxes={data.boxes}
              busy={busy}
              maxPerOpen={data.maxPerOpen}
              range={rewardRange(meta.data?.rules.rewardBands, l.level)}
              trading={fromTrading(meta.data?.rules.tradeBoxLevels, l.level)}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-start gap-5">
        <section aria-labelledby={listId} className={`${CARD} flex-[2_1_520px]`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h2 id={listId} className="m-0 text-lg font-extrabold">
                {t("list.title")}
              </h2>
              {sorted.length === 0 ? null : (
                <span className="text-xs font-semibold text-ink-2 tabular-nums">
                  {t("list.count", { count: formatCount(data.total) ?? "" })}
                </span>
              )}
            </div>
            {sorted.length === 0 ? null : (
              <div
                role="group"
                aria-label={t("view")}
                className="inline-flex gap-0.5 rounded-[10px] bg-surface-2 p-[3px]"
              >
                {(["grid", "table"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={view === k}
                    aria-label={t(k)}
                    title={t(k)}
                    onClick={() => {
                      setView(k);
                    }}
                    className={`flex h-9 w-10 items-center justify-center rounded-[8px] ${view === k ? "bg-surface text-ink shadow-sm" : "text-muted"}`}
                  >
                    {k === "grid" ? (
                      <LayoutGrid aria-hidden="true" size={16} />
                    ) : (
                      <List aria-hidden="true" size={16} />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center gap-1 rounded-tile bg-surface-2 px-5 py-6 text-center text-sm">
              <b className="text-[15px]">{t("empty.title")}</b>
              <span className="text-ink-2">{t("empty.body")}</span>
              <ExternalLink href={REWARDS_RULES_URL}>{tr("rules")}</ExternalLink>
            </div>
          ) : view === "grid" ? (
            <ul className="m-0 grid max-h-[560px] list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 overflow-auto p-0">
              {sorted.map((b) => {
                const ms = mintedMs(b.mintedAt);
                return (
                  <li
                    key={b.tokenId}
                    className="flex flex-col items-center gap-1.5 rounded-tile border border-border px-3 py-3.5 text-center tabular-nums"
                    style={{
                      background: `linear-gradient(180deg, var(--lvl-${boxKindOf(b.level)}-tint), var(--surface) 60%)`,
                    }}
                  >
                    <BoxArt level={b.level} size={64} label={b.level} />
                    <b className="text-[15px]">#{b.tokenId}</b>
                    <span className="text-xs text-ink-2">
                      <Value text={from.source(b.source)} />
                    </span>
                    <span className="text-xs text-ink-2">
                      <Value text={ms === null ? null : formatDayTime(ms, tz)} />
                    </span>
                    {busy.has(b.tokenId) ? (
                      <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[11px] font-extrabold text-accent-ink">
                        {t("list.inOpen")}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full border-collapse text-sm whitespace-nowrap tabular-nums">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-ink-2">
                    <th scope="col" className="px-2.5 py-2 font-semibold">
                      {t("list.box")}
                    </th>
                    <th scope="col" className="px-2.5 py-2 font-semibold">
                      {t("list.level")}
                    </th>
                    <th scope="col" className="hidden px-2.5 py-2 font-semibold sm:table-cell">
                      {t("list.from")}
                    </th>
                    <th scope="col" className="px-2.5 py-2 text-right font-semibold">
                      {t("list.received")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((b) => {
                    const ms = mintedMs(b.mintedAt);
                    return (
                      <tr key={b.tokenId} className="border-b border-border last:border-b-0">
                        <td className="px-2.5 py-2.5">#{b.tokenId}</td>
                        <td className="px-2.5 py-2.5">
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <Level level={b.level} />
                            {busy.has(b.tokenId) ? (
                              <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[11px] font-extrabold text-accent-ink">
                                {t("list.inOpen")}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="hidden px-2.5 py-2.5 text-ink-2 sm:table-cell">
                          <Value text={from.source(b.source)} />
                        </td>
                        <td className="px-2.5 py-2.5 text-right">
                          <Value text={ms === null ? null : formatDayTime(ms, tz)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* API cho builder không trả voucher: luôn ghi chú khi đã ký (người dùng chọn, #550). */}
          {voucher}
        </section>
        <Pfps session={session} />
      </div>
    </div>
  );
}

function PfpRow({ id }: { id: number }) {
  const t = useTranslations("rewards.boxes");
  const profile = useCybereatorProfile(id);
  const stage = profile.data?.stage;
  const label =
    stage === "revealed"
      ? t("pfps.revealed")
      : stage === "unopened"
        ? t("pfps.unopened")
        : stage === "opening"
          ? t("pfps.opening")
          : null;
  return (
    <li className="flex items-center gap-3 rounded-tile border border-border px-4 py-3">
      <span
        aria-hidden="true"
        className="size-12 flex-none rounded-[12px] bg-gradient-to-br from-accent-tint to-unknown-bg"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="truncate">{t("pfps.name", { id })}</b>
        <span className="text-xs text-ink-2">
          {profile.isPending ? null : <Value text={label} />}
        </span>
      </span>
      {stage === "revealed" ? null : (
        <ExternalLink href={SODEX_BLIND_BOX_URL}>{t("openOnSodex")}</ExternalLink>
      )}
    </li>
  );
}

/** PFP chỉ hiển thị; mở PFP là giao dịch on-chain trên SoDEX (link ra ngoài). Không có PFP thì không vẽ thẻ. */
function Pfps({ session }: { session: RewardsSession }) {
  const t = useTranslations("rewards.boxes.pfps");
  const pfps = useRewardsPfps(session);
  const id = useId();
  const items = pfps.data?.pfps ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id} className={`${CARD} flex-[1_1_320px]`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={id} className="m-0 text-lg font-extrabold">
          {t("title")}
        </h2>
        <span className="text-xs text-ink-2 tabular-nums">{formatCount(pfps.data?.total)}</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {items.map((p) => (
          <PfpRow key={p.profileTokenId} id={p.profileTokenId} />
        ))}
      </ul>
      <p className="m-0 text-xs text-ink-2">{t("note")}</p>
    </section>
  );
}

// History (bản phác 12).

const FILTERS = ["all", "claims", "opens", "merges", "transfers"] as const;
type Filter = (typeof FILTERS)[number];
const KIND: Record<Exclude<Filter, "all">, string> = {
  claims: "treasure",
  opens: "open",
  merges: "merge",
  transfers: "transfer",
};

function LedgerRow({ row, tz }: { row: LotteryLedgerItem; tz: string }) {
  const t = useTranslations("rewards.boxes.history");
  const from = useFromLabel();
  const time = formatDayTime(row.tsMs, tz) ?? "";
  const box = (id: number | null | undefined) =>
    id === null || id === undefined
      ? null
      : row.level === null || row.level === undefined
        ? `#${String(id)}`
        : t("box", { id, level: row.level });
  let title: ReactNode;
  let sub: string = time;
  switch (row.kind) {
    case "open":
      title = (
        <>
          <b>{t("opened")}</b> {box(row.tokenId)}
        </>
      );
      break;
    case "merge":
      title = (
        <>
          <b>{t("merged")}</b>{" "}
          {row.resultTokenId === null || row.resultTokenId === undefined
            ? null
            : t("mergeDetail", {
                count: row.consumedTokenIds?.length ?? 0,
                level: row.level ?? "",
                id: row.resultTokenId,
              })}
        </>
      );
      break;
    case "treasure": {
      title = (
        <>
          <b>{t("claimed")}</b> {box(row.tokenId)}
        </>
      );
      const src = from.source(row.source);
      if (src !== null) sub = `${src} · ${time}`;
      break;
    }
    case "transfer": {
      const out = row.direction === "out";
      title = (
        <>
          <b>{out ? t("transferOut") : t("transferIn")}</b> {box(row.tokenId)}
        </>
      );
      const peer = out ? row.to : row.from;
      const addr =
        peer === null || peer === undefined || peer === ""
          ? null
          : out
            ? t("toAddress", { address: shortAddress(peer) })
            : t("fromAddress", { address: shortAddress(peer) });
      sub = [from.transfer(row), addr, time].filter((x) => x !== null && x !== "").join(" · ");
      break;
    }
    default:
      title = <b>{row.kind}</b>;
  }
  const amount = formatTokenAmount(row.reward?.amount);
  const usd = formatUsd(row.rewardUsd);
  return (
    <li className="flex items-start justify-between gap-3 border-b border-border py-2.5 text-sm tabular-nums last:border-b-0">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{title}</span>
        <span className="text-xs text-ink-2">{sub}</span>
      </span>
      {amount === null || row.reward == null ? (
        <span aria-hidden="true" className="text-ink-2">
          —
        </span>
      ) : (
        <span className="flex flex-none flex-col items-end gap-0.5">
          <b>{`${amount} ${row.reward.asset.symbol}`}</b>
          {usd === null ? null : <span className="text-xs text-ink-2">{usd}</span>}
        </span>
      )}
    </li>
  );
}

function History({ session, tz }: { session: RewardsSession; tz: string }) {
  const t = useTranslations("rewards.boxes.history");
  const ledger = useRewardsLedger(session);
  const history = useRewardsHistory(session);
  const [filter, setFilter] = useState<Filter>("all");
  const assets = (history.data?.totalRewardByAsset ?? []).flatMap((a) => {
    const p = lotteryRewardByAssetSchema.safeParse(a);
    return p.success ? [p.data] : [];
  });
  const totalUsd = formatUsd(history.data?.totalRewardUsd);
  const rows = (ledger.data?.pages ?? []).flatMap((p) => p.items);
  const shown = filter === "all" ? rows : rows.filter((r) => r.kind === KIND[filter]);

  return (
    <section className={CARD} aria-label={t("rewardsTitle")}>
      <span className="text-sm text-ink-2">{t("rewardsTitle")}</span>
      {history.isPending && history.fetchStatus !== "idle" ? (
        <Rows rows={1} />
      ) : history.data === undefined ? (
        <PanelError error={history.error} />
      ) : (
        <>
          {assets.length === 0 ? null : (
            <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2">
              {assets.map((a) => (
                <li
                  key={`${a.asset.address}:${a.asset.symbol}`}
                  className="flex items-center justify-between gap-3 rounded-tile bg-surface-2 px-3 py-2.5 text-sm tabular-nums"
                >
                  <b>{a.asset.symbol}</b>
                  <b>
                    <Value text={formatAssetTotal(a.amount)} />
                  </b>
                </li>
              ))}
            </ul>
          )}
          <span className="text-sm">
            {totalUsd === null ? null : t("total", { usd: totalUsd })}
          </span>
        </>
      )}
      <div
        role="radiogroup"
        aria-label={t("filter")}
        className="flex flex-wrap gap-1 self-start rounded-[14px] bg-surface-2 p-1"
      >
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={filter === f}
            onClick={() => {
              setFilter(f);
            }}
            className={`min-h-10 rounded-[10px] px-3.5 text-sm font-bold ${filter === f ? "bg-surface text-ink shadow-sm" : "text-ink-2"}`}
          >
            {t(f)}
          </button>
        ))}
      </div>
      {ledger.isPending && ledger.fetchStatus !== "idle" ? (
        <Rows rows={5} />
      ) : ledger.data === undefined ? (
        <PanelError error={ledger.error} />
      ) : shown.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">{t("empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((r, i) => (
            <LedgerRow
              key={`${r.kind}:${String(r.tsMs)}:${String(r.tokenId)}:${String(i)}`}
              row={r}
              tz={tz}
            />
          ))}
        </ul>
      )}
      {ledger.hasNextPage ? (
        <button
          type="button"
          disabled={ledger.isFetchingNextPage}
          onClick={() => void ledger.fetchNextPage()}
          className="min-h-tap self-start rounded-control bg-accent-tint px-4 text-sm font-bold text-accent-ink disabled:opacity-60"
        >
          {t("loadMore")}
        </button>
      ) : null}
    </section>
  );
}

// Weekly draw (bản phác 13; kết quả theo dữ liệu thật round 10).

function Draw({ session, tz }: { session: RewardsSession; tz: string }) {
  const t = useTranslations("rewards.boxes.draw");
  const draw = useRewardsDrawEntries(session);
  const ledger = useRewardsLedger(session);
  const id = useId();
  const resId = useId();
  if (draw.isPending && draw.fetchStatus !== "idle") return <Rows rows={4} />;
  const d = draw.data;
  if (d === undefined) return <PanelError error={draw.error} />;
  const byLevel = (d.byLevel ?? []).flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const o = x as { level?: unknown; count?: unknown };
    return typeof o.level === "string" && typeof o.count === "number"
      ? [{ level: o.level, count: o.count }]
      : [];
  });
  const wins = typeof d.wins === "number" ? d.wins : null;
  const won = (d.entries ?? []).filter((e) => e.won === true);
  // Box thưởng về ví: dòng ledger transfer `reason: lottery_prize` của đúng round (không ghép với vé).
  const prizes = (ledger.data?.pages ?? [])
    .flatMap((p) => p.items)
    .filter((r) => r.kind === "transfer" && r.reason === "lottery_prize" && r.round === d.round);

  const kv: [string, string | null][] = [
    [
      t("snapshot"),
      d.deadlineMs === null || d.deadlineMs === undefined ? null : formatDayTime(d.deadlineMs, tz),
    ],
    [t("tickets"), formatCount(d.tickets)],
    [t("boxes"), formatCount(d.boxes)],
  ];
  return (
    <div className="flex flex-wrap items-start gap-5">
      <section aria-labelledby={id} className={`${CARD} flex-[1_1_420px]`}>
        <div className="flex items-center justify-between gap-2">
          <h2 id={id} className="m-0 text-lg font-extrabold">
            {t("round", { round: d.round })}
          </h2>
          <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[11px] font-extrabold text-accent-ink">
            {d.status}
          </span>
        </div>
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm tabular-nums">
          {kv.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-2">{k}</dt>
              <dd className="m-0 text-right font-bold">
                <Value text={v} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="m-0 text-sm text-ink-2">{t("note")}</p>
        {byLevel.length === 0 ? null : (
          <ul className="m-0 flex list-none flex-col p-0 text-sm tabular-nums">
            {byLevel.map((l) => (
              <li
                key={l.level}
                className="flex items-center justify-between border-b border-border py-2.5 last:border-b-0"
              >
                <Level level={l.level} />
                <span>{formatCount(l.count)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {wins === null || wins <= 0 ? null : (
        <section aria-labelledby={resId} className={`${CARD} flex-[1_1_320px]`}>
          <h2 id={resId} className="m-0 text-lg font-extrabold">
            {t("results", { round: d.round })}
          </h2>
          <p className="m-0 rounded-tile bg-pos-bg px-3 py-2.5 text-sm font-bold text-pos">
            {t("won", { wins, tickets: d.tickets ?? wins })}
          </p>
          {won.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col p-0 text-sm tabular-nums">
              {won.map((e) => (
                <li
                  key={e.tokenId}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2.5 last:border-b-0"
                >
                  <span className="inline-flex items-center gap-2">
                    #{e.tokenId} <Level level={e.level} />
                  </span>
                  {e.prizeLevel === null || e.prizeLevel === undefined ? null : (
                    <span className="text-ink-2">{t("prize", { level: e.prizeLevel })}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {prizes.length === 0 ? null : (
            <div className="flex flex-col gap-1.5 text-sm">
              <b>{t("received", { round: d.round })}</b>
              <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 tabular-nums">
                {prizes.map((p, i) => (
                  <li
                    key={`${String(p.tokenId)}:${String(i)}`}
                    className="inline-flex items-center gap-2"
                  >
                    {p.tokenId === null || p.tokenId === undefined ? null : `#${String(p.tokenId)}`}
                    <Level level={p.level} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="m-0 text-xs text-ink-2">{t("source")}</p>
        </section>
      )}
    </div>
  );
}
