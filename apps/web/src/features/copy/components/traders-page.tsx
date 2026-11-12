"use client";

import { HIDDEN_REASONS, TRADER_TABS, type TraderTab } from "@drift/shared";
import { EmptyState, ErrorState, Skeleton } from "@drift/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { PageHead, Workspace } from "@/components/workspace";
import { useFeatures } from "@/lib/queries";

import { useTraders } from "../api";

import { TraderCardView } from "./parts";

// Find traders (artboard Leaders, DEC-163): trader Hyperliquid tính lại từ fill thật mỗi ngày; tab Steady mặc định;
// hướng dẫn 3 bước; nói rõ bao nhiêu trader bị ẩn và vì sao. Chỉ khi tài khoản bật AI Desk.

const GUIDE_KEY = "copy.guide.closed";

function readGuideClosed(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function TradersPage() {
  const t = useTranslations("copy");
  const router = useRouter();
  const params = useSearchParams();
  const features = useFeatures();
  const raw = params.get("tab");
  const tab: TraderTab = (TRADER_TABS as readonly string[]).includes(raw ?? "")
    ? (raw as TraderTab)
    : "steady";
  const list = useTraders(tab);
  const [guideClosed, setGuideClosed] = useState(true);
  const [whyOpen, setWhyOpen] = useState(false);
  useEffect(() => {
    setGuideClosed(readGuideClosed());
  }, []);
  useEffect(() => {
    if (features.data !== undefined && !features.data.aiDesk) router.replace("/");
  }, [features.data, router]);

  const data = list.data;
  const anyFull = data?.items.some((i) => i.slot === "full") === true;

  return (
    <Workspace current="traders">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("list.title")}
          subtitle={t("list.subtitle")}
          action={
            // Artboard Leaders: trạng thái cập nhật là một chip ở góc phải tiêu đề.
            <span className="inline-flex min-h-8 items-center rounded-full border border-border bg-surface px-3 text-[12.5px] font-bold text-ink-2 tabular-nums">
              {data?.checking != null
                ? t("list.checking", { done: data.checking.done, total: data.checking.total })
                : data?.updatedOn == null
                  ? t("list.notUpdated")
                  : t("list.updated", { date: data.updatedOn })}
            </span>
          }
        />

        {guideClosed ? null : (
          <section
            aria-label={t("list.guideTitle")}
            className="flex flex-col gap-3.5 rounded-card border border-border bg-surface px-[22px] py-5"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="m-0 text-base font-extrabold">{t("list.guideTitle")}</h2>
              <button
                type="button"
                aria-label={t("list.guideClose")}
                className="flex size-tap items-center justify-center rounded-control text-ink-2 hover:bg-surface-2"
                onClick={() => {
                  setGuideClosed(true);
                  try {
                    window.localStorage.setItem(GUIDE_KEY, "1");
                  } catch {
                    // Trình duyệt chặn lưu: chỉ đóng trong phiên này.
                  }
                }}
              >
                ✕
              </button>
            </div>
            <ol className="m-0 grid list-none gap-3 p-0 sm:grid-cols-3">
              {([1, 2, 3] as const).map((n) => (
                // Bước 1 (đang ở đây) nổi bật, hai bước sau nhạt (artboard Leaders).
                <li
                  key={n}
                  className={`flex gap-3 rounded-[16px] p-3.5 ${n === 1 ? "bg-accent-tint" : "bg-surface-2"}`}
                >
                  <span
                    className={`flex size-7 flex-none items-center justify-center rounded-[9px] text-[13px] font-extrabold ${
                      n === 1 ? "bg-accent text-white" : "bg-accent-tint text-accent-ink"
                    }`}
                  >
                    {n}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <strong className="text-sm">{t(`list.step${String(n) as "1"}Title`)}</strong>
                    <span className="text-[13px] leading-snug text-ink-2">
                      {t(`list.step${String(n) as "1"}Body`)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <div
          role="tablist"
          aria-label={t("list.tabsLabel")}
          className="flex w-full gap-1 overflow-x-auto rounded-[16px] border border-border bg-surface p-1 sm:w-auto sm:self-start"
        >
          {TRADER_TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => {
                router.replace(k === "steady" ? "/traders" : `/traders?tab=${k}`);
              }}
              className={`flex min-h-tap flex-1 items-center justify-center rounded-[12px] px-4 text-sm font-bold whitespace-nowrap sm:flex-none ${
                tab === k ? "bg-accent font-extrabold text-white" : "text-ink-2 hover:bg-surface-2"
              }`}
            >
              {t(`list.tabs.${k}`)}
            </button>
          ))}
        </div>
        {tab === "steady" ? <p className="m-0 text-sm text-ink-2">{t("list.steadyNote")}</p> : null}
        {/* Artboard luôn hiện giới hạn 8 chỗ copy realtime; khi hết chỗ thì thêm câu in đậm. */}
        <p className="m-0 rounded-[16px] bg-accent-tint px-4 py-3 text-[13px] leading-normal text-accent-ink">
          {anyFull ? <strong>{t("list.slotsFull")} </strong> : null}
          {t("list.slotsNote")}
        </p>

        {list.isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-72 rounded-card" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState
            title={t("common.loadError")}
            retryLabel={t("common.retry")}
            onRetry={() => {
              void list.refetch();
            }}
          />
        ) : data === undefined || data.items.length === 0 ? (
          <EmptyState title={t("list.empty")} description={t("list.emptyBody")} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.items.map((c) => (
              <TraderCardView key={c.address} card={c} />
            ))}
          </div>
        )}

        {data !== undefined && data.hidden > 0 ? (
          <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-5 text-sm">
            <p className="m-0">
              <strong>{t("list.hidden", { hidden: data.hidden, total: data.candidates })}</strong>{" "}
              <span className="text-ink-2">{t("list.hiddenWhy")}</span>
            </p>
            <button
              type="button"
              aria-expanded={whyOpen}
              className="self-start font-bold text-accent underline-offset-2 hover:underline"
              onClick={() => {
                setWhyOpen((v) => !v);
              }}
            >
              {t("list.seeWhy")}
            </button>
            {whyOpen ? (
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-ink-2">
                {HIDDEN_REASONS.map((r) => (
                  <li key={r}>{t(`list.hiddenBy.${r}`, { n: data.hiddenBy[r] })}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        <p className="m-0 text-xs text-muted">{t("common.past")}</p>
      </div>
    </Workspace>
  );
}
