"use client";

import type { DecisionOutcome } from "@drift/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { formatDateTime } from "@/lib/format";

import {
  groupDecisions,
  groupSummary,
  orderHref,
  orderTail,
  outcomeStatusKey,
  type BotEvent,
  type DecisionRow,
} from "../decision-groups";

// Trading Agent › Decisions & actions (BD-02, docs/mockups/bd02-decisions Main + Mobile): quyết định lặp lại được gộp
// thành một dòng mở ra được; mọi pill kết quả link tới lệnh theo clOrdID trong Execution & Orders.

const GRID = "grid grid-cols-[150px_240px_minmax(0,1fr)_230px] gap-3";
/** Số dòng con hiện trước khi bấm "Show all". */
const FIRST_CHILDREN = 5;
/** Dòng con thứ 6 nhận focus sau "Show all". */
const firstMore = (i: number) =>
  i === FIRST_CHILDREN ? { tabIndex: -1, "data-first-more": "" } : {};
/** Mobile: số dòng (đơn hoặc nhóm) hiện, như danh sách cũ. */
const MOBILE_ROWS = 10;

const clock = (v: string) => formatDateTime(v).split(", ").at(-1) ?? "";

function tone(o: DecisionOutcome): string {
  if (o === "filled" || o === "partly_filled") return "bg-pos-bg text-pos";
  if (o === "open") return "bg-accent-tint text-accent-ink";
  if (o === "unknown") return "bg-unknown-bg text-unknown";
  if (o === "rejected") return "bg-neg-bg text-neg-ink";
  return "bg-surface-2 text-ink-2 ring-1 ring-border ring-inset";
}

const PILL =
  "inline-flex items-center gap-[5px] rounded-full px-[11px] text-[12.5px] font-bold whitespace-nowrap no-underline";

function Arrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 9l6-6M4.5 3H9v4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function Chevron({ open, size = 14 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      className={`flex-none text-ink-2 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** Pill kết quả: link tới lệnh khi có clOrdID, nhãn lấy từ `orders.status.*`. */
function Result({
  botId,
  e,
  size = "md",
  legacy,
}: {
  botId: string;
  e: BotEvent;
  size?: "sm" | "md" | "lg";
  legacy: (text: string) => ReactNode;
}) {
  const t = useTranslations("agent.decisionsList");
  const ts = useTranslations("orders.status");
  if (e.outcome === null) return e.result === null ? null : legacy(e.result);
  const label = ts(outcomeStatusKey(e.outcome));
  const h = size === "lg" ? "min-h-8 px-3" : size === "sm" ? "min-h-6" : "min-h-7";
  if (e.order === null) return <span className={`${PILL} ${h} ${tone(e.outcome)}`}>{label}</span>;
  return (
    <Link
      href={orderHref(botId, e, e.order)}
      aria-label={t("showOrder", { result: label, tail: orderTail(e.order) })}
      className={`${PILL} ${h} ${tone(e.outcome)} hover:opacity-85`}
    >
      {label}
      <Arrow />
    </Link>
  );
}

function Summary({ events, small = false }: { events: readonly BotEvent[]; small?: boolean }) {
  const t = useTranslations("agent.decisionsList.summary");
  return (
    <span className="flex flex-wrap gap-1.5">
      {groupSummary(events).map(({ outcome, n }) => (
        <span
          key={outcome}
          className={`${PILL} ${small ? "min-h-[26px]" : "min-h-7"} ${tone(outcome)}`}
        >
          {t(outcomeStatusKey(outcome), { n })}
        </span>
      ))}
    </span>
  );
}

function useOpen() {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState<Record<string, boolean>>({});
  // Sau "Show all": chuyển focus tới dòng con thứ 6 (dòng đầu tiên vừa hiện), vì nút "Show all" biến mất.
  const [focusPanel, setFocusPanel] = useState<string | null>(null);
  useEffect(() => {
    if (focusPanel === null) return;
    setFocusPanel(null);
    document
      .getElementById(focusPanel)
      ?.querySelector<HTMLElement>(":scope > li[data-first-more]")
      ?.focus();
  }, [focusPanel]);
  return {
    isOpen: (k: string) => open[k] === true,
    toggle: (k: string) => {
      setOpen((o) => ({ ...o, [k]: o[k] !== true }));
    },
    showsAll: (k: string) => all[k] === true,
    showAll: (k: string, panelId: string) => {
      setAll((a) => ({ ...a, [k]: true }));
      setFocusPanel(panelId);
    },
  };
}

export function DecisionsList({
  botId,
  events,
  why,
  ask,
  legacy,
}: {
  botId: string;
  /** Mới nhất trước, như API trả. */
  events: readonly BotEvent[];
  why: (e: BotEvent) => string | null;
  /** Nút "Ask about this" cạnh tên quyết định (không có ở bot paper). */
  ask?: (e: BotEvent, time: string) => ReactNode;
  /** Pill cho cột `result` dạng chữ cũ (event chưa gắn lệnh). */
  legacy: (text: string) => ReactNode;
}) {
  const t = useTranslations("agent");
  const tl = useTranslations("agent.decisionsList");
  const rows = groupDecisions(events);
  const open = useOpen();
  if (rows.length === 0)
    return (
      <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
        <strong className="text-[15px]">{t("noDecisions")}</strong>
        <span className="text-[13.5px] text-muted">{tl("emptyBody")}</span>
      </div>
    );
  const children = (r: Extract<DecisionRow, { kind: "group" }>) =>
    open.showsAll(r.key) ? r.events : r.events.slice(0, FIRST_CHILDREN);
  const range = (r: Extract<DecisionRow, { kind: "group" }>) => {
    const newest = r.events[0]?.occurredAt ?? "";
    const oldest = r.events.at(-1)?.occurredAt ?? "";
    return tl("range", { from: clock(oldest), to: clock(newest) });
  };
  return (
    <>
      {/* Desktop (artboard Main). */}
      <div className="hidden lg:flex lg:flex-col lg:gap-0">
        <div
          aria-hidden="true"
          className={`${GRID} rounded-control bg-surface-2 px-3 py-2.5 text-[12.5px] font-bold text-muted`}
        >
          <span>{t("cols.time")}</span>
          <span>{t("cols.decision")}</span>
          <span>{t("cols.why")}</span>
          <span>{t("cols.result")}</span>
        </div>
        <ol
          aria-label={t("decisions")}
          className="m-0 max-h-[900px] list-none overflow-y-auto p-0 tabular-nums"
        >
          {rows.map((r) =>
            r.kind === "single" ? (
              <li key={r.event.id} className="border-b border-border">
                <div className={`${GRID} items-center px-3 py-[13px] text-sm`}>
                  <span className="text-ink-2">{formatDateTime(r.event.occurredAt)}</span>
                  <span className="flex min-w-0 items-center gap-1">
                    <strong>{r.event.decision ?? r.event.type}</strong>
                    {ask?.(r.event, formatDateTime(r.event.occurredAt))}
                  </span>
                  <span className="leading-[1.45] text-ink-2">{why(r.event) ?? ""}</span>
                  <span>
                    <Result botId={botId} e={r.event} legacy={legacy} />
                  </span>
                </div>
              </li>
            ) : (
              <li key={r.key} className="border-b border-border">
                <button
                  type="button"
                  aria-expanded={open.isOpen(r.key)}
                  aria-controls={`grp-${r.key}`}
                  onClick={() => {
                    open.toggle(r.key);
                  }}
                  className={`${GRID} w-full cursor-pointer items-center border-0 px-3 py-[13px] text-left text-sm text-ink ${open.isOpen(r.key) ? "bg-surface-2" : "bg-transparent"}`}
                >
                  <span className="text-ink-2">{range(r)}</span>
                  <span className="flex items-center gap-2">
                    <Chevron open={open.isOpen(r.key)} />
                    <strong>{r.name}</strong>
                    <span className="rounded-[10px] bg-accent-tint px-[7px] py-px text-xs font-extrabold text-accent-ink">
                      {tl("count", { n: r.events.length })}
                    </span>
                  </span>
                  <span className="leading-[1.45] text-ink-2">
                    {r.events[0] === undefined ? "" : (why(r.events[0]) ?? "")}
                  </span>
                  <Summary events={r.events} />
                </button>
                {open.isOpen(r.key) ? (
                  <ol
                    id={`grp-${r.key}`}
                    aria-label={tl("groupPanel", { n: r.events.length, name: r.name })}
                    className="m-0 mb-2 list-none rounded-control bg-surface-2 p-0"
                  >
                    {children(r).map((c, i) => (
                      <li
                        key={c.id}
                        {...firstMore(i)}
                        className={`${GRID} items-center border-b border-border px-3 py-[9px] text-[13.5px]`}
                      >
                        <span className="pl-[22px] text-ink-2">{clock(c.occurredAt)}</span>
                        <span className="pl-[22px] text-ink-2">{r.name}</span>
                        <span className="text-ink-2">{why(c) ?? ""}</span>
                        <span>
                          <Result botId={botId} e={c} legacy={legacy} />
                        </span>
                      </li>
                    ))}
                    {open.showsAll(r.key) || r.events.length <= FIRST_CHILDREN ? null : (
                      <li className="pt-2 pr-3 pb-2.5 pl-[184px]">
                        <button
                          type="button"
                          onClick={() => {
                            open.showAll(r.key, `grp-${r.key}`);
                          }}
                          className="min-h-9 cursor-pointer rounded-[10px] border border-border-input bg-surface px-3 text-[13px] font-bold text-ink"
                        >
                          {tl("showAll", { n: r.events.length })}
                        </button>
                      </li>
                    )}
                  </ol>
                ) : null}
              </li>
            ),
          )}
        </ol>
      </div>

      {/* 390 px (artboard Mobile). */}
      <ol aria-label={t("recentDecisions")} className="m-0 list-none p-0 tabular-nums lg:hidden">
        {rows.slice(0, MOBILE_ROWS).map((r) =>
          r.kind === "single" ? (
            <li key={r.event.id} className="border-b border-border last:border-b-0">
              <div className="grid grid-cols-[48px_minmax(0,1fr)] gap-2.5 py-2.5">
                <span className="pt-0.5 text-xs text-muted">
                  {clock(r.event.occurredAt).slice(0, 5)}
                </span>
                <span className="flex min-w-0 flex-col items-start gap-1.5">
                  <span className="flex items-center gap-1">
                    <strong className="text-sm">{r.event.decision ?? r.event.type}</strong>
                    {ask?.(r.event, clock(r.event.occurredAt).slice(0, 5))}
                  </span>
                  {why(r.event) === null ? null : (
                    <span className="text-[12.5px] leading-[1.45] text-ink-2">{why(r.event)}</span>
                  )}
                  <Result botId={botId} e={r.event} size="lg" legacy={legacy} />
                </span>
              </div>
            </li>
          ) : (
            <li key={r.key} className="border-b border-border last:border-b-0">
              <button
                type="button"
                aria-expanded={open.isOpen(r.key)}
                aria-controls={`m-grp-${r.key}`}
                onClick={() => {
                  open.toggle(r.key);
                }}
                className="grid w-full cursor-pointer grid-cols-[48px_minmax(0,1fr)_20px] gap-2.5 border-0 bg-transparent py-2.5 text-left text-ink"
              >
                <span className="pt-0.5 text-xs text-muted">
                  {clock(r.events.at(-1)?.occurredAt ?? "").slice(0, 5)}
                </span>
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="flex items-center gap-1.5">
                    <strong className="text-sm">{r.name}</strong>
                    <span className="rounded-[10px] bg-accent-tint px-[7px] py-px text-xs font-extrabold text-accent-ink">
                      {tl("count", { n: r.events.length })}
                    </span>
                  </span>
                  <span className="text-xs text-muted">{range(r)}</span>
                  <Summary events={r.events} small />
                </span>
                <span className="mt-0.5">
                  <Chevron open={open.isOpen(r.key)} size={16} />
                </span>
              </button>
              {open.isOpen(r.key) ? (
                <ol
                  id={`m-grp-${r.key}`}
                  aria-label={tl("groupPanel", { n: r.events.length, name: r.name })}
                  className="m-0 mb-2.5 list-none rounded-[14px] bg-surface-2 px-2.5 py-1"
                >
                  {children(r).map((c, i) => (
                    <li
                      key={c.id}
                      {...firstMore(i)}
                      className="flex items-center gap-2.5 border-b border-border py-1"
                    >
                      <span className="flex-[0_0_64px] text-xs text-muted">
                        {clock(c.occurredAt)}
                      </span>
                      <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">
                        {why(c) ?? ""}
                      </span>
                      <Result botId={botId} e={c} size="lg" legacy={legacy} />
                    </li>
                  ))}
                  {open.showsAll(r.key) || r.events.length <= FIRST_CHILDREN ? null : (
                    <li className="py-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          open.showAll(r.key, `m-grp-${r.key}`);
                        }}
                        className="min-h-tap w-full cursor-pointer rounded-control border border-border-input bg-surface text-[13px] font-bold text-ink"
                      >
                        {tl("showAll", { n: r.events.length })}
                      </button>
                    </li>
                  )}
                </ol>
              ) : null}
            </li>
          ),
        )}
      </ol>
    </>
  );
}
