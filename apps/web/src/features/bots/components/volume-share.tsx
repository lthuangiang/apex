"use client";

import { BottomSheet, Button } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { formatAmount } from "@/lib/format";

// Ảnh chia sẻ kết quả bot (DEC-127 bot khối lượng, DEC-132 bot lãi / lỗ): vẽ bằng canvas 1200 × 630 (tỷ lệ ảnh xem trước của X / Telegram),
// không cần thư viện. Chỉ chứa số của chính bot: không có địa chỉ ví, account id hay số dư.

export interface VolumeShareData {
  botName: string;
  market: string;
  strategyName: string;
  volume: string;
  costPerMillion: string | null;
  net: string;
  /** Null với chiến lược không đếm lượt (Market Making): ô thứ hai hiện chi phí. */
  trades: number | null;
  makerSharePct: string | null;
  /** Kỳ của số liệu (ví dụ "Period: All"), ghi ở chân ảnh để khớp với tab đang chọn (DEC-151). */
  period?: string;
}

const W = 1200;
const H = 630;
const ACCENT = "#2e62e8";

function fontFamily(): string {
  if (typeof document === "undefined") return "sans-serif";
  return getComputedStyle(document.body).fontFamily || "sans-serif";
}

/** Nội dung một ảnh chia sẻ: dùng chung cho bot khối lượng và bot lãi / lỗ (DEC-132). */
export interface ShareSpec {
  chip: string;
  heroLabel: string;
  hero: string;
  heroSuffix: string | null;
  heroColor: string;
  stats: [string, string][];
  tagline: string;
  footer: string;
}

/** Vẽ ảnh 1200 × 630 theo spec. */
export function drawShare(canvas: HTMLCanvasElement, sp: ShareSpec): void {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const ff = fontFamily();

  // Nền tối với quầng sáng màu thương hiệu, chữ trắng: dễ đọc khi thu nhỏ trên X / Telegram.
  ctx.fillStyle = "#0b1230";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W - 120, 40, 20, W - 120, 40, 620);
  glow.addColorStop(0, "rgba(46,98,232,0.85)");
  glow.addColorStop(1, "rgba(46,98,232,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  const glow2 = ctx.createRadialGradient(80, H, 10, 80, H, 420);
  glow2.addColorStop(0, "rgba(126,226,168,0.22)");
  glow2.addColorStop(1, "rgba(126,226,168,0)");
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // Logo DeskLabs (DEC-153): ô vuông bo góc, chữ D lồng hai vạch sổ lệnh (vẽ theo lưới 24 của icon).
  ctx.fillStyle = ACCENT;
  roundRect(ctx, 72, 64, 52, 52, 14);
  ctx.fill();
  ctx.save();
  ctx.translate(72, 64);
  ctx.scale(52 / 24, 52 / 24);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.4;
  ctx.lineJoin = "round";
  ctx.stroke(new Path2D("M6.5 5h5.2a7 7 0 0 1 0 14H6.5z"));
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, 9.6, 9, 4.6, 2, 1);
  ctx.fill();
  ctx.globalAlpha = 0.7;
  roundRect(ctx, 9.6, 13, 3.2, 2, 1);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 34px ${ff}`;
  ctx.fillText("DeskLabs", 140, 91); // khối tên + tagline cao bằng logo (y 64–116)
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = `500 20px ${ff}`;
  ctx.fillText(sp.tagline, 140, 116);

  // Chip chiến lược · market.
  ctx.font = `700 20px ${ff}`;
  const cw = ctx.measureText(sp.chip).width + 40;
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  roundRect(ctx, W - 72 - cw, 70, cw, 44, 22);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(sp.chip, W - 72 - cw + 20, 99);

  // Số chính: thu nhỏ chữ nếu quá dài để không tràn khung.
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = `600 26px ${ff}`;
  ctx.fillText(sp.heroLabel, 72, 236);
  ctx.fillStyle = sp.heroColor;
  let size = 150;
  ctx.font = `800 ${String(size)}px ${ff}`;
  const room = W - 144 - (sp.heroSuffix === null ? 0 : 160);
  while (ctx.measureText(sp.hero).width > room && size > 72) {
    size -= 6;
    ctx.font = `800 ${String(size)}px ${ff}`;
  }
  ctx.fillText(sp.hero, 64, 380);
  if (sp.heroSuffix !== null) {
    const bw = ctx.measureText(sp.hero).width;
    ctx.font = `700 40px ${ff}`;
    ctx.fillText(sp.heroSuffix, 64 + bw + 18, 380);
  }

  // Ba ô chỉ số.
  const gap = 20;
  const boxW = (W - 144 - gap * (sp.stats.length - 1)) / sp.stats.length;
  sp.stats.forEach(([label, value], i) => {
    const x = 72 + i * (boxW + gap);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    roundRect(ctx, x, 430, boxW, 112, 20);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = `600 20px ${ff}`;
    ctx.fillText(label, x + 24, 470);
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 34px ${ff}`;
    ctx.fillText(value, x + 24, 516);
  });

  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = `500 18px ${ff}`;
  ctx.fillText(sp.footer, 72, 588);

  // Tên miền ở góc phải dưới, để người xem ảnh biết vào đâu (DEC-150).
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = `700 18px ${ff}`;
  ctx.textAlign = "right";
  ctx.fillText(SHARE_DOMAIN, W - 72, 588);
  ctx.textAlign = "left";
}

const SHARE_DOMAIN = "desklabs.xyz";

/** Ảnh kết quả bot khối lượng (DEC-127). */
export function drawVolumeShare(
  canvas: HTMLCanvasElement,
  d: VolumeShareData,
  text: {
    costLabel: string;
    inProfit: string;
    volume: string;
    trades: string;
    cost: string;
    maker: string;
    tagline: string;
    footer: string;
  },
): void {
  const money = (v: string) => formatAmount(v, null)?.text ?? v;
  const profit = !(Number(d.net) < 0);
  drawShare(canvas, {
    chip: `${d.strategyName} · ${d.market}`,
    heroLabel: profit ? text.inProfit : text.costLabel,
    hero: profit ? `+${money(d.net)}` : `$${money(d.costPerMillion ?? "0")}`,
    heroSuffix: profit ? "USDC" : null,
    heroColor: profit ? "#7ee2a8" : "#ffffff",
    stats: [
      [text.volume, `${money(Number(d.volume).toFixed(2))} USDC`],
      d.trades === null
        ? [text.cost, `${money(String(Math.max(0, -Number(d.net))))} USDC`]
        : [text.trades, String(d.trades)],
      [text.maker, d.makerSharePct === null ? "—" : `${d.makerSharePct}%`],
    ],
    tagline: text.tagline,
    footer: text.footer,
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Câu chia sẻ dạng chữ, đi kèm ảnh. */
export function shareText(d: VolumeShareData, t: (k: string, p: Record<string, string>) => string) {
  const money = (v: string) => formatAmount(v, null)?.text ?? v;
  const maker = d.makerSharePct ?? "—";
  return Number(d.net) < 0
    ? t("text", {
        volume: money(Number(d.volume).toFixed(2)),
        cost: money(d.costPerMillion ?? "0"),
        maker,
        strategy: d.strategyName,
      })
    : t("textProfit", {
        volume: money(Number(d.volume).toFixed(2)),
        net: money(d.net),
        maker,
        strategy: d.strategyName,
      });
}

const today = () =>
  new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

export function VolumeShare({ data }: { data: VolumeShareData }) {
  const t = useTranslations("agent.vf.share");
  const text = shareText(data, (k, p) => t(k, p));
  return (
    <ShareSheet
      title={t("title")}
      description={t("description")}
      fileName={`drift-${data.market.toLowerCase()}-volume.png`}
      text={text}
      draw={(c) => {
        drawVolumeShare(c, data, {
          costLabel: t("costLabel"),
          inProfit: t("inProfit"),
          volume: t("volume"),
          trades: t("trades"),
          cost: t("cost"),
          maker: t("maker"),
          tagline: t("tagline"),
          footer:
            data.period === undefined
              ? t("footer", { date: today() })
              : `${data.period} · ${t("footer", { date: today() })}`,
        });
      }}
    />
  );
}

/** Kết quả bot lãi / lỗ (Grid, DCA, Funding Arbitrage…, DEC-132): lãi ròng, % trên vốn, thời gian chạy, số lệnh khớp. */
export interface PnlShareData {
  botName: string;
  market: string;
  strategyName: string;
  /** Lãi ròng (đã chốt + chưa chốt, sau phí) theo `unit`. */
  net: string;
  unit: string;
  /** Vốn của bot theo `unit`; null thì không có % lợi nhuận. */
  capital: string | null;
  /** Ngày tạo bot (ISO): ảnh ghi "Since …" thay vì thời gian chạy, vì bot có thể đã dừng giữa chừng. */
  since: string;
  fills: number;
}

export function pnlRoi(d: Pick<PnlShareData, "net" | "capital">): number | null {
  const cap = d.capital === null ? 0 : Number(d.capital);
  return cap > 0 ? (Number(d.net) / cap) * 100 : null;
}

export function PnlShare({ data }: { data: PnlShareData }) {
  const t = useTranslations("agent.share");
  const money = (v: string) => formatAmount(v, null)?.text ?? v;
  const net = Number(data.net);
  const roi = pnlRoi(data);
  const sign = net > 0 ? "+" : net < 0 ? "−" : "";
  const abs = Math.abs(net);
  const netText = `${sign}${money(abs.toFixed(abs >= 1 || abs === 0 ? 2 : 4))}`;
  const roiText =
    roi === null ? "—" : `${roi > 0 ? "+" : roi < 0 ? "−" : ""}${Math.abs(roi).toFixed(2)}%`;
  const since = new Date(data.since).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const text = t(net >= 0 ? "text" : "textLoss", {
    strategy: data.strategyName,
    market: data.market,
    net: `${netText} ${data.unit}`,
    roi: roiText,
    since,
  });
  return (
    <ShareSheet
      title={t("title")}
      description={t("description")}
      fileName={`drift-${data.market.toLowerCase()}-result.png`}
      text={text}
      draw={(c) => {
        drawShare(c, {
          chip: `${data.strategyName} · ${data.market}`,
          heroLabel: t(net >= 0 ? "heroProfit" : "heroLoss"),
          hero: netText,
          heroSuffix: data.unit,
          heroColor: net >= 0 ? "#7ee2a8" : "#ffffff",
          stats: [
            [t("roi"), roiText],
            [t("since"), since],
            [t("fills"), String(data.fills)],
          ],
          tagline: t("tagline"),
          footer: t("footer", { date: today() }),
        });
      }}
    />
  );
}

function ShareSheet({
  title,
  description,
  fileName,
  text,
  draw,
}: {
  title: string;
  description: string;
  fileName: string;
  text: string;
  draw: (c: HTMLCanvasElement) => void;
}) {
  const t = useTranslations("agent.vf.share");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    if (!open) return;
    const c = canvas.current ?? document.createElement("canvas");
    canvas.current = c;
    drawRef.current(c);
    setUrl(c.toDataURL("image/png"));
  }, [open, text]);

  const toBlob = () =>
    new Promise<Blob | null>((resolve) => {
      canvas.current?.toBlob(resolve, "image/png");
    });
  const canShareFile =
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [new File([], fileName, { type: "image/png" })] });

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </Button>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row">
            {url === null ? null : (
              <a
                href={url}
                download={fileName}
                className="flex min-h-tap flex-1 items-center justify-center rounded-control bg-accent px-4 text-sm font-bold whitespace-nowrap text-white no-underline"
              >
                {t("download")}
              </a>
            )}
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true);
                  setTimeout(() => {
                    setCopied(false);
                  }, 2000);
                });
              }}
            >
              {copied ? t("copied") : t("copy")}
            </Button>
            {canShareFile ? (
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  void (async () => {
                    const blob = await toBlob();
                    if (blob === null) return;
                    await navigator
                      .share({ text, files: [new File([blob], fileName, { type: "image/png" })] })
                      .catch(() => undefined);
                  })();
                }}
              >
                {t("share")}
              </Button>
            ) : null}
          </div>
        }
      >
        {url === null ? null : (
          <img
            src={url}
            alt={text}
            width={W}
            height={H}
            className="h-auto w-full rounded-[14px] border border-border"
          />
        )}
        <p className="m-0 text-sm text-ink-2">{text}</p>
      </BottomSheet>
    </>
  );
}
