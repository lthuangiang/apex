"use client";

import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

// "How it works" cho option khó hiểu (DEC-145, DEC-146): nội dung ở `createBot.fields.<label>.how` (intro, steps, note).
// Dùng chung cho form tạo / sửa bot và phần Configuration trên trang bot.

/** Field có phần giải thích không (theo key câu chữ của field). */
export function useHasHow() {
  const t = useTranslations("createBot");
  return (labelKey: string) => t.has(`fields.${labelKey}.how.intro`);
}

function HowBody({ labelKey }: { labelKey: string }) {
  const t = useTranslations("createBot");
  const steps = t.has(`fields.${labelKey}.how.steps`)
    ? (t.raw(`fields.${labelKey}.how.steps`) as unknown)
    : null;
  const note = t.has(`fields.${labelKey}.how.note`) ? t(`fields.${labelKey}.how.note`) : null;
  return (
    <div className="flex flex-col gap-2 text-left font-normal text-ink-2">
      <p className="m-0">{t(`fields.${labelKey}.how.intro`)}</p>
      {Array.isArray(steps) ? (
        <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
          {steps.map((s) => (
            <li key={String(s)}>{String(s)}</li>
          ))}
        </ul>
      ) : null}
      {note === null ? null : <p className="m-0 text-muted">{note}</p>}
    </div>
  );
}

export function HowItWorks({ labelKey, title }: { labelKey: string; title?: string }) {
  const t = useTranslations("createBot");
  if (!t.has(`fields.${labelKey}.how.intro`)) return null;
  return (
    <details className="rounded-[12px] border border-border bg-surface-2 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-semibold text-accent">
        {title === undefined ? t("howItWorks") : t("howItWorksOf", { name: title })}
      </summary>
      <div className="mt-2">
        <HowBody labelKey={labelKey} />
      </div>
    </details>
  );
}

/**
 * Icon ⓘ cạnh nhãn, bấm mở popup "How it works" (trang bot, DEC-146). Popup định vị `fixed` theo icon, giữ trong
 * màn hình; đóng khi bấm ra ngoài, Esc hoặc bấm lại icon.
 */
export function HowItWorksInfo({ labelKey, name }: { labelKey: string; name: string }) {
  const t = useTranslations("createBot");
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const id = useId();

  useEffect(() => {
    if (pos === null) return;
    const close = (e: Event) => {
      const n = e.target as Node | null;
      if (n !== null && (panel.current?.contains(n) === true || btn.current?.contains(n) === true))
        return;
      setPos(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPos(null);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  if (!t.has(`fields.${labelKey}.how.intro`)) return null;
  const toggle = () => {
    if (pos !== null) {
      setPos(null);
      return;
    }
    const r = btn.current?.getBoundingClientRect();
    if (r === undefined) return;
    const w = Math.min(340, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left - 12, window.innerWidth - w - 16));
    setPos({ top: r.bottom + 8, left });
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={t("howItWorksOf", { name })}
        aria-expanded={pos !== null}
        aria-controls={pos === null ? undefined : id}
        onClick={toggle}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:text-accent focus-visible:text-accent"
      >
        <Info size={15} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {pos === null ? null : (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={t("howItWorksOf", { name })}
          style={{ top: pos.top, left: pos.left, width: Math.min(340, window.innerWidth - 32) }}
          className="fixed z-50 max-h-[60vh] overflow-y-auto rounded-[14px] border border-border bg-surface p-4 text-xs shadow-lg"
        >
          <p className="m-0 mb-2 text-sm font-extrabold text-ink">{name}</p>
          <HowBody labelKey={labelKey} />
        </div>
      )}
    </>
  );
}
