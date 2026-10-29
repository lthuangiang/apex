"use client";

import { dec, type OverviewView, type WatchlistEntry } from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { ChevronDown, ChevronUp, GripVertical, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { MarketPicker } from "@/features/bots/components/market-picker";
import { formatAmount } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useSaveWatchlist } from "@/lib/watchlist";
import { add, isFull, move, remove, reorder } from "@/lib/watchlist-list";

import { Sparkline } from "./charts";

// Thẻ Watchlist của Overview (UI_REVIEW M2, DEC-74). Chưa có artboard cho chế độ sửa: làm theo mô tả M2,
// dùng component sẵn có. Giá: perps là mark price, spot là giá gần nhất; thiếu thì "Not available".

type Row = OverviewView["watchlist"][number];

const CHIP = "rounded-full px-1.5 py-px text-[10px] font-extrabold tracking-[0.04em] uppercase";
const ENGINE_CHIP = { spot: "bg-accent-tint text-accent-ink", perps: "bg-unknown-bg text-unknown" };
const ICON_BTN =
  "flex size-tap flex-none items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-muted";

export function WatchlistCard({ rows, loading }: { rows: Row[] | undefined; loading: boolean }) {
  const t = useTranslations("overview.watchlistCard");
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const headId = useId();
  const start = (withAdd: boolean) => {
    setEditing(true);
    setAdding(withAdd);
  };
  return (
    <section
      aria-labelledby={headId}
      className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 rounded-card border border-border bg-surface p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={headId} className="m-0 text-lg font-extrabold">
          {t("title")}
        </h2>
        {editing || loading || rows === undefined ? null : (
          <button
            type="button"
            aria-label={t("edit")}
            className={ICON_BTN}
            onClick={() => {
              start(false);
            }}
          >
            <Pencil aria-hidden="true" size={16} />
          </button>
        )}
      </div>
      <span className="-mt-2 text-xs text-muted">{t("note")}</span>
      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : editing && rows !== undefined ? (
        <EditList
          initial={rows.map((r) => ({ market: r.market, engine: r.engine }))}
          adding={adding}
          setAdding={setAdding}
          done={() => {
            setEditing(false);
            setAdding(false);
          }}
        />
      ) : rows === undefined ? (
        <p className="m-0 text-sm text-ink-2">{t("notAvailable")}</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="m-0 text-sm text-ink-2">{t("empty")}</p>
          <Button
            variant="tonal"
            onClick={() => {
              start(true);
            }}
          >
            {t("addMarket")}
          </Button>
        </div>
      ) : (
        <ViewList rows={rows} />
      )}
    </section>
  );
}

function EngineChip({ engine }: { engine: "spot" | "perps" }) {
  const t = useTranslations("overview.watchlistCard");
  return <span className={`${CHIP} ${ENGINE_CHIP[engine]}`}>{t(`engine.${engine}`)}</span>;
}

function ViewList({ rows }: { rows: Row[] }) {
  const t = useTranslations("overview.watchlistCard");
  const names = useMarketNames();
  const save = useSaveWatchlist();
  const [menu, setMenu] = useState<string | null>(null);
  const wrap = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (menu === null) return;
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || wrap.current?.contains(e.target) !== true) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);
  const entries = rows.map((r) => ({ market: r.market, engine: r.engine }));
  return (
    <>
      <ul ref={wrap} className="m-0 flex list-none flex-col p-0 text-sm tabular-nums">
        {rows.map((w) => {
          const up = w.change24hPct === null ? true : dec(w.change24hPct).gte(0);
          const info = names.info(w.market);
          const base = info?.base ?? w.market.split(/[-_]/)[0] ?? w.market;
          const label = names.market(w.market);
          const price = formatAmount(w.price, names.priceDigits(w.market))?.text;
          const query = new URLSearchParams({ tab: "catalog", market: w.market, engine: w.engine });
          return (
            <li key={w.market} className="relative border-b border-border last:border-b-0">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menu === w.market}
                aria-label={t("rowMenu", { market: label })}
                className="flex w-full items-center gap-3 py-3 text-left hover:bg-surface-2"
                onClick={() => {
                  setMenu((m) => (m === w.market ? null : w.market));
                }}
              >
                <span
                  aria-hidden="true"
                  className="flex size-[38px] flex-none items-center justify-center rounded-full bg-accent-tint text-[13px] font-extrabold text-accent-ink"
                >
                  {names.asset(base).slice(0, 1)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[15px] font-bold">{names.asset(base)}</span>
                    <span className="flex-none">
                      <EngineChip engine={w.engine} />
                    </span>
                  </span>
                  <span className="text-xs text-muted">{label}</span>
                </span>
                {/* Màn hẹp (< 400 px) bỏ sparkline để tên coin không bị cắt thành "B…". */}
                <span className="hidden flex-none min-[400px]:block">
                  <Sparkline values={w.spark.map(Number)} up={up} />
                </span>
                <span className="flex w-24 flex-col items-end">
                  {price === undefined ? (
                    <span className="text-xs text-muted">{t("notAvailable")}</span>
                  ) : (
                    <span className="text-[15px] font-bold">{price}</span>
                  )}
                  {w.change24hPct === null ? null : (
                    <span className={`text-xs font-bold ${up ? "text-pos" : "text-neg-ink"}`}>
                      {up ? "▲" : "▼"} {dec(w.change24hPct).abs().toFixed(2)}%
                    </span>
                  )}
                </span>
              </button>
              {menu === w.market ? (
                <div
                  role="menu"
                  aria-label={t("rowMenu", { market: label })}
                  className="absolute top-full right-0 z-20 flex min-w-48 flex-col rounded-control border border-border bg-surface p-1 shadow-float"
                >
                  <Link
                    role="menuitem"
                    href={`/bots?${query.toString()}`}
                    className="flex min-h-tap items-center rounded-[10px] px-3 text-sm font-bold text-ink no-underline hover:bg-surface-2"
                  >
                    {t("newBot", { market: label })}
                  </Link>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={save.isPending}
                    className="flex min-h-tap items-center rounded-[10px] px-3 text-left text-sm font-bold text-neg-ink hover:bg-surface-2"
                    onClick={() => {
                      save.mutate(remove(entries, w.market), {
                        onSettled: () => {
                          setMenu(null);
                        },
                      });
                    }}
                  >
                    {save.isPending ? t("saving") : t("removeItem")}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {save.isError ? (
        <p role="alert" className="m-0 text-sm text-neg-ink">
          {t("saveFailed")}
        </p>
      ) : null}
    </>
  );
}

function EditList({
  initial,
  adding,
  setAdding,
  done,
}: {
  initial: WatchlistEntry[];
  adding: boolean;
  setAdding: (v: boolean) => void;
  done: () => void;
}) {
  const t = useTranslations("overview.watchlistCard");
  const names = useMarketNames();
  const save = useSaveWatchlist();
  const [list, setList] = useState(initial);
  const [engine, setEngine] = useState<"spot" | "perps">("perps");
  const [drag, setDrag] = useState<number | null>(null);
  const pickId = useId();
  const full = isFull(list);
  return (
    <div className="flex flex-col gap-3">
      {list.length === 0 ? <p className="m-0 text-sm text-ink-2">{t("empty")}</p> : null}
      <ol className="m-0 flex list-none flex-col p-0 text-sm">
        {list.map((w, i) => {
          const label = names.market(w.market);
          return (
            // Kéo thả chỉ là cách phụ; bàn phím dùng nút ▲ ▼ (UI_REVIEW M2).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
            <li
              key={w.market}
              draggable
              onDragStart={() => {
                setDrag(i);
              }}
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={() => {
                if (drag !== null) setList(reorder(list, drag, i));
                setDrag(null);
              }}
              className={`flex items-center gap-1 border-b border-border py-1 last:border-b-0 ${drag === i ? "opacity-60" : ""}`}
            >
              <GripVertical
                aria-hidden="true"
                size={16}
                className="flex-none cursor-grab text-muted"
              />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate font-bold">{label}</span>
                <EngineChip engine={w.engine} />
              </span>
              <button
                type="button"
                aria-label={t("moveUp", { market: label })}
                disabled={i === 0}
                className={ICON_BTN}
                onClick={() => {
                  setList(move(list, i, -1));
                }}
              >
                <ChevronUp aria-hidden="true" size={16} />
              </button>
              <button
                type="button"
                aria-label={t("moveDown", { market: label })}
                disabled={i === list.length - 1}
                className={ICON_BTN}
                onClick={() => {
                  setList(move(list, i, 1));
                }}
              >
                <ChevronDown aria-hidden="true" size={16} />
              </button>
              <button
                type="button"
                aria-label={t("remove", { market: label })}
                className={ICON_BTN}
                onClick={() => {
                  setList(remove(list, w.market));
                }}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </li>
          );
        })}
      </ol>
      {adding && !full ? (
        <div className="flex flex-col gap-2 rounded-control bg-surface-2 p-3">
          <div role="radiogroup" aria-label={t("engineLabel")} className="flex gap-2">
            {(["perps", "spot"] as const).map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={engine === e}
                className={`min-h-tap rounded-control px-3 text-sm font-bold ${engine === e ? "bg-accent text-white" : "border border-border-input bg-surface text-ink"}`}
                onClick={() => {
                  setEngine(e);
                }}
              >
                {t(`engine.${e}`)}
              </button>
            ))}
          </div>
          <label htmlFor={pickId} className="text-xs font-bold text-ink-2">
            {t("pickLabel")}
          </label>
          <MarketPicker
            engine={engine}
            value=""
            watch={false}
            added={new Set(list.map((x) => x.market))}
            onChange={(m) => {
              if (m !== "") setList(add(list, { market: m, engine }));
            }}
            inputProps={{ id: pickId }}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="tonal"
            disabled={full}
            onClick={() => {
              setAdding(true);
            }}
          >
            {t("addMarketPlus")}
          </Button>
          {full ? <span className="text-xs text-muted">{t("max")}</span> : null}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={save.isPending} onClick={done}>
          {t("cancel")}
        </Button>
        <Button
          pending={save.isPending}
          onClick={() => {
            save.mutate(list, { onSuccess: done });
          }}
        >
          {save.isPending ? t("saving") : t("save")}
        </Button>
      </div>
      {save.isError ? (
        <p role="alert" className="m-0 text-sm text-neg-ink">
          {t("saveFailed")}
        </p>
      ) : null}
    </div>
  );
}
