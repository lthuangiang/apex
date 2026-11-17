"use client";

import type { SodexCallDetail } from "@drift/shared";
import { BottomSheet, Button } from "@drift/ui";
import { Copy, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { buildReport, type ReportOptions } from "../format";

// Hộp thoại "Report for SoDEX" (mockup view=report): văn bản thuần dựng ở trình duyệt từ bản đã lưu (không có chữ ký /
// key). Mặc định gồm địa chỉ account đầy đủ; bỏ chọn thì che. Dưới 768px là bottom sheet.

export function ReportDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: SodexCallDetail | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("sodexDebugger.report");
  const tr = useTranslations("sodexDebugger.reportText");
  const [opts, setOpts] = useState<ReportOptions>({
    related: true,
    fullAddress: true,
    responseHeaders: false,
  });
  const [status, setStatus] = useState("");
  const text = detail === undefined ? "" : buildReport(detail, opts, (k, v) => tr(k, v));
  const box = (key: keyof ReportOptions, label: string) => (
    <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-[13.5px] font-semibold text-ink-2">
      <input
        type="checkbox"
        checked={opts[key]}
        onChange={(e) => {
          setOpts((o) => ({ ...o, [key]: e.target.checked }));
        }}
        className="size-5 accent-accent"
      />
      {label}
    </label>
  );
  return (
    <BottomSheet
      open={open}
      onOpenChange={(o) => {
        if (!o) setStatus("");
        onOpenChange(o);
      }}
      title={t("title")}
      description={t("description")}
      closeLabel={t("close")}
      wide
      footer={
        <>
          <span className="mr-auto inline-flex items-center gap-1.5 text-[13px] text-muted">
            <Lock aria-hidden="true" size={13} strokeWidth={2.2} />
            {t("foot")}
          </span>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t("close")}
          </Button>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(text).then(
                () => {
                  setStatus(t("copied"));
                },
                () => undefined,
              );
            }}
          >
            <Copy aria-hidden="true" size={16} />
            {t("copy")}
          </Button>
        </>
      }
    >
      <div role="group" aria-label={t("include")} className="flex flex-wrap gap-x-[18px] gap-y-1.5">
        {box("related", t("related"))}
        {box("fullAddress", t("fullAddress"))}
        {box("responseHeaders", t("responseHeaders"))}
      </div>
      <pre
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- khối cuộn được phải nhận focus để cuộn bằng bàn phím.
        tabIndex={0}
        aria-label={t("textLabel")}
        className="m-0 max-h-[470px] overflow-auto rounded-[14px] border border-border bg-surface-2 px-4 py-3.5 font-mono text-xs leading-[1.55] break-words whitespace-pre-wrap text-ink"
      >
        {text}
      </pre>
      <div role="status" className="sr-only">
        {status}
      </div>
    </BottomSheet>
  );
}
