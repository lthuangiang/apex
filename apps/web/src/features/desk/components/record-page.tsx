"use client";

import { deskRecordViewSchema, switchBackViewSchema, type DeskRecordView } from "@drift/shared";
import { Button, EmptyState, ErrorState, Skeleton } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";

// AI Desk B+ (artboard BP-Record): thành tích đề xuất, đo 7 ngày sau mỗi Apply, hiện cả lần làm xấu đi. Switch back chỉ
// ở dòng "Made it worse" khi bot vẫn ở version AI đã tạo; user bấm, tạo version mới từ cấu hình cũ.

type Row = DeskRecordView["rows"][number];
type ChipKey = "helped" | "made_worse" | "no_clear_effect" | "measuring" | "unavailable";

const CHIP: Record<ChipKey, string> = {
  helped: "bg-pos-bg text-pos",
  made_worse: "bg-neg-bg text-neg-ink",
  no_clear_effect: "bg-surface-2 text-ink-2",
  measuring: "bg-surface-2 text-ink-2",
  unavailable: "bg-surface-2 text-ink-2",
};

const chipOf = (r: Row): ChipKey =>
  r.status === "done" && r.verdict !== null
    ? r.verdict
    : r.status === "unavailable"
      ? "unavailable"
      : "measuring";

const day = (iso: string) => formatDate(Date.parse(iso));

function useChange() {
  const t = useTranslations("desk.record");
  return (r: Row) => {
    if (r.option !== "lower_leverage") return t(`change.${r.option}`);
    const c = r.changes.find((x) => x.key === "leverage");
    return c?.from == null || c.to === null
      ? null
      : t("change.lower_leverage", { from: c.from, to: c.to });
  };
}

function RecordRow({ r }: { r: Row }) {
  const t = useTranslations("desk.record");
  const change = useChange();
  const qc = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const back = useMutation({
    mutationFn: () =>
      api("POST", `/api/v1/desk/applies/${r.id}/switch-back`, switchBackViewSchema, {
        idempotencyKey: key.current,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["desk", "record"] }),
  });
  const chip = chipOf(r);
  const compare =
    r.old !== null && r.after !== null
      ? t("compare", {
          old: formatMoney(r.old, true) ?? "",
          after: formatMoney(r.after, true) ?? "",
        })
      : t("none");
  return (
    <li className="flex flex-col gap-3 border-t border-border py-4 first:border-t-0 sm:flex-row sm:items-center">
      <span
        className={`inline-flex h-7 min-w-[110px] flex-none items-center justify-center self-start rounded-full px-2.5 text-xs font-extrabold sm:self-center ${CHIP[chip]}`}
      >
        {t(`chip.${chip}`)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link href={`/agent/${r.botId}`} className="text-sm font-bold">
          {(() => {
            const c = change(r);
            return c === null ? r.botName : t("what", { bot: r.botName, change: c });
          })()}
        </Link>
        <span className="text-xs text-ink-2">
          {r.checkedAt === null
            ? t("whenMeasuring", { applied: day(r.appliedAt), due: day(r.dueAt) })
            : t("whenChecked", { applied: day(r.appliedAt), checked: day(r.checkedAt) })}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 sm:items-end">
        <span className="text-xs text-ink-2">{t("compareLabel")}</span>
        <span className="text-sm font-semibold tabular-nums">{compare}</span>
      </div>
      {r.switchedBackVersion !== null ? (
        <span className="text-xs text-ink-2">
          {t("switched", { version: r.switchedBackVersion })}
        </span>
      ) : r.canSwitchBack ? (
        <div className="flex flex-col gap-1">
          <Button
            variant="secondary"
            pending={back.isPending}
            onClick={() => {
              back.mutate();
            }}
          >
            {back.isPending ? t("switching") : t("switchBack")}
          </Button>
          {back.isError ? (
            <span role="alert" className="text-xs text-neg-ink">
              {t("switchError")}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function RecordPage() {
  const t = useTranslations("desk.record");
  const te = useTranslations("common.errors");
  const q = useQuery({
    queryKey: ["desk", "record"],
    queryFn: () => api("GET", "/api/v1/desk/record", deskRecordViewSchema),
  });
  const v = q.data;
  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <Link
          href="/desk"
          className="hidden self-start text-sm font-bold text-accent-ink lg:inline"
        >
          ← {t("back")}
        </Link>
        <PageHead
          title={t("title")}
          subtitle={t("intro")}
          back={{ href: "/desk", label: t("back") }}
        />
        <p className="m-0 text-sm text-ink-2 lg:hidden">{t("intro")}</p>
        {q.isPending ? (
          <Skeleton className="h-64 w-full rounded-card" />
        ) : q.isError || v === undefined ? (
          <ErrorState
            title={t("error")}
            retryLabel={te("retry")}
            onRetry={() => void q.refetch()}
          />
        ) : v.rows.length === 0 ? (
          <EmptyState title={t("empty")} description={t("emptyBody")} />
        ) : (
          <>
            <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ["helped", v.counts.helped],
                  ["made_worse", v.counts.madeWorse],
                  ["measuring", v.counts.measuring],
                  ["no_clear_effect", v.counts.noClearEffect],
                ] as const
              ).map(([k, n]) => (
                <div
                  key={k}
                  className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4"
                >
                  <dt className="text-sm text-ink-2">{t(`counts.${k}`)}</dt>
                  <dd className="m-0 text-2xl font-extrabold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            <Card title={t("applied")}>
              <ul className="m-0 flex list-none flex-col p-0">
                {v.rows.map((r) => (
                  <RecordRow key={r.id} r={r} />
                ))}
              </ul>
            </Card>
            <p className="m-0 text-xs text-muted">{t("foot")}</p>
          </>
        )}
      </div>
    </Workspace>
  );
}
