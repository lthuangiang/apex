import { cx } from "../lib/cx";
import type { Timestamp } from "../lib/data-state";

import { DataRegion, type DataRegionProps } from "./data-region";

export type ActivityTone = "neutral" | "pos" | "neg" | "warn" | "unknown";

export interface ActivityItem {
  id: string;
  at: Timestamp;
  title: string;
  description?: string;
  tone?: ActivityTone;
  /** Nhãn chữ của tone (ví dụ "Rejected"), để không chỉ thể hiện bằng màu. */
  toneLabel?: string;
}

export interface ActivityTimelineProps extends Omit<DataRegionProps, "children" | "loading"> {
  items: readonly ActivityItem[];
}

const DOT: Record<ActivityTone, string> = {
  neutral: "bg-muted",
  pos: "bg-pos-dot",
  neg: "bg-neg",
  warn: "bg-warn-bar",
  unknown: "bg-unknown",
};

const LABEL: Record<ActivityTone, string> = {
  neutral: "bg-surface-2 text-ink-2",
  pos: "bg-pos-bg text-pos",
  neg: "bg-neg-bg text-neg-ink",
  warn: "bg-warn-bg text-warn",
  unknown: "bg-unknown-bg text-unknown",
};

export function ActivityTimeline({ items, ...region }: ActivityTimelineProps) {
  return (
    <DataRegion {...region}>
      <ol className="flex flex-col">
        {items.map((item) => {
          const tone = item.tone ?? "neutral";
          return (
            <li key={item.id} className="relative flex gap-3 pb-4 last:pb-0">
              <span
                aria-hidden="true"
                className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", DOT[tone])}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-ink">{item.title}</p>
                  {item.toneLabel ? (
                    <span
                      className={cx(
                        "rounded-full px-2 py-0.5 text-[12px] font-semibold",
                        LABEL[tone],
                      )}
                    >
                      {item.toneLabel}
                    </span>
                  ) : null}
                </div>
                {item.description ? (
                  <p className="break-words text-sm text-ink-2">{item.description}</p>
                ) : null}
                <time dateTime={item.at.dateTime} className="text-xs text-muted">
                  {item.at.text}
                </time>
              </div>
            </li>
          );
        })}
      </ol>
    </DataRegion>
  );
}
