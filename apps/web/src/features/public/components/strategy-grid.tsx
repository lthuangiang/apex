"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { strategiesFor, type EngineFilter } from "../strategies";

const FILTERS: readonly EngineFilter[] = ["all", "spot", "perps"];

/** Lưới chiến lược có bộ lọc All / Spot / Perps (Landing, section Strategies). Câu chữ lấy từ createBot.strategies. */
export function StrategyGrid() {
  const t = useTranslations("landing.strategies");
  const ts = useTranslations("createBot.strategies");
  const [filter, setFilter] = useState<EngineFilter>("all");
  return (
    <>
      <div
        role="group"
        aria-label={t("filterLabel")}
        className="flex gap-1 self-start rounded-tile border border-border bg-surface p-1 md:self-end"
      >
        {FILTERS.map((f) => {
          const on = f === filter;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setFilter(f);
              }}
              className={`min-h-10 min-w-16 cursor-pointer rounded-control border-none px-3.5 text-sm font-bold ${on ? "bg-ink text-surface" : "bg-transparent text-ink-2"}`}
            >
              {t(`filters.${f}`)}
            </button>
          );
        })}
      </div>
      <ul className="m-0 grid w-full list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 p-0">
        {strategiesFor(filter).map((key) => (
          <li
            key={key}
            className="flex flex-col gap-3 rounded-[22px] border border-border bg-surface p-[22px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span
                aria-hidden="true"
                className="flex size-10 items-center justify-center rounded-control bg-accent-tint text-[13px] font-extrabold text-accent-ink"
              >
                {ts(`${key}.short`)}
              </span>
              <span className="rounded-full bg-cat-exec-bg px-2.5 py-1 text-xs font-bold text-ink-2">
                {ts(`${key}.engine`)}
              </span>
            </div>
            <h3 className="m-0 text-[17px] font-extrabold">{ts(`${key}.name`)}</h3>
            <p className="m-0 text-sm leading-normal text-ink-2">{ts(`${key}.what`)}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
