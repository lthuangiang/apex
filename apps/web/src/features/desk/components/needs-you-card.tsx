"use client";

import { whatIfViewSchema, type DeskHomeView, type WhatIfView } from "@drift/shared";
import { Button, PnLValue } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { z } from "zod";

import { api } from "@/lib/api";

import { optionValues, plainNumber, plainUsd, shownFix } from "../bplus";

// AI Desk B+ (artboard BP-Home): một việc "Needs you" = vấn đề bằng lời thường (từ fact của quy tắc) + what-if 7 ngày
// ("Last 7 days, as it is" so với phương án Desk AI chọn) + nút chính. Chưa có so sánh thì bấm Compare thay user: chỉ
// tính trên dữ liệu cũ, không đổi bot. Không có số thì không hiện 0 (quy tắc 1.8).

type Item = DeskHomeView["items"][number];

const factOf = (item: Item, name: string): string | null =>
  item.facts.find((f) => f.name === name)?.value ?? null;

const snoozeSchema = z.object({ id: z.string(), snoozedUntil: z.string() });

function useWhatif(item: Item, checkedAt: string) {
  const qc = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const start = useMutation({
    mutationFn: () =>
      api("POST", `/api/v1/desk/needs-you/${item.id}/whatif`, whatIfViewSchema, {
        idempotencyKey: key.current,
      }),
    // Lần bấm sau là một yêu cầu mới (khoá cũ trả lại đúng phản hồi cũ đã lưu).
    onSettled: () => {
      key.current = crypto.randomUUID();
    },
  });
  const { mutate } = start;
  // Tự bấm Compare thay user tối đa MỘT lần cho mỗi lần trang chủ tải (`checkedAt`) khi chưa có so sánh hợp lệ. Không
  // phụ thuộc trạng thái của lần bấm (isPending / isError), nếu không mỗi lần xong lại bấm tiếp thành vòng lặp. Đã lỗi
  // một lần (ví dụ 429) thì thôi tự bấm: thẻ hiện lỗi và nút bấm tay.
  const askedFor = useRef<string | null>(null);
  const gaveUp = useRef(false);
  useEffect(() => {
    if (item.whatif !== null || gaveUp.current || askedFor.current === checkedAt) return;
    askedFor.current = checkedAt;
    mutate(undefined, {
      onError: () => {
        gaveUp.current = true;
      },
    });
  }, [item.whatif, checkedAt, mutate]);
  const id = item.whatif?.id ?? start.data?.id;
  const poll = useQuery({
    queryKey: ["desk", "whatif", id],
    queryFn: () => api("GET", `/api/v1/desk/whatifs/${id ?? ""}`, whatIfViewSchema),
    enabled: id !== undefined,
    initialData: item.whatif ?? start.data,
    refetchInterval: (q) =>
      q.state.data?.status === "queued" || q.state.data?.status === "running" ? 3000 : false,
  });
  useEffect(() => {
    if (poll.data?.status === "done") void qc.invalidateQueries({ queryKey: ["desk", "home"] });
  }, [poll.data?.status, qc]);
  return {
    w: poll.data ?? null,
    failed: start.isError || poll.isError,
    pending: start.isPending,
    /** Bấm tay sau khi lỗi: một yêu cầu, không tự thử lại. */
    retry: () => {
      mutate();
    },
  };
}

function Problem({ item }: { item: Item }) {
  const t = useTranslations("desk.rules");
  const r = item.rule;
  const tag = t("tag", { tag: t(`${r}.tag`), bot: item.botName });
  let title: string;
  let body: string | null = null;
  if (r === "liquidation_before_stop") {
    title = t("liquidation_before_stop.title");
    const [leverage, liq, stop] = [
      factOf(item, "leverage"),
      factOf(item, "liquidationDistancePct"),
      factOf(item, "stopDistancePct"),
    ];
    if (leverage !== null && liq !== null && stop !== null)
      body = t("liquidation_before_stop.body", {
        leverage: plainNumber(leverage),
        liq: plainNumber(liq),
        stop: plainNumber(stop),
      });
  } else if (r === "max_loss_hit") {
    const maxLoss = factOf(item, "maxLoss");
    title =
      maxLoss === null
        ? t("max_loss_hit.titleNoLimit")
        : t("max_loss_hit.title", { maxLoss: plainUsd(maxLoss) });
    const [net, fees] = [factOf(item, "net"), factOf(item, "fees")];
    if (net !== null && fees !== null && net.startsWith("-"))
      body = t("max_loss_hit.body", { net: plainUsd(net), fees: plainUsd(fees) });
  } else if (r === "taker_costly") {
    const share = factOf(item, "takerSharePct");
    title = t("taker_costly.title", { share: share === null ? "" : plainNumber(share) });
    const [taker, maker] = [
      factOf(item, "takerCostPerMillion"),
      factOf(item, "makerCostPerMillion"),
    ];
    if (taker !== null && maker !== null)
      body = t("taker_costly.body", { taker: plainUsd(taker), maker: plainUsd(maker) });
  } else {
    title = t("better_review.title");
    const [best, current] = [
      factOf(item, "bestCostPerMillion"),
      factOf(item, "currentCostPerMillion"),
    ];
    if (best !== null && current !== null)
      body = t("better_review.body", { best: plainUsd(best), current: plainUsd(current) });
  }
  return (
    <div className="flex flex-col gap-1">
      <span
        className={`text-xs font-extrabold ${item.severity >= 3 ? "text-neg-ink" : "text-warn"}`}
      >
        {tag}
      </span>
      <h3 className="m-0 text-base font-extrabold">{title}</h3>
      {body === null ? null : <p className="m-0 text-sm text-ink-2">{body}</p>}
    </div>
  );
}

function WhatIfRows({
  w,
  failed,
  pending,
  retry,
}: {
  w: WhatIfView | null;
  failed: boolean;
  pending: boolean;
  retry: () => void;
}) {
  const t = useTranslations("desk.whatif");
  const tm = useTranslations("desk.compare");
  if (failed || w?.status === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-sm text-ink-2">
          {t("failed")}
        </p>
        <Button variant="secondary" pending={pending} onClick={retry}>
          {t("retry")}
        </Button>
      </div>
    );
  if (w === null || w.status === "queued" || w.status === "running")
    return (
      <p className="m-0 text-sm text-ink-2" aria-live="polite">
        {t("running")}
      </p>
    );
  if (w.status === "unavailable")
    return (
      <p className="m-0 text-sm text-ink-2">{w.error === "no_fix" ? t("noFix") : t("failed")}</p>
    );
  const keep = w.options.find((o) => o.key === "keep")?.outcome ?? null;
  const fix = shownFix(w);
  if (keep === null || fix?.outcome == null)
    return <p className="m-0 text-sm text-ink-2">{t("notEnough")}</p>;
  const row = (label: string, net: string, closed: number | null) => (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[12px] bg-surface-2 px-3 py-2">
      <span className="text-sm text-ink-2">{label}</span>
      <span className="flex items-center gap-3 text-sm">
        <PnLValue value={net} locale="en-US" missingLabel={tm("notAvailable")} suffix=" USDC" />
        {closed === null ? null : (
          <span className="text-ink-2">{t("closed", { count: closed })}</span>
        )}
      </span>
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      {row(t("asIs"), keep.net, keep.closedBySodex)}
      {row(
        t(fix.key as "lower_leverage", optionValues(fix)),
        fix.outcome.net,
        fix.outcome.closedBySodex,
      )}
    </div>
  );
}

export function NeedsYouCard({ item, checkedAt }: { item: Item; checkedAt: string }) {
  const t = useTranslations("desk.whatif");
  const qc = useQueryClient();
  const { w, failed, pending, retry } = useWhatif(item, checkedAt);
  const later = useRef(crypto.randomUUID());
  const snooze = useMutation({
    mutationFn: () =>
      api("POST", `/api/v1/desk/needs-you/${item.id}/later`, snoozeSchema, {
        idempotencyKey: later.current,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["desk", "home"] }),
  });
  const fixes = w?.status === "done" ? w.options.filter((o) => o.outcome !== null).length : 0;
  return (
    <article
      aria-label={item.botName}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5"
    >
      <Problem item={item} />
      <WhatIfRows w={w} failed={failed} pending={pending} retry={retry} />
      <div className="flex flex-wrap items-center gap-2">
        {w !== null && fixes >= 2 ? (
          <Link
            href={`/desk/compare/${w.id}`}
            className="inline-flex min-h-tap items-center rounded-[12px] bg-accent px-4 text-sm font-bold text-white hover:bg-accent-ink"
          >
            {t("compare", { count: w.options.length })}
          </Link>
        ) : w?.status === "unavailable" ? (
          <Link
            href={`/bots/${item.botId}/edit`}
            className="inline-flex min-h-tap items-center rounded-[12px] bg-accent px-4 text-sm font-bold text-white hover:bg-accent-ink"
          >
            {t("review")}
          </Link>
        ) : null}
        <Button
          variant="secondary"
          pending={snooze.isPending}
          onClick={() => {
            snooze.mutate();
          }}
        >
          {item.rule === "max_loss_hit" ? t("keepStopped") : t("later")}
        </Button>
      </div>
      {w?.status === "done" && w.source !== null ? (
        <p className="m-0 text-xs text-muted">
          {w.source === "replay" ? t("replay") : t("backtest")}
        </p>
      ) : null}
    </article>
  );
}
