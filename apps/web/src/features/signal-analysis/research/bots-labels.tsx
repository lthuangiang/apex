"use client";

import {
  CLASSIFIER_GATE,
  type ResearchPaperBot,
  type ResearchSummary,
  type ResearchVersions,
} from "@drift/shared";
import { useTranslations } from "next-intl";

import { experimentsMeta } from "./experiments";
import type { HowTab } from "./how-it-works";
import { ClassifierQuality } from "./labels";
import { rulesList } from "./text";
import { Na } from "./ui";
import { classifierShort } from "./version-text";
import { NewsVersions } from "./versions";
import { ResearchWalletsBlock } from "./wallet-links";

// Khu "Bots & labels" ở cuối trang Signal research (thiết kế docs/mockups/signal-research/compact-desktop.html, khung A
// và B): gập sẵn bằng <details>. Bên trong giữ nguyên nội dung cũ của Paper bots (News bot versions, lệnh của quy tắc
// cũ) và Classifier quality (đổi tên trên UI thành "Is Claude reading news right?"). "Manage versions" và
// "Label signals" (dải tóm tắt, Is it working?) mở khu này và cuộn tới (bots-labels-context.ts).

export const BOTS_LABELS_ID = "sr-bots-labels";

export function BotsAndLabels({
  open,
  onOpenChange,
  labelSeq,
  bots,
  tz,
  versionId,
  onVersion,
  summaryVersion,
  older,
  versions,
  onHow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tăng mỗi lần bấm "Label signals" (bắt đầu luồng gắn nhãn ngẫu nhiên). */
  labelSeq: number;
  bots: readonly ResearchPaperBot[];
  tz: string;
  versionId: string | null;
  onVersion: (id: string) => void;
  /** Version mà tổng kết (và lãi / lỗ chưa chốt của bot News) đang mô tả. */
  summaryVersion: string | null;
  /** #321: lệnh của quy tắc cũ (v2) vẫn theo dõi ở bảng Paper trades. */
  older: ResearchSummary["olderRules"];
  versions: ResearchVersions | undefined;
  onHow: (tab: HowTab) => void;
}) {
  const t = useTranslations("signalAnalysis.research.botsLabels");
  const tb = useTranslations("signalAnalysis.research.bots");
  const tn = useTranslations("signalAnalysis.research");
  const news = bots.find((b) => b.type === "news");
  const meta =
    versions === undefined ? (
      <Na />
    ) : (
      // #377 (mockup catalyst-experiments-*): phần thí nghiệm thay "N versions tried"; điện thoại chỉ hiện phần thí nghiệm.
      <>
        <span className="max-md:hidden">
          {t("metaWithExperiments", {
            n: versions.running,
            max: versions.maxRunning,
            experiments: experimentsMeta(versions.items, t),
            v: classifierShort(versions.classifier.current),
            labeled: versions.classifier.labeled,
            min: CLASSIFIER_GATE.minLabels,
          })}
        </span>
        <span className="md:hidden">{experimentsMeta(versions.items, t)}</span>
      </>
    );
  const link =
    "cursor-pointer border-0 bg-transparent p-0 font-semibold text-accent-ink underline-offset-2 hover:underline focus-visible:underline";
  return (
    <section
      id={BOTS_LABELS_ID}
      aria-labelledby={`${BOTS_LABELS_ID}-title`}
      className="min-w-0 scroll-mt-4 rounded-card bg-surface shadow-card"
    >
      <details
        open={open}
        onToggle={(e) => {
          const now = e.currentTarget.open;
          if (now !== open) onOpenChange(now);
        }}
        className="group"
      >
        <summary className="flex min-h-16 cursor-pointer list-none items-start gap-3 rounded-card px-4 py-3.5 md:items-center md:gap-3.5 md:px-6 md:py-4 [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden="true"
            className="inline-flex size-7 flex-none items-center justify-center rounded-lg border border-border bg-surface-2 text-sm text-ink-2 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          >
            ▶
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={`${BOTS_LABELS_ID}-title`} className="m-0 text-lg font-extrabold md:text-xl">
              {t("title")}
            </h2>
            <span className="text-[13px] text-muted">{meta}</span>
          </span>
          <span className="flex-none text-[13px] font-extrabold text-accent-ink">
            {open ? t("hide") : t("show")}
          </span>
        </summary>
        <div className="flex min-w-0 flex-col gap-3.5 px-4 pb-5 md:px-6 md:pb-6">
          <NewsVersions
            tz={tz}
            selected={versionId}
            onSelect={onVersion}
            unrealized={
              summaryVersion === null || news === undefined
                ? null
                : { versionId: summaryVersion, value: news.unrealized }
            }
          />
          {older.trades === 0 ? null : (
            <p className="m-0 text-[13px] text-muted">
              {tb("olderRules", { n: older.trades, versions: rulesList(older.versions, tn) })}
            </p>
          )}
          <div className="border-t border-border pt-4">
            <ClassifierQuality tz={tz} startSeq={labelSeq} />
          </div>
          {/* #353: tập ví nghiên cứu của H1 (tải khi khu mở). */}
          <div className="border-t border-border pt-4">
            <ResearchWalletsBlock open={open} />
          </div>
          <p className="m-0 text-xs text-muted">
            {t("more")}{" "}
            <button
              type="button"
              className={link}
              onClick={() => {
                onHow("versions");
              }}
            >
              {t("howVersions")}
            </button>
            {" · "}
            <button
              type="button"
              className={link}
              onClick={() => {
                onHow("labels");
              }}
            >
              {t("howLabels")}
            </button>
          </p>
        </div>
      </details>
    </section>
  );
}
