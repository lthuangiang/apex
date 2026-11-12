"use client";

import { dec, type TraderCard as Card } from "@drift/shared";
import { Button } from "@drift/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { useFollow } from "../api";
import { addr, holdText, initials, pctText, usd } from "../format";

// Thành phần dùng chung của Copy Trading (artboard Leaders, WalletStats, CopyBot, CopyReview).

/** Đường lợi nhuận cộng dồn theo ngày (SVG thuần, không thư viện). Ít hơn 2 điểm thì không vẽ. */
export function Sparkline({
  points,
  className = "h-12 w-full",
  label,
}: {
  points: readonly (readonly [number, string])[];
  className?: string;
  label: string;
}) {
  if (points.length < 2) return null;
  const ys = points.map(([, v]) => Number(v));
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const span = max - min || 1;
  const w = 100;
  const h = 32;
  const path = ys
    .map(
      (y, i) =>
        `${((i / (ys.length - 1)) * w).toFixed(2)},${(h - ((y - min) / span) * h).toFixed(2)}`,
    )
    .join(" ");
  const up = (ys.at(-1) ?? 0) >= 0;
  return (
    <svg
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label={label}
    >
      <polyline
        points={path}
        fill="none"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
        className={up ? "stroke-pos" : "stroke-neg"}
      />
    </svg>
  );
}

export function TagChips({ card }: { card: Card }) {
  const t = useTranslations("copy.tags");
  const good = new Set(["easy_to_copy", "holds_hours", "holds_days"]);
  const warn = new Set(["fast_trader", "partly_on_sodex", "history_incomplete", "liquidated"]);
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
      {card.tags.map((tag) => (
        <li
          key={tag}
          className={`inline-flex h-[26px] items-center rounded-full px-2.5 text-xs font-bold ${
            good.has(tag)
              ? "bg-pos-bg text-pos"
              : warn.has(tag)
                ? "bg-warn-bg text-warn"
                : "bg-accent-tint text-accent-ink"
          }`}
        >
          {tag === "partly_on_sodex" ? t(tag, { pct: pctText(card.stats.coverage) ?? "" }) : t(tag)}
        </li>
      ))}
    </ul>
  );
}

/** Ô hai chữ đầu theo địa chỉ. */
export function Avatar({ address }: { address: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-11 flex-none items-center justify-center rounded-[14px] bg-accent-tint text-sm font-extrabold text-accent-ink"
    >
      {initials(address)}
    </span>
  );
}

/** Nút Copy hoặc "Follow · copy later" khi hết chỗ copy realtime (DEC-163 mục 10). */
export function CopyAction({ card, label }: { card: Card; label: string }) {
  const t = useTranslations("copy.common");
  const follow = useFollow();
  if (card.slot === "full")
    return (
      <Button
        variant="tonal"
        disabled={card.following || follow.isPending}
        onClick={() => {
          follow.mutate({ address: card.address, on: true });
        }}
      >
        {card.following ? t("following") : t("copyLater")}
      </Button>
    );
  return (
    <Link
      href={`/bots/new/copy_trade?leader=${card.address}`}
      className="inline-flex min-h-tap items-center justify-center rounded-control bg-accent px-4 text-sm font-bold text-white"
    >
      {label}
    </Link>
  );
}

export function TraderCardView({ card }: { card: Card }) {
  const t = useTranslations("copy");
  const s = card.stats;
  const profit = usd(s.profit, true);
  const up = !dec(s.profit).isNegative();
  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-5">
      <header className="flex items-center gap-3">
        <Avatar address={card.address} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-extrabold tabular-nums">
            {card.displayName ?? addr(card.address)}
          </span>
          <span className="text-xs text-muted">
            {t("common.closedTrades", { n: s.closedTrades })}
          </span>
        </div>
      </header>
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-xs font-semibold text-ink-2">{t("list.profit")}</span>
          <span className={`text-2xl font-extrabold tabular-nums ${up ? "text-pos" : "text-neg"}`}>
            {profit} {up ? "▲" : "▼"}
          </span>
        </div>
        <div className="w-28">
          <Sparkline points={card.curve} label={t("profile.curveTitle")} />
        </div>
      </div>
      <dl className="m-0 grid grid-cols-3 gap-2 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted">{t("list.worstDip")}</dt>
          <dd className="m-0 font-bold tabular-nums">
            {usd(s.worstDip === "0" ? "0" : `-${s.worstDip}`)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted">{t("list.typicalHold")}</dt>
          <dd className="m-0 font-bold tabular-nums">
            {holdText(s.typicalHoldMs) ?? t("common.notEnough")}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted">{t("list.winRate")}</dt>
          <dd className="m-0 font-bold tabular-nums">
            {pctText(s.winRate) ?? t("common.notEnough")}
          </dd>
        </div>
      </dl>
      <TagChips card={card} />
      <div className="mt-auto flex flex-wrap gap-2">
        <Link
          href={`/traders/${card.address}`}
          className="inline-flex min-h-tap items-center justify-center rounded-control border border-border px-4 text-sm font-bold text-ink"
        >
          {t("common.viewProfile")}
        </Link>
        <CopyAction card={card} label={t("common.copy")} />
      </div>
    </article>
  );
}

/** Thanh bước của luồng copy (artboard CopyBot / CopyReview). */
export function CopySteps({ at }: { at: "budget" | "review" }) {
  const t = useTranslations("copy.steps");
  const steps = [
    { key: "trader", done: true },
    { key: "budget", done: at === "review" },
    { key: "review", done: false },
  ] as const;
  return (
    <ol className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm">
      {steps.map((s) => {
        const current = s.key === at;
        return (
          <li
            key={s.key}
            aria-current={current ? "step" : undefined}
            className={`inline-flex h-8 items-center rounded-full px-3 font-bold ${
              current
                ? "bg-ink text-white"
                : s.done
                  ? "bg-pos-bg text-pos"
                  : "bg-surface-2 text-ink-2"
            }`}
          >
            {s.done ? "✓ " : ""}
            {t(s.key)}
          </li>
        );
      })}
    </ol>
  );
}
