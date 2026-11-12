"use client";

import { dec, whatIfApplyViewSchema, whatIfViewSchema, type WhatIfView } from "@drift/shared";
import { Button, ErrorState, PnLValue, Skeleton } from "@drift/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";

import { optionValues } from "./needs-you-card";

// AI Desk B+ (artboard BP-WhatIf): 2–3 phương án với kết quả 7 ngày đã qua, "My pick" của Desk AI kèm lý do (câu mẫu
// từ luật chọn, chưa dùng LLM), Apply → version mới "AI suggested" qua luồng sửa bot hiện có. User bấm, AI không tự
// áp. Sau Apply giữ "Applying vN…" tới khi backend xác nhận (quy tắc 1.6): trang Trading Agent hiện tiến trình đó.

type Option = WhatIfView["options"][number];
type FixKey = "lower_leverage" | "tighter_stop" | "review_settings";

function useOptionWords() {
  const t = useTranslations("desk.compare");
  return {
    name: (o: Option) => t(`name.${o.key}` as "name.lower_leverage", optionValues(o)),
    what: (o: Option, keep: Option | undefined) => {
      const v = optionValues(o);
      if (o.key === "keep")
        return v.leverage !== "" && v.stop !== "" ? t("what.keep", v) : t("what.keepPlain");
      const base = keep === undefined ? v : optionValues(keep);
      return t(`what.${o.key}` as "what.lower_leverage", {
        leverage: o.key === "tighter_stop" ? base.leverage : v.leverage,
        stop: o.key === "lower_leverage" ? base.stop : v.stop,
      });
    },
  };
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-ink-2">{label}</span>
      <span className="font-semibold tabular-nums">{children}</span>
    </div>
  );
}

function OptionCard({
  o,
  keep,
  picked,
  selected,
  onSelect,
}: {
  o: Option;
  keep: Option | undefined;
  picked: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations("desk.compare");
  const words = useOptionWords();
  const na = t("notAvailable");
  const out = o.outcome;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={out === null}
      onClick={onSelect}
      className={`flex flex-col gap-2.5 rounded-[20px] bg-surface p-[18px] text-left disabled:opacity-60 ${
        selected ? "border-2 border-accent" : "border border-border"
      }`}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-base font-extrabold">{words.name(o)}</span>
        {picked ? (
          <span className="inline-flex h-6 items-center rounded-full bg-accent-tint px-2.5 text-xs font-extrabold text-accent-ink">
            ✦ {t("myPick")}
          </span>
        ) : null}
      </span>
      <span className="text-sm text-ink-2">{words.what(o, keep)}</span>
      <Metric label={t("metrics.net")}>
        <PnLValue value={out?.net ?? null} locale="en-US" missingLabel={na} suffix=" USDC" />
      </Metric>
      <Metric label={t("metrics.closed")}>{out?.closedBySodex ?? na}</Metric>
      <Metric label={t("metrics.worst")}>
        {out?.worstTrade == null ? na : `${formatMoney(out.worstTrade, true) ?? ""} USDC`}
      </Metric>
      <Metric label={t("metrics.margin")}>
        {out?.marginPerTrade == null ? na : `${formatMoney(out.marginPerTrade) ?? ""} USDC`}
      </Metric>
    </button>
  );
}

function why(
  t: ReturnType<typeof useTranslations<"desk.compare">>,
  w: WhatIfView,
  name: (o: Option) => string,
) {
  const pick = w.pick;
  if (pick === null) return null;
  const chosen = w.options.find((o) => o.key === pick.key);
  if (pick.reason === "better_result" && chosen?.outcome != null) {
    const keep = w.options.find((o) => o.key === "keep")?.outcome;
    if (keep == null) return null;
    const diff = formatMoney(dec(chosen.outcome.net).sub(keep.net).toString()) ?? "";
    return t("why.better_result", { name: name(chosen), diff });
  }
  if (pick.reason === "safer_best_result" && chosen !== undefined)
    return t("why.safer_best_result", { name: name(chosen) });
  return t(`why.${pick.reason}` as "why.keep_is_better");
}

function applyError(t: ReturnType<typeof useTranslations<"desk.compare">>, err: unknown) {
  const reason =
    err instanceof ApiError && typeof err.details.reason === "string" ? err.details.reason : "";
  return ["applied", "version_changed", "not_done", "no_result"].includes(reason)
    ? t(`errors.${reason}` as "errors.applied")
    : t("errors.generic");
}

export function ComparePage({ id }: { id: string }) {
  const t = useTranslations("desk.compare");
  const tw = useTranslations("desk.whatif");
  const te = useTranslations("common.errors");
  const words = useOptionWords();
  const q = useQuery({
    queryKey: ["desk", "whatif", id],
    queryFn: () => api("GET", `/api/v1/desk/whatifs/${id}`, whatIfViewSchema),
    refetchInterval: (s) =>
      s.state.data?.status === "queued" || s.state.data?.status === "running" ? 3000 : false,
  });
  const w = q.data;
  const [selected, setSelected] = useState<Option["key"] | null>(null);
  useEffect(() => {
    if (selected === null && w?.pick?.key != null) setSelected(w.pick.key);
  }, [selected, w?.pick?.key]);
  const key = useRef(crypto.randomUUID());
  const apply = useMutation({
    mutationFn: (option: FixKey) =>
      api("POST", `/api/v1/desk/whatifs/${id}/apply`, whatIfApplyViewSchema, {
        idempotencyKey: key.current,
        body: { option },
      }),
  });

  const back = { href: "/desk", label: t("back") };
  const keep = w?.options.find((o) => o.key === "keep");
  const current = w?.options.find((o) => o.key === selected);
  const entries = keep?.outcome?.trades ?? null;
  const reason = w === undefined ? null : why(t, w, words.name);
  const running = w?.status === "queued" || w?.status === "running";

  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <Link
          href="/desk"
          className="hidden self-start text-sm font-bold text-accent-ink lg:inline"
        >
          ← {t("back")}
        </Link>
        <PageHead title={w?.bot.name ?? t("title")} subtitle={t("title")} back={back} />
        {q.isPending ? (
          <Skeleton className="h-64 w-full rounded-card" />
        ) : q.isError || w === undefined ? (
          <ErrorState
            title={t("errors.generic")}
            retryLabel={te("retry")}
            onRetry={() => void q.refetch()}
          />
        ) : running ? (
          <p className="m-0 text-sm text-ink-2" aria-live="polite">
            {tw("running")}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <h2 className="m-0 text-lg font-extrabold">{t("title")}</h2>
              <p className="m-0 text-sm text-ink-2">
                {w.source === "backtest" ? t("introBacktest") : t("introReplay")}
              </p>
            </div>
            <div role="radiogroup" aria-label={t("title")} className="grid gap-3 md:grid-cols-3">
              {w.options.map((o) => (
                <OptionCard
                  key={o.key}
                  o={o}
                  keep={keep}
                  picked={w.pick?.key === o.key}
                  selected={selected === o.key}
                  onSelect={() => {
                    setSelected(o.key);
                  }}
                />
              ))}
            </div>
            {reason === null ? null : (
              <p className="m-0 flex gap-2 rounded-[16px] bg-accent-tint p-4 text-sm text-accent-ink">
                <span aria-hidden="true">✦</span>
                {reason}
              </p>
            )}
            <p className="m-0 text-xs text-muted">
              {w.source === "backtest"
                ? t("footBacktest")
                : entries === null
                  ? null
                  : t("footReplay", { count: entries })}
            </p>
            <ApplyBar
              w={w}
              option={current ?? null}
              name={current === undefined ? "" : words.name(current)}
              pending={apply.isPending}
              done={apply.data ?? null}
              error={apply.isError ? applyError(t, apply.error) : null}
              onApply={(k) => {
                apply.mutate(k);
              }}
            />
          </>
        )}
      </div>
    </Workspace>
  );
}

function ApplyBar({
  w,
  option,
  name,
  pending,
  done,
  error,
  onApply,
}: {
  w: WhatIfView;
  option: Option | null;
  name: string;
  pending: boolean;
  done: { botId: string; version: number; status: "pending" | "active" } | null;
  error: string | null;
  onApply: (k: FixKey) => void;
}) {
  const t = useTranslations("desk.compare");
  const isKeep = option === null || option.key === "keep";
  if (done !== null)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4">
        <p className="m-0 text-sm font-bold" aria-live="polite">
          {done.status === "pending"
            ? t("applying", { version: done.version })
            : t("applied", { version: done.version })}
        </p>
        <Link href={`/agent/${done.botId}`} className="text-sm font-bold text-accent-ink">
          {t("openBot")}
        </Link>
      </div>
    );
  const running = w.bot.state === "running";
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 text-sm font-extrabold">
          {isKeep ? t("noChange") : t("applyTitle", { name })}
        </p>
        {isKeep ? null : (
          <p className="m-0 text-sm text-ink-2">
            {running ? t("applyBody") : t("applyBodyStopped")}
          </p>
        )}
        {error === null ? null : (
          <p role="alert" className="m-0 text-sm text-neg-ink">
            {error}
          </p>
        )}
      </div>
      <Button
        disabled={isKeep || option.outcome === null}
        pending={pending}
        onClick={() => {
          if (option !== null && option.key !== "keep") onApply(option.key);
        }}
      >
        {isKeep ? t("nothingToApply") : t("apply")}
      </Button>
    </div>
  );
}
