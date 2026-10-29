"use client";

import { latestImportSchema, type ImportView } from "@drift/shared";
import { Button, ErrorState, Skeleton } from "@drift/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { api } from "@/lib/api";
import { formatDate, shortAddress } from "@/lib/format";
import { useSodexConnection } from "@/lib/queries";

import { StepHeading } from "./onboarding-shell";

// Onboarding 3 (artboard "Onboarding 3 · Import history"). Tiến độ và coverage lấy từ api; phần nào
// thiếu thì hiện là thiếu (SCREENS.md mục 8.1). Không ước lượng thời gian còn lại.

export const IMPORT_KEY = ["imports", "latest"] as const;
const POLL_MS = 2000;

type Section = NonNullable<ImportView["progress"]["fundings"]>;
type RowStatus = "done" | "running" | "waiting" | "failed" | "unavailable";

export function ImportProgress() {
  const t = useTranslations("onboarding.import");
  const tc = useTranslations("common.errors");
  const queryClient = useQueryClient();
  const started = useRef(false);
  const connection = useSodexConnection();
  const latest = useQuery({
    queryKey: IMPORT_KEY,
    queryFn: () => api("GET", "/api/v1/imports/latest", latestImportSchema),
    refetchInterval: (q) => {
      const status = q.state.data?.import?.status;
      return status === "queued" || status === "running" ? POLL_MS : false;
    },
  });

  const start = async () => {
    await api("POST", "/api/v1/imports", latestImportSchema, {
      idempotencyKey: crypto.randomUUID(),
    });
    await queryClient.invalidateQueries({ queryKey: IMPORT_KEY });
  };

  // Lần đầu vào bước 3 mà chưa có import nào thì bắt đầu một lần.
  useEffect(() => {
    if (started.current || latest.data?.import !== null) return;
    started.current = true;
    void start();
  });

  if (latest.isPending || connection.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (latest.isError || connection.isError) {
    return (
      <ErrorState
        title={tc("generic")}
        retryLabel={tc("retry")}
        onRetry={() => void latest.refetch()}
      />
    );
  }
  const imp = latest.data.import;
  const address = connection.data.connection?.address;
  const sections = imp?.coverage ?? imp?.progress ?? {};
  const fills = [sections.spotFills, sections.perpsFills];
  const fillStatus = combine([...fills, sections.positions]);
  const fundingStatus = combine([sections.fundings]);
  const analysisStatus: RowStatus =
    imp?.status === "done" || imp?.status === "failed" ? "done" : "waiting";
  const finished = [fillStatus, fundingStatus, analysisStatus].filter(
    (s) => s === "done" || s === "failed",
  ).length;
  const pct = Math.round((finished / 3) * 100);

  const fillCount = fills.reduce((s, x) => s + (x?.count ?? 0), 0);
  const range = (list: (Section | undefined)[]) => {
    const froms = list.map((x) => x?.from).filter((v): v is number => typeof v === "number");
    const tos = list.map((x) => x?.to).filter((v): v is number => typeof v === "number");
    return froms.length === 0
      ? null
      : { from: formatDate(Math.min(...froms)), to: formatDate(Math.max(...tos)) };
  };
  const fillRange = range(fills);
  const fundingRange = range([sections.fundings]);
  const truncated = [...fills, sections.positions, sections.fundings].find(
    (x) => x?.truncated === true,
  );

  return (
    <>
      <StepHeading
        step={3}
        title={t("title")}
        {...(address === undefined
          ? {}
          : { lead: t("subtitle", { address: shortAddress(address) }) })}
      />
      <section
        aria-label={t("overallLabel")}
        className="flex flex-col gap-3 rounded-card bg-hero p-5 tabular-nums"
      >
        <strong className="text-lg">{t("progress", { pct })}</strong>
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("progressLabel")}
          className="h-3 rounded-full bg-surface/75"
        >
          <div className="h-3 rounded-full bg-accent" style={{ width: `${String(pct)}%` }} />
        </div>
      </section>
      <ol className="m-0 flex list-none flex-col overflow-hidden rounded-tile border border-border p-0 tabular-nums">
        <Row
          index={1}
          title={t("fills")}
          status={fillStatus}
          sub={
            fillStatus === "running"
              ? t("fillsRunning", { count: fillCount })
              : fillRange === null
                ? t("fillsEmpty")
                : `${t("fillsDone", { count: fillCount, ...fillRange })} · ${t("positions", { count: sections.positions?.count ?? 0 })}`
          }
        />
        <Row
          index={2}
          title={t("funding")}
          status={fundingStatus}
          sub={
            fundingRange === null
              ? t("fundingSub")
              : t("fundingDone", {
                  count: sections.fundings?.count ?? 0,
                  ...fundingRange,
                })
          }
        />
        <Row index={3} title={t("transfers")} status="unavailable" sub={t("transfersSub")} />
        <Row index={4} title={t("analysis")} status={analysisStatus} sub={t("analysisSub")} />
      </ol>
      {truncated?.from == null ? null : (
        <p role="status" className="m-0 rounded-control bg-warn-bg px-3.5 py-3 text-sm text-warn">
          {t("truncated", { from: formatDate(truncated.from) })}
        </p>
      )}
      {imp?.status === "failed" ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-neg-bg px-3.5 py-3 text-sm text-neg-ink"
        >
          {t("failed")}
          <Button variant="secondary" onClick={() => void start()}>
            {t("retry")}
          </Button>
        </div>
      ) : null}
      <p className="m-0 rounded-control bg-surface-2 px-4 py-3.5 text-[13px] leading-normal text-ink-2">
        {t("note")}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <Link href="/bots" className="text-sm font-bold text-accent no-underline">
          {t("skip")}
        </Link>
        {imp?.status === "done" || imp?.status === "failed" ? (
          <Link
            href="/onboarding/analysis"
            className="inline-flex min-h-tap items-center rounded-control bg-accent px-5 text-sm font-bold text-surface no-underline"
          >
            {t("next")}
          </Link>
        ) : (
          <Button disabled>{t("next")}</Button>
        )}
      </div>
    </>
  );
}

function combine(list: (Section | undefined)[]): RowStatus {
  if (list.some((x) => x?.status === "failed")) return "failed";
  if (list.some((x) => x?.status === "running")) return "running";
  if (list.length > 0 && list.every((x) => x?.status === "done")) return "done";
  return list.some((x) => x !== undefined) ? "running" : "waiting";
}

function Row({
  index,
  title,
  sub,
  status,
}: {
  index: number;
  title: string;
  sub: string;
  status: RowStatus;
}) {
  const t = useTranslations("onboarding.import.status");
  const tone: Record<RowStatus, string> = {
    done: "bg-pos-bg text-pos",
    running: "border-[3px] border-accent-tint border-t-accent animate-spin",
    waiting: "bg-surface-2 text-ink-2",
    failed: "bg-neg-bg text-neg-ink",
    unavailable: "bg-surface-2 text-muted",
  };
  const label: Record<RowStatus, string> = {
    done: "text-pos",
    running: "text-accent-ink",
    waiting: "text-muted",
    failed: "text-neg-ink",
    unavailable: "text-muted",
  };
  return (
    <li
      className={`flex items-center gap-3.5 border-b border-border px-4 py-4 last:border-b-0 ${status === "running" ? "bg-accent-tint/40" : ""}`}
    >
      <span
        aria-hidden="true"
        className={`flex size-8 flex-none items-center justify-center rounded-full text-sm font-extrabold ${tone[status]}`}
      >
        {status === "done"
          ? "✓"
          : status === "failed"
            ? "!"
            : status === "running"
              ? ""
              : status === "unavailable"
                ? "–"
                : index}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="text-[15px]">{title}</strong>
        <span className="text-[13px] text-ink-2">{sub}</span>
      </div>
      <span className={`text-[13px] font-bold ${label[status]}`}>{t(status)}</span>
    </li>
  );
}
