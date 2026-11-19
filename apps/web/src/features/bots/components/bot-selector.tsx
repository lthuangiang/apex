"use client";

import { BotState, dec, formatDecimal, type BotSummary } from "@drift/shared";
import { BottomSheet, Skeleton, StatusPill } from "@drift/ui";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Clock,
  Plus,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { PaperChip } from "@/features/desk/components/paper-chip";
import { formatDateTime } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useMe } from "@/lib/queries";
import { useMediaQuery } from "@/lib/use-media";

import { botCapital } from "../bot-label";
import {
  baseOf,
  DEFAULT_FILTERS,
  groupOf,
  liveOrder,
  needsAttention,
  pickable,
  pickerView,
  shortId,
  STATE_FILTERS,
  stateCounts,
  type PickerFilters,
  type PickerGroup,
} from "../bot-picker";
import { useReasonLabel } from "../stop-reason";

import { BotProfit } from "./bot-profit";
import { useWaitingText } from "./bots-page";

// Bộ chọn bot của Trading Agent, phương án A (docs/mockups/agent-selector; DEC-294). Thay dải thẻ
// cuộn ngang: thanh tóm tắt bot đang xem + nút Switch bot mở panel combobox (tìm kiếm, lọc State / Strategy /
// Market, nhóm). Điện thoại: thẻ đầu trang là nút mở, danh sách nằm trong BottomSheet. Chọn bot = điều hướng tới
// /agent/:botId. Bot đang xem có aria-selected + dấu "Viewing" nhìn thấy được (không chỉ bằng màu).

export const PHONE = "(max-width: 767px)";

/**
 * Bot tối thiểu của panel chọn. Trading Agent truyền `BotSummary` đầy đủ (PnL, tóm tắt cấu hình, lý do dừng); Signal
 * Analysis (#289) chỉ có tên, market, chiến lược, trạng thái, version, ngày tạo và account, nên dòng bỏ cột PnL thay vì
 * bịa số (quy tắc 1.8).
 */
export type PickerBot = Pick<
  BotSummary,
  | "id"
  | "name"
  | "strategy"
  | "market"
  | "marketLabel"
  | "state"
  | "reasonCode"
  | "needsAttention"
  | "activeVersion"
  | "createdAt"
  | "updatedAt"
> & {
  /** Nhãn account ("Account ··b569370e") khi danh sách có bot của nhiều account (team). */
  account?: string;
};

/** Có đủ dữ liệu của Trading Agent (PnL, tóm tắt, lý do). */
function isFull(b: PickerBot): b is PickerBot & BotSummary {
  return "fills" in b && "engine" in b;
}

type Tone = "mm" | "grid" | "dca" | "exec";
const TONE: Record<string, Tone> = {
  volume_maker: "mm",
  spot_grid: "grid",
  futures_grid: "grid",
  spot_dca: "dca",
  futures_dca: "dca",
  adaptive_dca: "dca",
  recurring_buy: "dca",
};
const BADGE: Record<Tone, string> = {
  mm: "bg-accent-tint text-accent-ink",
  grid: "bg-bot-orange text-cat-grid-ink",
  dca: "bg-bot-teal text-cat-dca-ink",
  exec: "bg-cat-exec-bg text-ink-2",
};

function useCreated() {
  const me = useMe();
  const tz = me.data?.timezone ?? "Asia/Ho_Chi_Minh";
  return (iso: string) =>
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(
      new Date(iso),
    );
}

/** Nhãn dùng chung: tên chiến lược, market, tóm tắt cấu hình (thiếu thì capital). */
function useBotText() {
  const tf = useTranslations("createBot");
  const names = useMarketNames();
  return useMemo(
    () => ({
      strategy: (b: Pick<BotSummary, "strategy">) => tf(`strategies.${b.strategy}.name`),
      // Như botMarket: nhãn rổ tài sản (Rebalancing, Copy nhiều market) thay cho market.
      market: (b: Pick<BotSummary, "market" | "marketLabel">) =>
        b.marketLabel ?? names.market(b.market),
      summary: (b: BotSummary) => b.summary ?? botCapital(b, names),
      asset: (market: string) => names.asset(baseOf(market)),
    }),
    [tf, names],
  );
}

function Badge({ strategy, size }: { strategy: string; size: "sm" | "lg" }) {
  const t = useTranslations("agent.selector.abbr");
  return (
    <span
      aria-hidden="true"
      className={`flex flex-none items-center justify-center rounded-control font-extrabold tracking-[0.02em] ${BADGE[TONE[strategy] ?? "exec"]} ${size === "lg" ? "size-11 text-[11.5px]" : "size-10 text-[10.5px]"}`}
    >
      {t.has(strategy) ? t(strategy) : strategy.slice(0, 4).toUpperCase()}
    </span>
  );
}

function IdTag({ id, className = "" }: { id: string; className?: string }) {
  return (
    <span className={`flex-none font-mono text-[12.5px] text-muted ${className}`}>
      {shortId(id)}
    </span>
  );
}

const join = (parts: readonly (string | null | undefined)[]) =>
  parts.filter((p): p is string => p !== null && p !== undefined && p !== "").join(" · ");

/** Thanh tóm tắt bot đang xem (desktop) / thẻ đầu trang (điện thoại); `right` là phần bên phải. */
function Summary({ bot, phone, right }: { bot: BotSummary; phone: boolean; right: ReactNode }) {
  const t = useTranslations("agent.selector");
  const ts = useTranslations("states");
  const text = useBotText();
  const version = bot.activeVersion === null ? null : t("version", { version: bot.activeVersion });
  return (
    <>
      <Badge strategy={bot.strategy} size="lg" />
      <span className="flex min-w-0 flex-auto flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <strong className="truncate text-base text-ink">{bot.name}</strong>
          <IdTag id={bot.id} className="text-[13px]" />
        </span>
        <span className="truncate text-[13px] text-ink-2">
          {phone
            ? join([text.market(bot), version, text.summary(bot)])
            : join([text.market(bot), text.strategy(bot), version, text.summary(bot)])}
        </span>
      </span>
      {phone ? null : <StatusPill state={bot.state} label={ts(bot.state)} className="flex-none" />}
      {right}
    </>
  );
}

const cardClass =
  "flex min-h-16 min-w-0 items-center gap-3 rounded-[18px] border bg-surface px-3.5 py-2.5 text-left";

/** Đang tải danh sách: khung giữ chỗ cùng kích thước thanh chọn (artboard States · LOADING). */
export function BotSelectorSkeleton() {
  return (
    <div className={`${cardClass} border-border`}>
      <Skeleton className="size-11 flex-none" />
      <span className="flex flex-auto flex-col gap-2">
        <Skeleton className="h-3.5 w-56 max-w-full rounded-full" />
        <Skeleton className="h-3 w-[22rem] max-w-full rounded-full" />
      </span>
      <Skeleton className="h-5 w-24 flex-none rounded-full" />
    </div>
  );
}

/** Danh sách lỗi, bot trong URL vẫn hiện (artboard States · ERROR). */
export function BotSelectorError({
  bot,
  onRetry,
}: {
  bot: BotSummary | undefined;
  onRetry: () => void;
}) {
  const t = useTranslations("agent.selector");
  const text = useBotText();
  return (
    <div className="flex flex-wrap items-stretch gap-2.5">
      {bot === undefined ? null : (
        <div className={`${cardClass} flex-[1_1_320px] border-border`}>
          <Badge strategy={bot.strategy} size="lg" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <strong className="truncate text-base text-ink">{bot.name}</strong>
              <IdTag id={bot.id} className="text-[13px]" />
            </span>
            <span className="truncate text-[13px] text-ink-2">
              {join([
                text.market(bot),
                text.strategy(bot),
                bot.activeVersion === null ? null : t("version", { version: bot.activeVersion }),
              ])}
            </span>
          </span>
        </div>
      )}
      <div
        role="alert"
        className="flex min-h-16 flex-[1_1_320px] items-center gap-3 rounded-[18px] bg-neg-bg px-3.5 py-2.5 text-sm font-semibold text-neg-ink"
      >
        <AlertTriangle aria-hidden="true" size={18} className="flex-none" />
        <span className="flex-auto">{t("listError")}</span>
        <button
          type="button"
          onClick={onRetry}
          className="min-h-tap flex-none rounded-control border border-neg-border bg-surface px-3.5 text-sm font-bold text-neg-ink"
        >
          {t("retry")}
        </button>
      </div>
    </div>
  );
}

/** Lần làm mới gần nhất lỗi (artboard States · STALE). */
export function BotSelectorStale({ updatedAt }: { updatedAt: number }) {
  const t = useTranslations("agent.selector");
  const me = useMe();
  const time = formatDateTime(updatedAt, me.data?.timezone).split(", ").at(-1) ?? "";
  return (
    <p
      role="status"
      className="m-0 flex items-center gap-2 rounded-control bg-warn-bg px-3.5 py-2 text-[13px] font-semibold text-warn"
    >
      <Clock aria-hidden="true" size={15} className="flex-none" />
      {t("stale", { time })}
    </p>
  );
}

/** Một bot duy nhất: thẻ tóm tắt không bấm được, "Your only bot", nút New bot cạnh bên (artboard OneBot). */
function OnlyBot({ bot, phone }: { bot: BotSummary; phone: boolean }) {
  const t = useTranslations("agent.selector");
  const ta = useTranslations("agent");
  return (
    <div className="flex flex-wrap items-stretch gap-2.5">
      <div className={`${cardClass} flex-[1_1_480px] border-border`}>
        <Summary
          bot={bot}
          phone={phone}
          right={
            <span className="flex-none border-l border-border pl-2.5 text-[13px] text-muted">
              {t("onlyBot")}
            </span>
          }
        />
      </div>
      <Link
        href="/bots?tab=catalog"
        className="flex min-h-16 flex-none items-center justify-center gap-2 rounded-[18px] border border-border bg-surface px-4 text-sm font-bold text-ink no-underline max-sm:w-full"
      >
        <Plus aria-hidden="true" size={16} strokeWidth={2.4} />
        {ta("newAgent")}
      </Link>
    </div>
  );
}

export function BotSelector({
  bots,
  current,
}: {
  /** Danh sách bot của người dùng (gồm cả archived; draft bị bỏ). */
  bots: readonly BotSummary[];
  current: BotSummary;
}) {
  const t = useTranslations("agent.selector");
  const phone = useMediaQuery(PHONE);
  const all = useMemo(() => pickable(bots), [bots]);
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<PickerFilters>(DEFAULT_FILTERS);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const live = useMemo(() => liveOrder(all), [all]);
  const others = live.filter((b) => b.id !== current.id);
  const attention = all.filter((b) => b.id !== current.id && needsAttention(b)).length;
  const at = live.findIndex((b) => b.id === current.id);
  const prev = others.length === 0 ? null : at === -1 ? live.at(-1) : live.at(at - 1);
  const next = others.length === 0 ? null : at === -1 ? live[0] : live[(at + 1) % live.length];

  const openWith = (f: Partial<PickerFilters> = {}) => {
    setFilters({ ...DEFAULT_FILTERS, ...f });
    setOpen(true);
  };
  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // Bấm ra ngoài hoặc Tab ra khỏi panel thì đóng (desktop; điện thoại do BottomSheet lo).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!open || phone || wrap === null) return;
    const outside = (n: EventTarget | null) => n instanceof Node && !wrap.contains(n);
    const onDown = (e: PointerEvent) => {
      if (outside(e.target)) close(false);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (outside(e.relatedTarget)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    wrap.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      wrap.removeEventListener("focusout", onFocusOut);
    };
  }, [open, phone, close]);

  if (all.length <= 1 && all[0]?.id === current.id) return <OnlyBot bot={current} phone={phone} />;

  // Gõ chữ khi đang ở nút mở: mở panel và bắt đầu tìm (type-to-search).
  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      openWith({ query: e.key });
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      openWith();
    }
  };

  const panel = (
    <BotPickerPanel
      bots={all}
      currentId={current.id}
      filters={filters}
      setFilters={setFilters}
      phone={phone}
      onPick={() => {
        setOpen(false);
      }}
      onEscape={() => {
        close(true);
      }}
    />
  );

  if (phone)
    return (
      <div className="flex flex-col gap-2.5">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            openWith();
          }}
          onKeyDown={onTriggerKey}
          className={`${cardClass} w-full border-border`}
        >
          <Summary
            bot={current}
            phone
            right={
              <span className="flex flex-none flex-col items-center gap-0.5 text-xs font-bold text-accent-ink">
                <ChevronsUpDown aria-hidden="true" size={18} />
                {t("switchShort")}
              </span>
            }
          />
        </button>
        {attention > 0 ? (
          <button
            type="button"
            onClick={() => {
              openWith();
            }}
            className="flex min-h-tap w-full items-center gap-2 rounded-tile border border-neg-border bg-neg-soft px-3.5 text-left text-[13.5px] font-bold text-neg-ink"
          >
            <AlertTriangle aria-hidden="true" size={16} className="flex-none" />
            <span className="flex-auto">{t("attentionOther", { n: attention })}</span>
            <span className="flex-none">{t("view")}</span>
          </button>
        ) : null}
        <BottomSheet
          open={open}
          onOpenChange={setOpen}
          title={t("switchBot")}
          // Số bot không gồm archived (chỉ hiện ở bộ lọc Archived).
          description={t("count", { n: all.filter((b) => b.state !== BotState.archived).length })}
          closeLabel={t("close")}
          fullScreen
        >
          {panel}
        </BottomSheet>
      </div>
    );

  const arrow = (to: BotSummary | null | undefined, label: string, icon: ReactNode) =>
    to === null || to === undefined ? (
      <button
        type="button"
        disabled
        aria-label={label}
        className="flex min-h-16 w-12 items-center justify-center rounded-[16px] border border-border-input bg-surface text-muted opacity-60"
      >
        {icon}
      </button>
    ) : (
      <Link
        href={`/agent/${to.id}`}
        aria-label={label}
        className="flex min-h-16 w-12 items-center justify-center rounded-[16px] border border-border-input bg-surface text-ink"
      >
        {icon}
      </Link>
    );

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex flex-wrap items-stretch gap-2.5">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            if (open) close(false);
            else openWith();
          }}
          onKeyDown={onTriggerKey}
          className={`${cardClass} flex-[1_1_520px] ${open ? "border-accent" : "border-border"}`}
        >
          <Summary
            bot={current}
            phone={false}
            right={
              <span className="flex flex-none items-center gap-1.5 border-l border-border pl-2.5 text-[13px] font-bold text-accent-ink">
                {t("switchBot")}
                {open ? (
                  <ChevronUp aria-hidden="true" size={18} />
                ) : (
                  <ChevronDown aria-hidden="true" size={18} />
                )}
              </span>
            }
          />
        </button>
        <div className="flex gap-1.5">
          {arrow(prev, t("prev"), <ChevronLeft aria-hidden="true" size={18} />)}
          {arrow(next, t("next"), <ChevronRight aria-hidden="true" size={18} />)}
        </div>
        {attention > 0 ? (
          <button
            type="button"
            onClick={() => {
              openWith();
            }}
            className="flex min-h-16 items-center gap-2 rounded-[16px] border border-neg-border bg-neg-soft px-4 text-[13.5px] font-bold text-neg-ink"
          >
            <AlertTriangle aria-hidden="true" size={16} />
            {t("attention", { n: attention })}
          </button>
        ) : null}
      </div>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={t("switchBot")}
          className="absolute top-[74px] left-0 z-30 flex w-[min(880px,100%)] flex-col rounded-[20px] border border-border-input bg-surface shadow-card"
        >
          {panel}
        </div>
      ) : null}
    </div>
  );
}

/** Không có bot nào đang chạy, chỉ có bot đã dừng (artboard Empty, biến thể): mở danh sách ở bộ lọc Stopped. */
export function NoneRunning({ bots }: { bots: readonly BotSummary[] }) {
  const t = useTranslations("agent.selector");
  const ta = useTranslations("agent");
  const phone = useMediaQuery(PHONE);
  const all = pickable(bots);
  const stopped = all.filter((b) => groupOf(b) === "stopped").length;
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<PickerFilters>(DEFAULT_FILTERS);
  return (
    <section
      aria-labelledby="none-running-title"
      className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-border bg-surface p-5"
    >
      <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
        <h2 id="none-running-title" className="m-0 text-lg font-extrabold">
          {t("noneRunning.title")}
        </h2>
        <p className="m-0 text-sm text-ink-2">{t("noneRunning.body", { n: stopped })}</p>
      </div>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <button
          type="button"
          onClick={() => {
            setFilters({ ...DEFAULT_FILTERS, state: "stopped" });
            setOpen(true);
          }}
          className="min-h-tap rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink"
        >
          {t("noneRunning.open")}
        </button>
        <Link
          href="/bots?tab=catalog"
          className="flex min-h-tap items-center justify-center rounded-control bg-accent px-4 text-sm font-bold text-white no-underline"
        >
          {ta("newAgent")}
        </Link>
      </div>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title={t("switchBot")}
        description={t("count", { n: all.filter((b) => b.state !== BotState.archived).length })}
        closeLabel={t("close")}
        fullScreen
        wide
      >
        <BotPickerPanel
          bots={all}
          currentId={null}
          filters={filters}
          setFilters={setFilters}
          phone={phone}
          onPick={() => {
            setOpen(false);
          }}
          onEscape={null}
        />
      </BottomSheet>
    </section>
  );
}

/** Một mục của listbox: bot, hoặc null = lựa chọn "All …" (Signal Analysis). */
type Entry = PickerBot | null;
const ALL_KEY = "all";

/**
 * Panel chọn bot: ô tìm (combobox) + bộ lọc + listbox theo nhóm. Dùng chung cho panel desktop và BottomSheet của
 * Trading Agent, và bộ lọc Bot của Signal Analysis (#289: `onSelect`, `allOption`, `fixedStrategy`, `created`).
 */
export function BotPickerPanel({
  bots,
  currentId,
  filters,
  setFilters,
  phone,
  onPick,
  onEscape,
  onSelect,
  allOption,
  fixedStrategy = false,
  created,
  keysHint,
  manageLink = true,
}: {
  bots: readonly PickerBot[];
  /** Bot đang xem / đang chọn; null = không bot nào (hoặc lựa chọn "All …" khi có `allOption`). */
  currentId: string | null;
  filters: PickerFilters;
  setFilters: (f: PickerFilters) => void;
  phone: boolean;
  onPick: () => void;
  /** Esc trong ô tìm; null = để dialog (BottomSheet) tự đóng. */
  onEscape: (() => void) | null;
  /** Chọn một mục (null = "All …"); mặc định mở /agent/:botId như Trading Agent. */
  onSelect?: (id: string | null) => void;
  /** Dòng "All …" đầu danh sách (ẩn khi đang tìm). */
  allOption?: { label: string; sub: string };
  /** Danh sách chỉ có một chiến lược cố định: ẩn bộ lọc Strategy. */
  fixedStrategy?: boolean;
  /** Ngày tạo theo múi giờ của trang gọi; mặc định múi giờ của account. */
  created?: (iso: string) => string;
  /** Dòng phím tắt ở chân panel; mặc định câu của Trading Agent. */
  keysHint?: string;
  /** Link "Manage all bots in Strategy Lab" ở chân panel. */
  manageLink?: boolean;
}) {
  const t = useTranslations("agent.selector");
  const router = useRouter();
  const text = useBotText();
  const listId = useId();
  const optId = (id: string) => `${listId}-${id}`;
  const view = useMemo(() => pickerView(bots, filters, text, text.asset), [bots, filters, text]);
  const counts = stateCounts(bots);
  const searching = filters.query.trim() !== "";
  const showAll = allOption !== undefined && !searching;
  const entries: Entry[] = showAll ? [null, ...view.flat] : view.flat;
  const keyOf = (e: Entry) => (e === null ? ALL_KEY : e.id);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      entries.findIndex((e) => (e === null ? null : e.id) === currentId),
    ),
  );
  const flatKey = entries.map(keyOf).join(",");
  const firstRender = useRef(true);
  // Đổi tìm kiếm / bộ lọc: về dòng đầu.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setActive(0);
  }, [flatKey]);
  const activeEntry: Entry | undefined = entries[Math.min(active, entries.length - 1)];
  const activeId = activeEntry === undefined ? undefined : keyOf(activeEntry);
  useEffect(() => {
    if (activeId === undefined) return;
    document.getElementById(`${listId}-${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId, listId]);
  // Mở panel: focus vào ô tìm (Notes: "focus goes to the search box"). Chạy trước FocusScope của dialog, nên dialog
  // giữ focus ở đây thay vì nút đầu tiên.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pick = (e: Entry) => {
    onPick();
    if (onSelect !== undefined) onSelect(e === null ? null : e.id);
    else if (e !== null) router.push(`/agent/${e.id}`);
  };
  const set = (f: Partial<PickerFilters>) => {
    setFilters({ ...filters, ...f });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = entries.length - 1;
    const move = (i: number) => {
      e.preventDefault();
      if (last >= 0) setActive(Math.max(0, Math.min(last, i)));
    };
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(last);
    else if (e.key === "Enter") {
      e.preventDefault();
      if (activeEntry !== undefined) pick(activeEntry);
    } else if (e.key === "Escape" && onEscape !== null) {
      e.preventDefault();
      onEscape();
    }
  };

  const strategies = [...new Set(bots.map((b) => b.strategy))].sort((a, b) =>
    text.strategy({ strategy: a }).localeCompare(text.strategy({ strategy: b })),
  );
  const markets = [...new Set(bots.map((b) => text.asset(b.market)))].sort();
  const selectClass =
    "min-h-tap rounded-control border border-border-input bg-surface px-2 text-[13px] text-ink";

  return (
    <div className="flex min-h-0 flex-col">
      <div
        className={`flex flex-col gap-2.5 border-b border-border ${phone ? "pb-3" : "px-3.5 pt-3.5 pb-2.5"}`}
      >
        <label className="flex min-h-tap items-center gap-2.5 rounded-control border-2 border-accent bg-surface px-3">
          <Search aria-hidden="true" size={18} className="flex-none text-muted" />
          <span className="sr-only">{t("find")}</span>
          <input
            type="search"
            role="combobox"
            aria-expanded={entries.length > 0}
            aria-controls={entries.length > 0 ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={activeId === undefined ? undefined : optId(activeId)}
            ref={inputRef}
            value={filters.query}
            onChange={(e) => {
              set({ query: e.target.value });
            }}
            onKeyDown={onKey}
            placeholder={t("placeholder")}
            className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
          {phone ? null : (
            <span
              aria-hidden="true"
              className="flex-none rounded-md border border-border-input px-1.5 text-xs text-muted"
            >
              {t("esc")}
            </span>
          )}
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <span id={`${listId}-state`} className="mr-0.5 text-[12.5px] font-bold text-ink-2">
            {t("state")}
          </span>
          <div
            role="group"
            aria-labelledby={`${listId}-state`}
            className={`flex gap-1.5 ${phone ? "-mx-1 overflow-x-auto px-1 pb-1" : "flex-wrap"}`}
          >
            {STATE_FILTERS.map((f) => {
              const on = filters.state === f;
              return (
                <button
                  key={f}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    set({ state: f, showStopped: false });
                  }}
                  className={`min-h-tap flex-none rounded-full border px-3 text-[13px] font-extrabold whitespace-nowrap ${on ? "border-accent bg-accent text-white" : "border-border-input bg-surface text-ink"}`}
                >
                  {t(`stateFilters.${f}`)} <span className="font-semibold">{counts[f]}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className={`gap-2 ${phone ? "grid grid-cols-2" : "flex flex-wrap items-center"}`}>
          {fixedStrategy ? null : (
            <label className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-2">
              <span className={phone ? "sr-only" : ""}>{t("strategy")}</span>
              <select
                value={filters.strategy}
                onChange={(e) => {
                  set({ strategy: e.target.value });
                }}
                className={`${selectClass} ${phone ? "w-full" : ""}`}
              >
                <option value="all">{t("allStrategies")}</option>
                {strategies.map((s) => (
                  <option key={s} value={s}>
                    {text.strategy({ strategy: s })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-2">
            <span className={phone ? "sr-only" : ""}>{t("market")}</span>
            <select
              value={filters.market}
              onChange={(e) => {
                set({ market: e.target.value });
              }}
              className={`${selectClass} ${phone ? "w-full" : ""}`}
            >
              <option value="all">{t("allMarkets")}</option>
              {markets.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <p role="status" className="sr-only">
        {searching ? t("matchCount", { n: view.flat.length }) : ""}
      </p>

      <div className={`overflow-y-auto ${phone ? "pt-1.5" : "max-h-[560px] px-2 pt-1.5 pb-2"}`}>
        {entries.length === 0 ? null : (
          <div id={listId} role="listbox" aria-label={t("switchBot")} className="flex flex-col">
            {showAll ? (
              <AllRow
                id={optId(ALL_KEY)}
                label={allOption.label}
                sub={allOption.sub}
                current={currentId === null}
                active={activeId === ALL_KEY}
                phone={phone}
                onPick={() => {
                  pick(null);
                }}
                onHover={() => {
                  setActive(0);
                }}
              />
            ) : null}
            {view.groups.map((g) => (
              <Group
                key={g.key}
                group={g.key}
                bots={g.bots}
                currentId={currentId}
                activeId={activeId}
                optId={optId}
                phone={phone}
                created={created}
                onPick={pick}
                onHover={(b) => {
                  setActive(entries.indexOf(b));
                }}
              />
            ))}
          </div>
        )}
        {view.flat.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-7 text-center">
            <strong className="text-[15px]">
              {searching ? t("noMatch", { query: filters.query.trim() }) : t("noMatchFilters")}
            </strong>
            <span className="text-[13.5px] text-ink-2">{t("noMatchHint")}</span>
            <button
              type="button"
              onClick={() => {
                setFilters(DEFAULT_FILTERS);
              }}
              className="min-h-tap rounded-control border border-border-input bg-surface px-3.5 text-sm font-bold text-ink"
            >
              {t("clear")}
            </button>
          </div>
        ) : null}
        {view.hiddenStopped > 0 ? (
          <button
            type="button"
            aria-expanded={false}
            onClick={() => {
              set({ showStopped: true });
            }}
            className="mt-1.5 min-h-tap w-full rounded-control border border-dashed border-border-input bg-surface-2 text-[13.5px] font-bold text-ink-2"
          >
            {t("showStopped", { n: view.hiddenStopped })}
          </button>
        ) : null}
      </div>

      {phone ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-2.5 text-[12.5px] text-muted">
          <span aria-hidden="true">{keysHint ?? t("keys")}</span>
          <span className="flex-1" />
          {manageLink ? (
            <Link href="/bots" className="font-bold text-accent-ink">
              {t("manage")}
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Group({
  group,
  bots,
  currentId,
  activeId,
  optId,
  phone,
  created,
  onPick,
  onHover,
}: {
  group: PickerGroup;
  bots: readonly PickerBot[];
  currentId: string | null;
  activeId: string | undefined;
  optId: (id: string) => string;
  phone: boolean;
  created: ((iso: string) => string) | undefined;
  onPick: (b: PickerBot) => void;
  onHover: (b: PickerBot) => void;
}) {
  const t = useTranslations("agent.selector");
  const title = t(`groups.${group}`);
  return (
    <div role="group" aria-label={t("groupLabel", { title, n: bots.length })}>
      <div
        aria-hidden="true"
        className={`flex items-center gap-2 px-2 pt-2.5 pb-1.5 text-xs font-extrabold tracking-[0.04em] uppercase ${group === "attention" ? "text-neg-ink" : "text-ink-2"}`}
      >
        {title} <span className="font-bold text-muted">{bots.length}</span>
      </div>
      {bots.map((b) => (
        <Row
          key={b.id}
          bot={b}
          id={optId(b.id)}
          current={b.id === currentId}
          active={b.id === activeId}
          attention={group === "attention"}
          phone={phone}
          created={created}
          onPick={onPick}
          onHover={onHover}
        />
      ))}
    </div>
  );
}

/** Dòng "All VB bots" / "All MM bots" đầu danh sách (Signal Analysis): bỏ lọc theo bot. */
function AllRow({
  id,
  label,
  sub,
  current,
  active,
  phone,
  onPick,
  onHover,
}: {
  id: string;
  label: string;
  sub: string;
  current: boolean;
  active: boolean;
  phone: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const t = useTranslations("agent.selector");
  return (
    // Bàn phím đi qua ô tìm (aria-activedescendant), như Row.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={current}
      data-active={active || undefined}
      onClick={onPick}
      onMouseMove={() => {
        if (!active) onHover();
      }}
      className={`mt-1 grid min-h-tap cursor-pointer items-center gap-3 rounded-[14px] border-2 p-2.5 text-ink ${
        phone ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[40px_minmax(0,1fr)_128px]"
      } ${current ? "border-accent bg-accent-tint" : active ? "border-border-input bg-surface-2" : "border-transparent bg-surface"}`}
    >
      {phone ? null : <span aria-hidden="true" className="size-10 flex-none" />}
      <span className="flex min-w-0 flex-col gap-0.5">
        <strong className="truncate text-[14.5px]">{label}</strong>
        <span className="truncate text-[12.5px] text-ink-2">{sub}</span>
      </span>
      <span className="flex flex-col items-end gap-1">
        {current ? (
          <span className="inline-flex items-center gap-1 text-xs font-extrabold text-accent-ink">
            <Check aria-hidden="true" size={14} strokeWidth={2.6} />
            {t("viewing")}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Tên đọc của một dòng: "BTC Market Making, id ending 3f0a9d21, BTC-USD, version 4, Running, net PnL up 18.42 USDC". */
function useOptionName() {
  const t = useTranslations("agent.selector");
  const ts = useTranslations("states");
  const tm = useTranslations("common.missing");
  const text = useBotText();
  const names = useMarketNames();
  return (b: PickerBot) => {
    let pnl: string | null;
    if (!isFull(b)) pnl = null;
    else if (b.fills === 0) pnl = tm("noFillsYet");
    else if (b.netPnl === null) pnl = tm("notAvailable");
    else {
      const quote = b.engine === "spot" ? names.info(b.market)?.quote : null;
      const unit = quote === null || quote === undefined ? "USDC" : names.asset(quote);
      const v = `${formatDecimal(dec(b.netPnl).abs(), { locale: "en-US", maximumFractionDigits: 2 }) ?? b.netPnl} ${unit}`;
      const d = dec(b.netPnl);
      pnl = d.isZero()
        ? t("sr.pnlFlat", { value: v })
        : t(d.isNegative() ? "sr.pnlDown" : "sr.pnlUp", { value: v });
    }
    return join([
      b.name,
      t("sr.idEnding", { id: b.id.slice(-8) }),
      text.market(b),
      b.activeVersion === null ? null : t("sr.version", { version: b.activeVersion }),
      b.account,
      ts(b.state),
      pnl,
    ]).replaceAll(" · ", ", ");
  };
}

function Row({
  bot: b,
  id,
  current,
  active,
  attention,
  phone,
  created: createdIn,
  onPick,
  onHover,
}: {
  bot: PickerBot;
  id: string;
  current: boolean;
  active: boolean;
  attention: boolean;
  phone: boolean;
  created: ((iso: string) => string) | undefined;
  onPick: (b: PickerBot) => void;
  onHover: (b: PickerBot) => void;
}) {
  const t = useTranslations("agent.selector");
  const ts = useTranslations("states");
  const text = useBotText();
  const createdOwn = useCreated();
  const created = createdIn ?? createdOwn;
  const full = isFull(b) ? b : null;
  const reasonLabel = useReasonLabel();
  const waiting = useWaitingText();
  const optionName = useOptionName();
  const version = b.activeVersion === null ? null : t("version", { version: b.activeVersion });
  const summary = full === null ? null : text.summary(full);
  const reason =
    full !== null && full.reasonCode !== null && (attention || full.state !== BotState.running)
      ? reasonLabel({
          reasonCode: full.reasonCode,
          strategy: full.strategy,
          mode: full.mode,
          stopDetail: full.stopDetail,
        })
      : attention
        ? ts("needsAttention")
        : null;
  // Không có PnL (Signal Analysis): bỏ cột, không hiện số bịa (quy tắc 1.8).
  const pnl =
    full === null ? null : full.waiting !== null && full.fills === 0 ? (
      <span className="text-[13px] font-semibold text-muted">{waiting(full.waiting)}</span>
    ) : (
      <BotProfit bot={full} className="text-[13.5px] font-extrabold" />
    );
  const pill = <StatusPill state={b.state} label={ts(b.state)} />;
  const viewing = current ? (
    <span className="inline-flex items-center gap-1 text-xs font-extrabold text-accent-ink">
      <Check aria-hidden="true" size={14} strokeWidth={2.6} />
      {t("viewing")}
    </span>
  ) : null;
  const reasonLine =
    reason === null ? null : (
      <span
        className={`truncate text-[12.5px] font-bold ${attention ? "text-neg-ink" : "text-ink-2"}`}
      >
        {attention ? <span aria-hidden="true">▲ </span> : null}
        {reason}
      </span>
    );
  const nameLine = (
    <span className="flex min-w-0 items-baseline gap-2">
      <strong className="truncate text-[14.5px]">{b.name}</strong>
      <IdTag id={b.id} />
      {full?.mode === "paper" ? (
        <span className="flex-none self-center">
          <PaperChip short />
        </span>
      ) : null}
    </span>
  );
  return (
    // Bàn phím đi qua ô tìm (aria-activedescendant); tabIndex -1 để dòng không nằm trong thứ tự Tab.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={current}
      aria-label={optionName(b)}
      data-active={active || undefined}
      onClick={() => {
        onPick(b);
      }}
      onMouseMove={() => {
        if (!active) onHover(b);
      }}
      className={`grid min-h-tap cursor-pointer items-center gap-3 rounded-[14px] border-2 p-2.5 text-ink ${
        phone
          ? "grid-cols-[minmax(0,1fr)_auto]"
          : full === null
            ? "grid-cols-[40px_minmax(0,1fr)_128px]"
            : "grid-cols-[40px_minmax(0,1fr)_120px_128px]"
      } ${current ? "border-accent bg-accent-tint" : active ? "border-border-input bg-surface-2" : "border-transparent bg-surface"}`}
    >
      {phone ? (
        <>
          <span className="flex min-w-0 flex-col gap-0.5">
            {nameLine}
            <span className="truncate text-[12.5px] text-ink-2">
              {join([text.market(b), version, summary, b.account])}
            </span>
            {reasonLine}
          </span>
          <span className="flex flex-col items-end gap-1 text-right">
            {pill}
            {pnl}
            {viewing}
          </span>
        </>
      ) : (
        <>
          <Badge strategy={b.strategy} size="sm" />
          <span className="flex min-w-0 flex-col gap-0.5">
            {nameLine}
            <span className="truncate text-[12.5px] text-ink-2">
              {join([
                text.market(b),
                text.strategy(b),
                version,
                t("created", { date: created(b.createdAt) }),
                b.account,
              ])}
            </span>
            {summary === null ? null : (
              <span className="truncate text-[12.5px] text-muted">{summary}</span>
            )}
            {reasonLine}
          </span>
          {full === null ? null : (
            <span className="flex flex-col items-end gap-0.5 text-right">
              {pnl}
              {full.fills > 0 && full.netPnl !== null ? (
                <span className="text-[11.5px] text-muted">{t("netPnl")}</span>
              ) : null}
            </span>
          )}
          <span className="flex flex-col items-end gap-1">
            {pill}
            {viewing}
          </span>
        </>
      )}
    </div>
  );
}
