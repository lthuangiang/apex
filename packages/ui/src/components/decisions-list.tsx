import { useEffect, useState, type ReactNode } from "react";

// Trading Agent › Decisions & actions (BD-02, docs/mockups/bd02-decisions Main + Mobile; DEC-284, DEC-307), phần hiển
// thị: không chứa câu chữ (DEC-22). App truyền mọi chữ đã dịch / định dạng qua props, kể cả nhãn pill và nhãn nhóm;
// component chỉ lo bố cục desktop / 390 px, mở / thu nhóm, "Show all" và focus. Link do app dựng (`renderLink`, ví dụ
// `next/link`), mặc định là thẻ `<a>`.

/** Màu của pill kết quả, theo trạng thái lệnh. */
export type DecisionTone = "positive" | "accent" | "unknown" | "negative" | "neutral";

export interface DecisionPill {
  label: string;
  tone: DecisionTone;
  /** Có thì pill là link tới lệnh (kèm mũi tên). */
  href?: string;
  /** Tên đọc của link (ví dụ "Filled, show order ••a1b2"). */
  linkLabel?: string;
}

/** Cột Result: pill theo lệnh, nội dung app tự dựng (kết quả dạng chữ cũ), hoặc trống. */
export type DecisionResult = { pill: DecisionPill } | { node: ReactNode } | null;

export interface DecisionSingleRow {
  kind: "single";
  id: string;
  /** Giờ đầy đủ ở desktop và giờ ngắn ở 390 px (ví dụ "07:43"). */
  time: string;
  shortTime: string;
  name: string;
  why: string | null;
  result: DecisionResult;
  /** Nút cạnh tên quyết định (ví dụ "Ask about this"), riêng desktop / 390 px. */
  action?: ReactNode;
  mobileAction?: ReactNode;
}

export interface DecisionChildRow {
  id: string;
  time: string;
  /** Cột Decision của dòng con ở desktop (tên nhóm, hoặc "Try 3 · Post-only miss"). */
  label: string;
  why: string;
  /** Chữ của dòng con ở 390 px (why, hoặc "Try 3 · …"). */
  mobileText: string;
  result: DecisionResult;
}

export interface DecisionGroupRow {
  kind: "group";
  /** Khoá ổn định của nhóm (event cũ nhất): nhóm đang mở vẫn mở khi có event mới. */
  key: string;
  name: string;
  /** Nhãn cạnh tên: "×7" hoặc "8 tries in 2 min". */
  badge: string;
  /** "07:42:10 – 07:43:00". */
  range: string;
  /** Giờ ngắn của event cũ nhất (390 px). */
  shortTime: string;
  /** Cột Why ở desktop. */
  head: string;
  /** Dòng kết quả thêm ở 390 px (lượt vào lệnh); null = không có. */
  mobileHead: string | null;
  /** Pill tổng hợp, xấu nhất trước. */
  summary: readonly { label: string; tone: DecisionTone }[];
  /** Tên đọc của danh sách dòng con. */
  panelLabel: string;
  /** "Show all {n}". */
  showAllLabel: string;
  children: readonly DecisionChildRow[];
}

export type DecisionListRow = DecisionSingleRow | DecisionGroupRow;

export interface DecisionLinkProps {
  href: string;
  className: string;
  "aria-label"?: string;
  children: ReactNode;
}

export interface DecisionsListProps {
  /** Mới nhất trước. */
  rows: readonly DecisionListRow[];
  labels: {
    /** Tiêu đề cột desktop. */
    cols: { time: string; decision: string; why: string; result: string };
    /** Tên đọc của danh sách desktop / 390 px. */
    list: string;
    mobileList: string;
    emptyTitle: string;
    emptyBody: string;
  };
  renderLink?: (props: DecisionLinkProps) => ReactNode;
  /** Nhóm mở sẵn (khoá nhóm), cho story / test. */
  defaultOpen?: readonly string[];
}

const GRID = "grid grid-cols-[150px_240px_minmax(0,1fr)_230px] gap-3";
/** Số dòng con hiện trước khi bấm "Show all". */
export const DECISION_FIRST_CHILDREN = 5;
/** Mobile: số dòng (đơn hoặc nhóm) hiện. */
export const DECISION_MOBILE_ROWS = 10;
/** Dòng con thứ 6 nhận focus sau "Show all". */
const firstMore = (i: number) =>
  i === DECISION_FIRST_CHILDREN ? { tabIndex: -1, "data-first-more": "" } : {};

const TONE: Record<DecisionTone, string> = {
  positive: "bg-pos-bg text-pos",
  accent: "bg-accent-tint text-accent-ink",
  unknown: "bg-unknown-bg text-unknown",
  negative: "bg-neg-bg text-neg-ink",
  neutral: "bg-surface-2 text-ink-2 ring-1 ring-border ring-inset",
};

const PILL =
  "inline-flex items-center gap-[5px] rounded-full px-[11px] text-[12.5px] font-bold whitespace-nowrap no-underline";

const defaultLink = ({ children, ...props }: DecisionLinkProps) => <a {...props}>{children}</a>;

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

function Result({
  result,
  size = "md",
  renderLink,
}: {
  result: DecisionResult;
  size?: "sm" | "md" | "lg";
  renderLink: (props: DecisionLinkProps) => ReactNode;
}) {
  if (result === null) return null;
  if ("node" in result) return <>{result.node}</>;
  const { pill } = result;
  const h = size === "lg" ? "min-h-8 px-3" : size === "sm" ? "min-h-6" : "min-h-7";
  if (pill.href === undefined)
    return <span className={`${PILL} ${h} ${TONE[pill.tone]}`}>{pill.label}</span>;
  return renderLink({
    href: pill.href,
    ...(pill.linkLabel === undefined ? {} : { "aria-label": pill.linkLabel }),
    className: `${PILL} ${h} ${TONE[pill.tone]} hover:opacity-85`,
    children: (
      <>
        {pill.label}
        <Arrow />
      </>
    ),
  });
}

function Summary({ row, small = false }: { row: DecisionGroupRow; small?: boolean }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {row.summary.map((p) => (
        <span
          key={`${p.tone}:${p.label}`}
          className={`${PILL} ${small ? "min-h-[26px]" : "min-h-7"} ${TONE[p.tone]}`}
        >
          {p.label}
        </span>
      ))}
    </span>
  );
}

function useOpen(initial: readonly string[]) {
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initial.map((k) => [k, true])),
  );
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

const BADGE = "rounded-[10px] bg-accent-tint px-[7px] py-px text-xs font-extrabold text-accent-ink";

export function DecisionsList({
  rows,
  labels,
  renderLink = defaultLink,
  defaultOpen = [],
}: DecisionsListProps) {
  const open = useOpen(defaultOpen);
  if (rows.length === 0)
    return (
      <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
        <strong className="text-[15px]">{labels.emptyTitle}</strong>
        <span className="text-[13.5px] text-muted">{labels.emptyBody}</span>
      </div>
    );
  const children = (r: DecisionGroupRow) =>
    open.showsAll(r.key) ? r.children : r.children.slice(0, DECISION_FIRST_CHILDREN);
  const more = (r: DecisionGroupRow) =>
    !open.showsAll(r.key) && r.children.length > DECISION_FIRST_CHILDREN;
  // Một khối bọc luôn hiện: ở 390 px khối desktop bị ẩn, nên phần tử đầu tiên không được là khối đó.
  return (
    <div>
      {/* Desktop (artboard Main). */}
      <div className="hidden lg:flex lg:flex-col lg:gap-0">
        <div
          aria-hidden="true"
          className={`${GRID} rounded-control bg-surface-2 px-3 py-2.5 text-[12.5px] font-bold text-muted`}
        >
          <span>{labels.cols.time}</span>
          <span>{labels.cols.decision}</span>
          <span>{labels.cols.why}</span>
          <span>{labels.cols.result}</span>
        </div>
        <ol
          aria-label={labels.list}
          className="m-0 max-h-[900px] list-none overflow-y-auto p-0 tabular-nums"
        >
          {rows.map((r) =>
            r.kind === "single" ? (
              <li key={r.id} className="border-b border-border">
                <div className={`${GRID} items-center px-3 py-[13px] text-sm`}>
                  <span className="text-ink-2">{r.time}</span>
                  <span className="flex min-w-0 items-center gap-1">
                    <strong>{r.name}</strong>
                    {r.action}
                  </span>
                  <span className="leading-[1.45] text-ink-2">{r.why ?? ""}</span>
                  <span>
                    <Result result={r.result} renderLink={renderLink} />
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
                  <span className="text-ink-2">{r.range}</span>
                  <span className="flex items-center gap-2">
                    <Chevron open={open.isOpen(r.key)} />
                    <strong>{r.name}</strong>
                    <span className={BADGE}>{r.badge}</span>
                  </span>
                  <span className="leading-[1.45] text-ink-2">{r.head}</span>
                  <Summary row={r} />
                </button>
                {open.isOpen(r.key) ? (
                  <ol
                    id={`grp-${r.key}`}
                    aria-label={r.panelLabel}
                    className="m-0 mb-2 list-none rounded-control bg-surface-2 p-0"
                  >
                    {children(r).map((c, i) => (
                      <li
                        key={c.id}
                        {...firstMore(i)}
                        className={`${GRID} items-center border-b border-border px-3 py-[9px] text-[13.5px]`}
                      >
                        <span className="pl-[22px] text-ink-2">{c.time}</span>
                        <span className="pl-[22px] text-ink-2">{c.label}</span>
                        <span className="text-ink-2">{c.why}</span>
                        <span>
                          <Result result={c.result} renderLink={renderLink} />
                        </span>
                      </li>
                    ))}
                    {more(r) ? (
                      <li className="pt-2 pr-3 pb-2.5 pl-[184px]">
                        <button
                          type="button"
                          onClick={() => {
                            open.showAll(r.key, `grp-${r.key}`);
                          }}
                          className="min-h-9 cursor-pointer rounded-[10px] border border-border-input bg-surface px-3 text-[13px] font-bold text-ink"
                        >
                          {r.showAllLabel}
                        </button>
                      </li>
                    ) : null}
                  </ol>
                ) : null}
              </li>
            ),
          )}
        </ol>
      </div>

      {/* 390 px (artboard Mobile). */}
      <ol aria-label={labels.mobileList} className="m-0 list-none p-0 tabular-nums lg:hidden">
        {rows.slice(0, DECISION_MOBILE_ROWS).map((r) =>
          r.kind === "single" ? (
            <li key={r.id} className="border-b border-border last:border-b-0">
              <div className="grid grid-cols-[48px_minmax(0,1fr)] gap-2.5 py-2.5">
                <span className="pt-0.5 text-xs text-muted">{r.shortTime}</span>
                <span className="flex min-w-0 flex-col items-start gap-1.5">
                  <span className="flex items-center gap-1">
                    <strong className="text-sm">{r.name}</strong>
                    {r.mobileAction}
                  </span>
                  {r.why === null ? null : (
                    <span className="text-[12.5px] leading-[1.45] text-ink-2">{r.why}</span>
                  )}
                  <Result result={r.result} size="lg" renderLink={renderLink} />
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
                <span className="pt-0.5 text-xs text-muted">{r.shortTime}</span>
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="flex items-center gap-1.5">
                    <strong className="text-sm">{r.name}</strong>
                    <span className={BADGE}>{r.badge}</span>
                  </span>
                  <span className="text-xs text-muted">{r.range}</span>
                  {r.mobileHead === null ? null : (
                    <span className="text-[12.5px] text-ink-2">{r.mobileHead}</span>
                  )}
                  <Summary row={r} small />
                </span>
                <span className="mt-0.5">
                  <Chevron open={open.isOpen(r.key)} size={16} />
                </span>
              </button>
              {open.isOpen(r.key) ? (
                <ol
                  id={`m-grp-${r.key}`}
                  aria-label={r.panelLabel}
                  className="m-0 mb-2.5 list-none rounded-[14px] bg-surface-2 px-2.5 py-1"
                >
                  {children(r).map((c, i) => (
                    <li
                      key={c.id}
                      {...firstMore(i)}
                      className="flex items-center gap-2.5 border-b border-border py-1"
                    >
                      <span className="flex-[0_0_64px] text-xs text-muted">{c.time}</span>
                      <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">
                        {c.mobileText}
                      </span>
                      <Result result={c.result} size="lg" renderLink={renderLink} />
                    </li>
                  ))}
                  {more(r) ? (
                    <li className="py-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          open.showAll(r.key, `m-grp-${r.key}`);
                        }}
                        className="min-h-tap w-full cursor-pointer rounded-control border border-border-input bg-surface text-[13px] font-bold text-ink"
                      >
                        {r.showAllLabel}
                      </button>
                    </li>
                  ) : null}
                </ol>
              ) : null}
            </li>
          ),
        )}
      </ol>
    </div>
  );
}
