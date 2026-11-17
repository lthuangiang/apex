"use client";

import {
  SODEX_CALL_RANGES,
  SODEX_CALL_SHOW,
  type SodexCallItem,
  type SodexCallShow,
} from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, Info, RefreshCw, Search, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { ApiError } from "@/lib/api";

import {
  DEFAULT_FILTERS,
  hasNarrowingFilters,
  SODEX_CALLS_KEY,
  useSodexCall,
  useSodexCalls,
  useSodexFacets,
  type Filters,
} from "../api";
import {
  formatCappedCount,
  formatMs,
  localTime,
  maskAddress,
  methodLabel,
  utcHour,
  utcOffsetLabel,
  utcTime,
} from "../format";

import { OutcomeTag } from "./bits";
import { CallDetail } from "./call-detail";
import { ReportDialog } from "./report-dialog";
import { Summary } from "./summary";

// SoDEX Debugger (team, docs/mockups/sodex-debugger): mọi request SoDEX và sự kiện WS user stream. Dữ liệu chỉ từ
// `/api/v1/admin/sodex-calls*` (role team); bundle web chỉ có cách hiển thị. Phím tắt: j/k chọn, Enter mở, Esc đóng,
// / tìm kiếm, c mở báo cáo.

const HOUR_MS = 3_600_000;
const SHOW_KEY = { all: "all", errors: "errors", timeouts: "timeouts", slow: "slow" } as const;

const selectCls =
  "min-h-tap max-w-full cursor-pointer appearance-none rounded-control border border-border-input bg-surface bg-[length:7px_7px] pr-[34px] pl-3 text-sm font-semibold text-ink";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function SodexDebuggerPage() {
  const t = useTranslations("sodexDebugger");
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [myTime, setMyTime] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);
  const [moreFilters, setMoreFilters] = useState(false);
  const [offset, setOffset] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const list = useSodexCalls(filters);
  const facets = useSodexFacets(filters.range);
  const detail = useSodexCall(openId);
  const items: SodexCallItem[] = list.data?.pages.flatMap((p) => p.items) ?? [];
  const first = list.data?.pages[0];
  const forbidden = list.error instanceof ApiError && list.error.code === "FORBIDDEN";

  // Lệch giờ của trình duyệt (không có khi render ở server) và ?call=<id> của "Copy link".
  useEffect(() => {
    setOffset(-new Date().getTimezoneOffset());
    const id = new URLSearchParams(window.location.search).get("call");
    if (id !== null && id !== "") setOpenId(id);
  }, []);

  const open = (id: string) => {
    setOpenId(id);
    const i = items.findIndex((x) => x.id === id);
    if (i >= 0) setActive(i);
  };
  const close = () => {
    const id = openId;
    setOpenId(null);
    setReportOpen(false);
    if (id !== null) rowRefs.current.get(id)?.focus();
  };
  const move = (delta: number) => {
    if (items.length === 0) return;
    const i = Math.min(items.length - 1, Math.max(0, active + delta));
    setActive(i);
    const it = items[i];
    if (it === undefined) return;
    if (openId !== null) setOpenId(it.id);
    rowRefs.current.get(it.id)?.scrollIntoView({ block: "nearest" });
  };

  // Phím tắt của trang; bỏ qua khi đang gõ hoặc hộp thoại báo cáo đang mở (Radix tự xử lý Esc).
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    if (reportOpen || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (openId !== null) {
        e.preventDefault();
        close();
      } else if (isTyping(e.target) && e.target instanceof HTMLElement) e.target.blur();
      return;
    }
    if (isTyping(e.target)) return;
    if (e.key === "j") {
      e.preventDefault();
      move(1);
    } else if (e.key === "k") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      const target = e.target;
      if (target instanceof HTMLElement && target.closest("button, a, summary") !== null) return;
      const it = items[active];
      if (it !== undefined) {
        e.preventDefault();
        open(it.id);
      }
    } else if (e.key === "/") {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (e.key === "c" && openId !== null && detail.data !== undefined) {
      e.preventDefault();
      setReportOpen(true);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keys.current(e);
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, []);

  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setActive(0);
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: SODEX_CALLS_KEY });
  };
  const offsetLabel = utcOffsetLabel(offset);
  const detailOpen = openId !== null;

  if (forbidden) {
    return (
      <Workspace current="sodexDebugger">
        <div className="flex flex-col gap-4">
          <PageHead title={t("title")} subtitle={t("lede")} />
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        </div>
      </Workspace>
    );
  }

  return (
    <Workspace current="sodexDebugger">
      <div className={`flex flex-col gap-4 ${detailOpen ? "lg:mr-[580px]" : ""}`}>
        <div className={`flex flex-col gap-4 ${detailOpen ? "max-md:hidden" : ""}`}>
          <PageHead
            title={t("title")}
            subtitle={t("lede")}
            action={
              <div className="flex flex-wrap items-center gap-2.5">
                <MyTimeSwitch
                  label={t("myTime", { offset: offsetLabel })}
                  checked={myTime}
                  onChange={setMyTime}
                />
                {first === undefined ? null : (
                  <span className="text-[13px] text-muted">
                    {t("updated", { time: utcTime(first.readAt, false) })}
                  </span>
                )}
                <Button variant="secondary" onClick={refresh}>
                  <RefreshCw aria-hidden="true" size={16} strokeWidth={2.2} />
                  {t("refresh")}
                </Button>
              </div>
            }
          />
          <p className="m-0 text-sm leading-normal text-ink-2 lg:hidden">{t("lede")}</p>
          <p className="m-0 -mt-2 text-[13px] leading-[1.45] text-muted max-lg:mt-0">{t("note")}</p>
          <FilterCard
            filters={filters}
            set={set}
            facets={facets.data}
            counts={first?.counts ?? undefined}
            searchRef={searchRef}
            moreFilters={moreFilters}
            setMoreFilters={setMoreFilters}
          />
          <Summary
            slowMs={filters.slowMs}
            myTime={myTime}
            narrow={detailOpen}
            onPickHour={(hour) => {
              set({
                range: "24h",
                hour: {
                  after: hour,
                  before: new Date(Date.parse(hour) + HOUR_MS).toISOString().replace(".000Z", "Z"),
                },
              });
            }}
          />
          <CallsCard
            list={list}
            items={items}
            filters={filters}
            set={set}
            split={detailOpen}
            openId={openId}
            active={active}
            myTime={myTime}
            onOpen={open}
            rowRefs={rowRefs.current}
          />
        </div>
        {openId === null ? null : (
          <CallDetail
            key={openId}
            id={openId}
            item={items.find((x) => x.id === openId)}
            myTime={myTime}
            onClose={close}
            onPrev={() => {
              move(-1);
            }}
            onNext={() => {
              move(1);
            }}
            onOpenCall={open}
            onReport={() => {
              setReportOpen(true);
            }}
          />
        )}
      </div>
      <ReportDialog detail={detail.data} open={reportOpen} onOpenChange={setReportOpen} />
    </Workspace>
  );
}

function MyTimeSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => {
        onChange(!checked);
      }}
      className="inline-flex min-h-tap cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-[13px] font-semibold text-ink-2"
    >
      <span
        aria-hidden="true"
        className={`relative h-[22px] w-9 flex-none rounded-[11px] ${checked ? "bg-accent" : "bg-border-input"}`}
      >
        <span
          className={`absolute top-[3px] size-4 rounded-full bg-surface ${checked ? "left-[17px]" : "left-[3px]"}`}
        />
      </span>
      {label}
    </button>
  );
}

function FilterCard({
  filters,
  set,
  facets,
  counts,
  searchRef,
  moreFilters,
  setMoreFilters,
}: {
  filters: Filters;
  set: (patch: Partial<Filters>) => void;
  facets:
    | {
        services: string[];
        endpoints: string[];
        bots: { id: string; name: string }[];
        accounts: string[];
      }
    | undefined;
  counts: Record<SodexCallShow, number> | undefined;
  searchRef: React.RefObject<HTMLInputElement | null>;
  moreFilters: boolean;
  setMoreFilters: (v: boolean) => void;
}) {
  const t = useTranslations("sodexDebugger");
  const [search, setSearch] = useState(filters.q ?? "");
  const [slow, setSlow] = useState(String(filters.slowMs));
  const radios = useRef(new Map<SodexCallShow, HTMLButtonElement>());
  useEffect(() => {
    setSearch(filters.q ?? "");
  }, [filters.q]);
  useEffect(() => {
    setSlow(String(filters.slowMs));
  }, [filters.slowMs]);
  const desk = moreFilters ? "" : "max-md:hidden";
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const q = search.trim();
    set({ q: q === "" ? null : q });
  };
  const commitSlow = () => {
    const n = Number(slow.replace(/,/g, ""));
    if (Number.isInteger(n) && n >= 1 && n <= 600_000) set({ slowMs: n });
    else setSlow(String(filters.slowMs));
  };
  const onRadioKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const i = SODEX_CALL_SHOW.indexOf(filters.show);
    const n = SODEX_CALL_SHOW.length;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? SODEX_CALL_SHOW[(i + 1) % n]
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? SODEX_CALL_SHOW[(i + n - 1) % n]
          : undefined;
    if (next === undefined) return;
    e.preventDefault();
    set({ show: next });
    radios.current.get(next)?.focus();
  };
  const sel = (
    id: string,
    label: string,
    value: string | null,
    allLabel: string | null,
    options: { value: string; label: string }[],
    onChange: (v: string | null) => void,
    hideOnPhone: boolean,
  ) => (
    <div className={`flex min-w-0 flex-col gap-1 ${hideOnPhone ? desk : ""}`}>
      <label htmlFor={id} className="text-xs font-bold text-ink-2">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => {
          onChange(e.target.value === "" ? null : e.target.value);
        }}
        className={selectCls}
        style={{
          backgroundImage:
            "linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%)",
          backgroundPosition: "calc(100% - 18px) 50%, calc(100% - 13px) 50%",
          backgroundSize: "5px 5px, 5px 5px",
          backgroundRepeat: "no-repeat",
        }}
      >
        {allLabel === null ? null : <option value="">{allLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <section
      aria-labelledby="sodex-filters-h"
      className="rounded-card border border-border bg-surface px-[18px] py-4 max-md:p-3.5"
    >
      <h2 id="sodex-filters-h" className="sr-only">
        {t("filters.heading")}
      </h2>
      <div className="flex flex-wrap items-end gap-2.5 max-md:gap-2">
        {sel(
          "sodex-f-time",
          t("filters.time"),
          filters.range,
          null,
          SODEX_CALL_RANGES.map((r) => ({ value: r, label: t(`ranges.${r}`) })),
          (v) => {
            const range = SODEX_CALL_RANGES.find((r) => r === v);
            if (range !== undefined) set({ range, hour: null });
          },
          false,
        )}
        {sel(
          "sodex-f-svc",
          t("filters.service"),
          filters.service,
          t("filters.allServices"),
          (facets?.services ?? []).map((s) => ({ value: s, label: s })),
          (v) => {
            set({ service: v });
          },
          true,
        )}
        {sel(
          "sodex-f-ep",
          t("filters.endpoint"),
          filters.endpoint,
          t("filters.allEndpoints"),
          (facets?.endpoints ?? []).map((s) => ({ value: s, label: s })),
          (v) => {
            set({ endpoint: v });
          },
          true,
        )}
        {sel(
          "sodex-f-bot",
          t("filters.bot"),
          filters.botId,
          t("filters.allBots"),
          (facets?.bots ?? []).map((b) => ({ value: b.id, label: b.name })),
          (v) => {
            set({ botId: v });
          },
          true,
        )}
        {sel(
          "sodex-f-acc",
          t("filters.account"),
          filters.account,
          t("filters.allAccounts"),
          (facets?.accounts ?? []).map((a) => ({ value: a, label: maskAddress(a) })),
          (v) => {
            set({ account: v });
          },
          true,
        )}
        <form
          role="search"
          onSubmit={submit}
          className="flex min-w-0 flex-[1_1_260px] flex-col gap-1 max-md:basis-full"
        >
          <label htmlFor="sodex-f-q" className="text-xs font-bold text-ink-2">
            {t("filters.search")}
          </label>
          <span className="relative flex">
            <Search
              aria-hidden="true"
              size={16}
              strokeWidth={2.2}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
            />
            <input
              ref={searchRef}
              id="sodex-f-q"
              type="search"
              value={search}
              aria-label={t("filters.searchLabel")}
              placeholder={t("filters.searchPlaceholder")}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              className="min-h-tap w-full rounded-control border border-border-input bg-surface pr-3 pl-9 text-sm font-medium text-ink placeholder:text-muted"
            />
          </span>
        </form>
        <Button
          variant="secondary"
          aria-expanded={moreFilters}
          className="md:hidden"
          onClick={() => {
            setMoreFilters(!moreFilters);
          }}
        >
          {t("filters.moreFilters")}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2.5 max-md:gap-2">
        <div
          role="radiogroup"
          aria-label={t("filters.outcome")}
          className="inline-flex gap-0.5 rounded-control border border-border-input bg-surface-2 p-[3px] max-md:w-full"
        >
          {SODEX_CALL_SHOW.map((s) => (
            <button
              key={s}
              ref={(el) => {
                if (el === null) radios.current.delete(s);
                else radios.current.set(s, el);
              }}
              type="button"
              role="radio"
              aria-checked={filters.show === s}
              tabIndex={filters.show === s ? 0 : -1}
              onKeyDown={onRadioKey}
              onClick={() => {
                set({ show: s });
              }}
              className={`min-h-9 cursor-pointer rounded-[9px] border-0 px-3 text-[13.5px] font-bold whitespace-nowrap max-md:flex-1 max-md:px-1 max-md:text-[13px] ${filters.show === s ? "bg-surface text-ink shadow-sm" : "bg-transparent text-ink-2"}`}
            >
              {t(`filters.${SHOW_KEY[s]}`)}
              {counts === undefined ? null : (
                <span className="ml-1 font-semibold text-muted max-md:hidden">
                  {formatCappedCount(counts[s])}
                </span>
              )}
            </button>
          ))}
        </div>
        <span
          className={`inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-2 ${desk}`}
        >
          <label htmlFor="sodex-f-slow">{t("filters.slowBefore")}</label>
          <input
            id="sodex-f-slow"
            inputMode="numeric"
            aria-label={t("filters.slowLabel")}
            value={slow}
            onChange={(e) => {
              setSlow(e.target.value);
            }}
            onBlur={commitSlow}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSlow();
            }}
            className="min-h-9 w-[84px] rounded-[10px] border border-border-input bg-surface px-2.5 font-mono text-[13px]"
          />
          <span aria-hidden="true">{t("filters.slowAfter")}</span>
        </span>
        {filters.hour === null ? null : (
          <span className="inline-flex min-h-[30px] items-center gap-1.5 rounded-full bg-accent-tint pr-1.5 pl-2.5 text-[12.5px] font-bold text-accent-ink">
            {t("filters.hourChip", {
              from: utcHour(filters.hour.after),
              to: utcHour(filters.hour.before),
            })}
            <button
              type="button"
              aria-label={t("filters.removeHour", {
                from: utcHour(filters.hour.after),
                to: utcHour(filters.hour.before),
              })}
              onClick={() => {
                set({ hour: null });
              }}
              className="inline-flex size-[22px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-accent-ink"
            >
              <X aria-hidden="true" size={12} strokeWidth={2.4} />
            </button>
          </span>
        )}
        {hasNarrowingFilters(filters) ? (
          <button
            type="button"
            onClick={() => {
              set({ ...DEFAULT_FILTERS, range: filters.range, slowMs: filters.slowMs });
            }}
            className="cursor-pointer border-0 bg-transparent px-0.5 py-1.5 text-[13px] font-bold text-accent-ink underline"
          >
            {t("filters.clear")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function CallsCard({
  list,
  items,
  filters,
  set,
  split,
  openId,
  active,
  myTime,
  onOpen,
  rowRefs,
}: {
  list: ReturnType<typeof useSodexCalls>;
  items: SodexCallItem[];
  filters: Filters;
  set: (patch: Partial<Filters>) => void;
  split: boolean;
  openId: string | null;
  active: number;
  myTime: boolean;
  onOpen: (id: string) => void;
  rowRefs: Map<string, HTMLButtonElement>;
}) {
  const t = useTranslations("sodexDebugger");
  const first = list.data?.pages[0];
  const rangeNoun = t(`rangeNoun.${filters.range}`);
  const stale = list.isError && list.data !== undefined;
  const ref = (id: string) => (el: HTMLButtonElement | null) => {
    if (el === null) rowRefs.delete(id);
    else rowRefs.set(id, el);
  };
  const says = (r: SodexCallItem) =>
    r.outcome === "ok" ? (
      <span className="text-muted">
        {r.latencyMs > filters.slowMs ? t("calls.slow") : t("calls.none")}
      </span>
    ) : r.sodexSays === null ? (
      <span className="text-muted">{t("calls.none")}</span>
    ) : (
      <span className="font-mono">{r.sodexSays}</span>
    );
  const lat = (r: SodexCallItem, small = false) => {
    const slow = r.latencyMs > filters.slowMs;
    return (
      <span
        className={`${slow ? "font-extrabold text-warn" : "font-semibold"} ${small ? "ml-1 text-xs" : ""}`}
      >
        {slow ? "▲ " : ""}
        {formatMs(r.latencyMs)}
      </span>
    );
  };
  const label = (r: SodexCallItem) =>
    t("calls.open", {
      method: methodLabel(r),
      endpoint: r.endpoint,
      outcome: t(`outcome.${r.outcome}`),
      time: utcTime(r.at),
    });

  let body;
  if (list.isPending) {
    body = (
      <div aria-busy="true" className="px-[18px] pb-4">
        <span className="sr-only">{t("states.loading")}</span>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex gap-3 border-t border-border py-3">
            <Skeleton className="h-3 w-[22%]" />
            <Skeleton className="h-3 w-[46%]" />
            <Skeleton className="h-3 w-[16%]" />
          </div>
        ))}
      </div>
    );
  } else if (list.isError && list.data === undefined) {
    body = (
      <div role="alert" className="flex flex-col items-center gap-2 px-4 py-7 text-center">
        <AlertCircle aria-hidden="true" size={28} strokeWidth={2.2} className="text-neg-ink" />
        <h3 className="m-0 text-base font-extrabold">{t("states.errorTitle")}</h3>
        <p className="m-0 max-w-[320px] text-[13.5px] leading-normal text-ink-2">
          {t("states.errorBody")}
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            void list.refetch();
          }}
        >
          {t("states.retry")}
        </Button>
      </div>
    );
  } else if (items.length === 0) {
    const nothing =
      filters.range === "14d" && !hasNarrowingFilters(filters) && filters.show === "all";
    body = nothing ? (
      <div className="flex flex-col items-center gap-2 px-4 py-7 text-center">
        <h3 className="m-0 text-base font-extrabold">{t("states.nothingTitle")}</h3>
        <p className="m-0 max-w-[340px] text-[13.5px] leading-normal text-ink-2">
          {t("states.nothingBody")}
        </p>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-2 px-4 py-7 text-center">
        <Search aria-hidden="true" size={28} strokeWidth={2} />
        <h3 className="m-0 text-base font-extrabold">{t("states.emptyTitle")}</h3>
        <p className="m-0 max-w-[340px] text-[13.5px] leading-normal text-ink-2">
          {t("states.emptyBody", { range: rangeNoun })}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              set({ ...DEFAULT_FILTERS, range: filters.range, slowMs: filters.slowMs });
            }}
          >
            {t("states.clearFilters")}
          </Button>
          {filters.range === "14d" ? null : (
            <Button
              variant="secondary"
              onClick={() => {
                set({ range: "14d", hour: null });
              }}
            >
              {t("states.last14")}
            </Button>
          )}
        </div>
      </div>
    );
  } else {
    const th =
      "sticky top-0 bg-surface-2 px-2 py-[9px] text-left text-[11.5px] font-extrabold tracking-[.02em] whitespace-nowrap text-muted first:pl-[18px]";
    const td =
      "h-11 border-t border-border px-2 py-[5px] align-middle text-[13px] whitespace-nowrap first:pl-[18px]";
    const cols = split
      ? [t("calls.colTime"), t("calls.colEndpoint"), t("calls.colOutcomeLatency")]
      : [
          t("calls.colTime"),
          t("calls.colEndpointService"),
          t("calls.colStatus"),
          t("calls.colOutcome"),
          t("calls.colSays"),
          t("calls.colLatency"),
          t("calls.colBot"),
        ];
    body = (
      <>
        <div className="overflow-x-auto max-md:hidden">
          <table className="w-full border-collapse">
            <caption className="sr-only">{t("calls.caption")}</caption>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    className={`${th} ${c === t("calls.colLatency") ? "text-right" : ""}`}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((r, i) => {
                const sel = r.id === openId || (openId === null && i === active);
                const rowBg = sel ? "bg-accent-tint" : "group-hover:bg-surface-2";
                const firstCell = r.id === openId ? "shadow-[inset_4px_0_0_var(--accent)]" : "";
                const ep = (
                  <button
                    ref={ref(r.id)}
                    type="button"
                    aria-controls="sodex-call-detail"
                    aria-expanded={r.id === openId}
                    aria-label={label(r)}
                    onClick={() => {
                      onOpen(r.id);
                    }}
                    className={`inline-flex min-h-7 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left font-mono text-ink ${split ? "text-xs" : "text-[12.5px]"}`}
                  >
                    <span
                      className={`inline-block font-extrabold tracking-[.03em] text-[11px] ${split ? "min-w-10" : "min-w-[46px]"} ${r.kind === "ws" ? "text-unknown" : "text-ink-2"}`}
                    >
                      {methodLabel(r)}
                    </span>
                    {r.endpoint}
                  </button>
                );
                const time = (
                  <td className={`${td} ${rowBg} ${firstCell}`}>
                    <span className="font-mono">
                      {split ? utcTime(r.at, false) : utcTime(r.at)}
                    </span>
                    {myTime ? (
                      <>
                        <br />
                        <span className="text-xs text-muted">
                          {split
                            ? t("calls.yours", { time: localTime(r.at) })
                            : t("calls.yourTime", { time: localTime(r.at) })}
                        </span>
                      </>
                    ) : null}
                  </td>
                );
                return (
                  <tr
                    key={r.id}
                    className="group cursor-pointer"
                    onClick={(e) => {
                      if (e.target instanceof HTMLElement && e.target.closest("a, button") !== null)
                        return;
                      onOpen(r.id);
                    }}
                  >
                    {time}
                    {split ? (
                      <>
                        <td className={`${td} ${rowBg}`}>{ep}</td>
                        <td className={`${td} ${rowBg}`}>
                          <OutcomeTag outcome={r.outcome} />
                          <br />
                          {lat(r, true)}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={`${td} ${rowBg}`}>
                          {ep}
                          <br />
                          <span className="ml-[52px] rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11.5px] font-bold text-ink-2">
                            {r.service}
                          </span>
                        </td>
                        <td className={`${td} ${rowBg} font-mono`}>
                          {r.httpStatus === null ? t("calls.none") : String(r.httpStatus)}
                        </td>
                        <td className={`${td} ${rowBg}`}>
                          <OutcomeTag outcome={r.outcome} />
                        </td>
                        <td className={`${td} ${rowBg}`}>
                          <span
                            className="inline-block max-w-[190px] overflow-hidden align-middle text-[12.5px] text-ellipsis whitespace-nowrap text-ink-2"
                            title={r.sodexSays ?? undefined}
                          >
                            {says(r)}
                          </span>
                        </td>
                        <td className={`${td} ${rowBg} text-right`}>{lat(r)}</td>
                        <td className={`${td} ${rowBg}`}>
                          {r.bot === null ? (
                            <span className="text-muted">{t("calls.none")}</span>
                          ) : (
                            <Link href={`/agent/${r.bot.id}`}>{r.bot.name}</Link>
                          )}
                          {r.clOrdIds.length === 0 ? null : (
                            <>
                              <br />
                              <span className="font-mono text-xs text-ink-2">{r.clOrdIds[0]}</span>
                            </>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="m-0 flex list-none flex-col p-0 md:hidden">
          {items.map((r, i) => (
            <li key={r.id}>
              <button
                type="button"
                aria-label={label(r)}
                onClick={() => {
                  onOpen(r.id);
                }}
                className={`grid min-h-tap w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1 border-0 border-t border-border px-3.5 py-3 text-left text-ink ${openId === null && i === active ? "bg-accent-tint" : "bg-transparent"}`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <OutcomeTag outcome={r.outcome} />
                  <span className="font-mono text-xs">{utcTime(r.at, false)} UTC</span>
                  {myTime ? (
                    <span className="text-xs text-muted">
                      {t("calls.yours", { time: localTime(r.at).slice(0, 5) })}
                    </span>
                  ) : null}
                </span>
                <span
                  aria-hidden="true"
                  className="col-start-2 row-span-3 row-start-1 size-[9px] -rotate-45 self-center border-r-2 border-b-2 border-muted"
                />
                <span className="font-mono text-[12.5px] break-all">
                  <b className={`mr-1.5 ${r.kind === "ws" ? "text-unknown" : ""}`}>
                    {methodLabel(r)}
                  </b>
                  {r.endpoint}
                </span>
                <span className="text-xs text-ink-2">
                  {r.service} · {lat(r)}
                  {r.bot === null ? "" : ` · ${r.bot.name}`}
                  {r.outcome !== "ok" && r.sodexSays !== null ? (
                    <>
                      {" · "}
                      <span className="font-mono">{r.sodexSays}</span>
                    </>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <section
      aria-labelledby="sodex-calls-h"
      className="overflow-hidden rounded-card border border-border bg-surface"
    >
      {stale ? (
        <div
          role="status"
          className="m-3 flex items-center gap-2.5 rounded-[14px] bg-warn-bg px-4 py-3 text-sm font-semibold text-warn"
        >
          <AlertTriangle aria-hidden="true" size={18} strokeWidth={2.2} className="flex-none" />
          {t("states.stale", {
            failed: utcTime(new Date(list.errorUpdatedAt).toISOString(), false),
            shown: utcTime(new Date(list.dataUpdatedAt).toISOString(), false),
          })}
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-[18px] pt-3.5 pb-3 max-md:flex-col max-md:px-3.5 max-md:pb-1.5">
        <h2 id="sodex-calls-h" className="m-0 text-[15px] font-extrabold">
          {t("calls.heading")}{" "}
          {first === undefined ? null : (
            <span className="text-[13px] font-semibold text-muted">
              {t("calls.meta", {
                count: first.counts === null ? "" : formatCappedCount(first.counts.all),
                range: rangeNoun,
              })}
            </span>
          )}
        </h2>
        <p className="m-0 flex max-w-[560px] items-start gap-1.5 text-xs leading-[1.45] text-muted">
          <Info aria-hidden="true" size={14} strokeWidth={2} className="mt-px flex-none" />
          <span>{t("calls.retention")}</span>
        </p>
      </div>
      {body}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-[18px] py-3 text-[12.5px] text-muted max-md:px-3.5">
        <span className="max-md:hidden">
          <Kbd>j</Kbd> <Kbd>k</Kbd> {t("calls.keyMove")} · <Kbd>Enter</Kbd> {t("calls.keyOpen")} ·{" "}
          <Kbd>Esc</Kbd> {t("calls.keyClose")} · <Kbd>/</Kbd> {t("calls.keySearch")} · <Kbd>c</Kbd>{" "}
          {t("calls.keyCopy")}
        </span>
        {list.hasNextPage ? (
          <Button
            variant="secondary"
            className="min-h-9 px-3 text-[13px]"
            pending={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {t("calls.loadMore")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded-[5px] border border-b-2 border-border-input bg-surface px-[5px] font-mono text-[11.5px] text-ink-2">
      {children}
    </kbd>
  );
}
