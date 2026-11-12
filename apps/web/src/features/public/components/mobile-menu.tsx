"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

// Menu hamburger của Landing trên điện thoại (< 768 px, DEC-148): gom các link anchor và Sign in. Đóng khi bấm một
// link, bấm ra ngoài hoặc Esc.

export function MobileMenu({
  links,
  signIn,
  launch,
  openLabel,
  closeLabel,
}: {
  links: readonly { href: string; label: string }[];
  signIn: string;
  /** Nút Launch app trong menu: header ẩn nút này dưới 380 px (DEC-153). */
  launch: string;
  openLabel: string;
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node) !== true) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
  };
  return (
    <div ref={box} className="relative md:hidden">
      <button
        ref={btn}
        type="button"
        aria-label={open ? closeLabel : openLabel}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex size-11 cursor-pointer items-center justify-center rounded-control border border-border bg-surface text-ink"
      >
        {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>
      {open ? (
        <nav
          id={id}
          aria-label={openLabel}
          className="absolute top-[calc(100%+8px)] right-0 z-50 flex w-[min(280px,calc(100vw-32px))] flex-col rounded-tile border border-border bg-surface p-2 shadow-lg"
        >
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={close}
              className="flex min-h-tap items-center rounded-control px-3 text-[15px] font-semibold text-ink no-underline hover:bg-surface-2"
            >
              {l.label}
            </a>
          ))}
          <div className="my-1 h-px bg-border" />
          <Link
            href="/signin"
            onClick={close}
            className="flex min-h-tap items-center rounded-control px-3 text-[15px] font-bold text-accent no-underline hover:bg-surface-2"
          >
            {signIn}
          </Link>
          <Link
            href="/signup"
            onClick={close}
            className="mt-1 flex min-h-tap items-center justify-center rounded-control bg-accent px-3 text-[15px] font-bold text-surface no-underline min-[380px]:hidden"
          >
            {launch}
          </Link>
        </nav>
      ) : null}
    </div>
  );
}
