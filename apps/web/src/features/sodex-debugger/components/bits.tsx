"use client";

import type { SodexCallOutcome } from "@drift/shared";
import { Check, CircleHelp, Clock, Lock, WifiOff, X, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";

import { pathParts } from "../format";

// Thành phần nhỏ dùng chung của SoDEX Debugger (tag outcome, JSON tô màu, bảng khoá–giá trị).

const OUTCOME: Record<SodexCallOutcome, { icon: LucideIcon; cls: string }> = {
  ok: { icon: Check, cls: "bg-pos-bg text-pos" },
  rejected: { icon: X, cls: "bg-neg-bg text-neg-ink" },
  timeout: { icon: Clock, cls: "bg-warn-bg text-warn" },
  network: { icon: WifiOff, cls: "bg-warn-bg text-warn" },
  unreadable: { icon: CircleHelp, cls: "bg-unknown-bg text-unknown" },
};

export function OutcomeTag({ outcome }: { outcome: SodexCallOutcome }) {
  const t = useTranslations("sodexDebugger.outcome");
  const { icon: Icon, cls } = OUTCOME[outcome];
  return (
    <span
      className={`inline-flex items-center gap-[5px] whitespace-nowrap rounded-full py-[3px] pr-[9px] pl-[7px] text-xs font-extrabold ${cls}`}
    >
      <Icon aria-hidden="true" size={12} strokeWidth={2.4} className="flex-none" />
      {t(outcome)}
    </span>
  );
}

/** Đường dẫn có điểm ngắt dòng sau mỗi "/". */
export function Path({ path }: { path: string }) {
  return (
    <>
      {pathParts(path).map((p, i) => (
        <Fragment key={i}>
          {p}
          <wbr />
        </Fragment>
      ))}
    </>
  );
}

export function RedactChip({ kind }: { kind: "signature" | "masked" }) {
  const t = useTranslations("sodexDebugger.detail");
  return (
    <span className="inline-flex items-center gap-[5px] rounded-full border border-dashed border-border-input bg-surface-2 px-2 py-0.5 font-sans text-[11.5px] font-bold tracking-normal text-ink-2 normal-case">
      {kind === "signature" ? (
        <>
          <Lock aria-hidden="true" size={12} strokeWidth={2.2} />
          {t("signatureRedacted")}
        </>
      ) : (
        t("keyMasked")
      )}
    </span>
  );
}

/** Bảng khoá–giá trị như mockup (.kv). */
export function Kv({ rows }: { rows: { k: string; v: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="m-0 grid grid-cols-[104px_minmax(0,1fr)] overflow-hidden rounded-control border border-border text-[13px] md:grid-cols-[132px_minmax(0,1fr)]">
      {rows.map((r, i) => (
        <Fragment key={r.k}>
          <dt
            className={`bg-surface-2 px-2.5 py-2 font-bold text-ink-2 ${i === 0 ? "" : "border-t border-border"}`}
          >
            {r.k}
          </dt>
          <dd
            className={`m-0 flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-2 break-all ${r.mono === false ? "" : "font-mono text-[12.5px]"} ${i === 0 ? "" : "border-t border-border"}`}
          >
            {r.v}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

/** JSON đã định dạng, tô màu khoá / chuỗi / số; chuỗi chứa `errMatch` được tô đỏ. Không dùng innerHTML. */
export function JsonView({
  text,
  label,
  errMatch,
}: {
  text: string;
  label: string;
  errMatch?: string | null;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index;
    if (at > last) parts.push(text.slice(last, at));
    const [whole, str, colon, num, lit] = m;
    if (str !== undefined && colon !== undefined) {
      parts.push(
        <span key={at} className="text-accent-ink">
          {str}
        </span>,
        colon,
      );
    } else if (str !== undefined) {
      const err = errMatch != null && errMatch !== "" && str.includes(errMatch);
      parts.push(
        <span key={at} className={err ? "rounded-[3px] bg-neg-bg px-0.5 text-neg-ink" : "text-pos"}>
          {str}
        </span>,
      );
    } else {
      parts.push(
        <span key={at} className="text-unknown">
          {num ?? lit ?? whole}
        </span>,
      );
    }
    last = at + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <pre
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- khối cuộn được phải nhận focus để cuộn bằng bàn phím.
      tabIndex={0}
      aria-label={label}
      className="m-0 rounded-control border border-border bg-surface-2 px-3.5 py-3 font-mono text-[12.5px] leading-[1.55] break-all whitespace-pre-wrap text-ink"
    >
      {parts}
    </pre>
  );
}
