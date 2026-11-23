"use client";

import {
  SR_EXPORT_PERIODS,
  srExportFileName,
  srExportSchema,
  type SrExportPeriod,
} from "@drift/shared";
import { SegmentedControl } from "@drift/ui";
import { useMutation } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { api, ApiError } from "@/lib/api";

// Export data của Signal Research (#489): CHỈ team (trang chỉ render cho team; API kiểm role). Tải một file JSON theo kỳ
// 24h / 7d / 30d để PM phân tích. Kiểu nút giống nút export của bot (Trading Agent); không thêm bố cục mới. Lỗi theo câu
// chữ chung (`common.errors`), không hiện message thô của server (C6).

const BUTTON =
  "inline-flex min-h-tap cursor-pointer items-center justify-center gap-1.5 rounded-control border border-border bg-surface px-4 text-sm font-bold text-ink hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60";

/** Lưu nội dung đã kiểm theo schema thành file `desklabs-signal-research-<period>-<UTC date>.json`. */
function save(period: SrExportPeriod, body: unknown, at: Date) {
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = srExportFileName(period, at);
  a.click();
  URL.revokeObjectURL(a.href);
}

export function ResearchExport() {
  const t = useTranslations("signalResearch.export");
  const te = useTranslations("common.errors");
  const [period, setPeriod] = useState<SrExportPeriod>("24h");
  const run = useMutation({
    mutationFn: (p: SrExportPeriod) =>
      api("GET", `/api/v1/admin/signal-research/export?period=${p}`, srExportSchema),
    onSuccess: (body, p) => {
      save(p, body, new Date(body.meta.exportedAt));
    },
  });
  const error =
    run.error === null
      ? null
      : run.error instanceof ApiError && run.error.code === "NETWORK"
        ? te("network")
        : run.error instanceof ApiError && run.error.code === "RATE_LIMITED"
          ? te("rateLimited")
          : te("generic");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label={t("period")}
          options={SR_EXPORT_PERIODS.map((p) => ({ value: p, label: t(`periods.${p}`) }))}
          value={period}
          onValueChange={setPeriod}
        />
        <button
          type="button"
          className={BUTTON}
          disabled={run.isPending}
          aria-busy={run.isPending}
          onClick={() => {
            run.mutate(period);
          }}
        >
          <Download aria-hidden="true" size={16} strokeWidth={2.4} />
          {run.isPending ? t("exporting") : t("button")}
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="m-0 text-xs font-semibold text-neg-ink">
          {error}
        </p>
      )}
    </div>
  );
}
