"use client";

import type { NotificationGroup, TelegramLinkCreated } from "@drift/shared";
import { BottomSheet, Button, ComingSoonChip, ConfirmDialog } from "@drift/ui";
import { Check, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useEffect, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/queries";

import {
  formatCountdown,
  telegramGroupsOn,
  testErrorKey,
  useCreatedTelegramLink,
  useCreateTelegramLink,
  useDeleteTelegramLink,
  useSendTelegramTest,
  useTelegramLink,
} from "../telegram";

// Thẻ Telegram trong "Where we reach you" (artboard NT-Settings, 4 trạng thái) và hộp thoại kết nối
// (NT-Connect). Mọi trạng thái lấy từ backend (CLAUDE.md quy tắc 1.6); "Send a test" gọi /telegram/test (N3).

const bold = (chunks: ReactNode) => <b>{chunks}</b>;

/** Giờ hiện tại, cập nhật mỗi giây khi `active` (đếm ngược thời hạn link). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return now;
}

export function TelegramChannel({
  groups,
  aiDesk,
}: {
  groups: readonly { group: NotificationGroup; telegram: boolean }[];
  aiDesk: boolean;
}) {
  const t = useTranslations("settings.notifications.telegramCard");
  const tc = useTranslations("settings.notifications");
  const me = useMe();
  const timeZone = me.data?.timezone ?? "Asia/Ho_Chi_Minh";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const create = useCreateTelegramLink();
  const remove = useDeleteTelegramLink();
  // Link tạo trong phiên này (chỉ trong bộ nhớ), để "Show link again" mở lại đúng link.
  const link = useCreatedTelegramLink();

  const query = useTelegramLink(dialogOpen);
  const status = query.data;
  const now = useNow(dialogOpen || status?.status === "pending");

  const date = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(
      new Date(iso),
    );

  const startConnect = () => {
    create.mutate(undefined, {
      onSuccess: () => {
        setDialogOpen(true);
      },
    });
  };
  // Còn link trong bộ nhớ và chưa hết hạn: mở lại đúng link đó. Không còn (đã tải lại trang): tạo link mới
  // (server huỷ token cũ), đếm lại 10 phút.
  const showAgain = () => {
    if (link !== null && Date.parse(link.expiresAt) > Date.now()) setDialogOpen(true);
    else startConnect();
  };
  const createError =
    create.error === null
      ? null
      : create.error instanceof ApiError && create.error.code === "RATE_LIMITED"
        ? t("errors.rateLimited")
        : t("errors.link");

  if (status?.status === "disabled") return <DisabledCard label={tc("telegram")} />;

  let body: ReactNode;
  if (status === undefined) {
    body = query.isError ? (
      <p role="alert" className="m-0 text-[13px] text-ink-2">
        {t("errors.status")}
      </p>
    ) : (
      <p className="m-0 text-[13px] text-muted">{t("loading")}</p>
    );
  } else if (status.status === "active") {
    body = (
      <>
        <span className="text-[13px]">
          {status.username == null
            ? t("connectedNoUsername", { date: date(status.connectedAt ?? "") })
            : t.rich("connectedAs", {
                username: status.username,
                date: date(status.connectedAt ?? ""),
                b: bold,
              })}
        </span>
        <SendTest short />
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            className="min-h-9 text-[13px] text-neg-ink"
            pending={remove.isPending}
            onClick={() => {
              setConfirmOff(true);
            }}
          >
            {remove.isPending ? t("disconnecting") : t("disconnect")}
          </Button>
        </div>
      </>
    );
  } else if (status.status === "blocked") {
    body = (
      <>
        <Chip tone="warn" glyph="▲">
          {t("blocked")}
        </Chip>
        <span className="text-[13px] leading-normal">
          {t("blockedBody", { date: date(status.blockedAt ?? status.connectedAt ?? "") })}
        </span>
        <Button
          variant="secondary"
          className="min-h-9 self-start text-[13px]"
          pending={create.isPending}
          onClick={startConnect}
        >
          {t("connectAgain")}
        </Button>
      </>
    );
  } else if (status.status === "pending") {
    const left = Date.parse(status.expiresAt ?? "") - now;
    body = (
      <>
        <Chip tone="accent" glyph="◌">
          {t("waiting")}
        </Chip>
        <span className="text-[13px] leading-normal text-ink-2">
          {t.rich("waitingBody", { time: formatCountdown(left), b: bold })}
        </span>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            className="min-h-9 text-[13px]"
            pending={create.isPending}
            disabled={remove.isPending}
            onClick={showAgain}
          >
            {create.isPending ? t("gettingLink") : t("showAgain")}
          </Button>
          <Button
            variant="secondary"
            className="min-h-9 text-[13px]"
            pending={remove.isPending}
            disabled={create.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            {remove.isPending ? t("cancelling") : t("cancel")}
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Chip tone="muted">{t("notConnected")}</Chip>
        <b className="text-[15px]">{t("getAlerts")}</b>
        <span className="text-[13px] leading-normal text-ink-2">{t("getAlertsBody")}</span>
        <Button className="self-start" pending={create.isPending} onClick={startConnect}>
          {create.isPending ? t("gettingLink") : t("connect")}
        </Button>
      </>
    );
  }

  return (
    <div
      className={`flex flex-col gap-1.5 rounded-[18px] p-4 ${
        status?.status === "active"
          ? "border-[1.5px] border-accent bg-accent-tint"
          : status?.status === "blocked"
            ? "border border-warn-bar bg-surface"
            : "bg-bg"
      }`}
    >
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-full bg-accent text-white"
      >
        <Send size={14} />
      </span>
      <b className="text-[15px]">{t("name")}</b>
      {body}
      {createError === null ? null : (
        <p role="alert" className="m-0 text-xs font-semibold text-neg-ink">
          {createError}
        </p>
      )}
      <ConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        link={link}
        status={status}
        now={now}
        groups={groups}
        aiDesk={aiDesk}
        renewing={create.isPending}
        onRenew={startConnect}
      />
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        tone="danger"
        title={t("disconnectDialog.title")}
        consequencesLabel={t("disconnectDialog.consequencesLabel")}
        consequences={[
          t("disconnectDialog.stop"),
          t("disconnectDialog.lastMessage"),
          t("disconnectDialog.stillHere"),
        ]}
        confirmLabel={t("disconnectDialog.confirm")}
        cancelLabel={t("disconnectDialog.cancel")}
        pending={remove.isPending}
        pendingLabel={t("disconnecting")}
        {...(remove.isError ? { error: t("errors.disconnect") } : {})}
        onConfirm={() => {
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirmOff(false);
            },
          });
        }}
      />
    </div>
  );
}

/**
 * "Send a test" (thẻ Connected, artboard NT-Settings) và "Send a test message" (Step 2, NT-Connect). Kết quả hiện
 * ngay dưới nút; không tự gửi lại.
 */
function SendTest({ short = false }: { short?: boolean }) {
  const t = useTranslations("settings.notifications.test");
  const send = useSendTelegramTest();
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant={short ? "secondary" : "primary"}
        className={short ? "min-h-9 self-start text-[13px]" : "self-start"}
        pending={send.isPending}
        onClick={() => {
          send.mutate();
        }}
      >
        {send.isPending ? t("sending") : short ? t("send") : t("sendLong")}
      </Button>
      <p role="status" className="m-0 text-[13px] text-ink-2">
        {send.isSuccess ? t("sent") : send.isError ? t(`errors.${testErrorKey(send.error)}`) : null}
      </p>
    </div>
  );
}

function DisabledCard({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[18px] bg-bg p-4">
      <ComingSoonChip label={label} className="self-start" />
    </div>
  );
}

function Chip({
  tone,
  glyph,
  children,
}: {
  tone: "muted" | "accent" | "warn" | "pos";
  glyph?: string;
  children: ReactNode;
}) {
  const cls = {
    muted: "bg-surface-2 text-ink-2",
    accent: "bg-accent-tint text-accent-ink",
    warn: "bg-warn-bg text-warn",
    pos: "bg-pos-bg text-pos",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-0.5 text-xs font-extrabold ${cls}`}
    >
      {glyph === undefined ? null : <span aria-hidden="true">{glyph}</span>}
      {children}
    </span>
  );
}

function ConnectDialog({
  open,
  onOpenChange,
  link,
  status,
  now,
  groups,
  aiDesk,
  renewing,
  onRenew,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  link: TelegramLinkCreated | null;
  status: ReturnType<typeof useTelegramLink>["data"];
  now: number;
  groups: readonly { group: NotificationGroup; telegram: boolean }[];
  aiDesk: boolean;
  renewing: boolean;
  onRenew: () => void;
}) {
  const t = useTranslations("settings.notifications.connect");
  const [qr, setQr] = useState<string | null>(null);
  const deepLink = link?.deepLink ?? null;
  useEffect(() => {
    if (deepLink === null) {
      setQr(null);
      return;
    }
    let live = true;
    QRCode.toDataURL(deepLink, { margin: 1, width: 150 })
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        if (live) setQr(null);
      });
    return () => {
      live = false;
    };
  }, [deepLink]);

  const connected = status?.status === "active";
  const left = link === null ? 0 : Date.parse(link.expiresAt) - now;
  const expired = !connected && left <= 0;
  const on = telegramGroupsOn(groups, aiDesk);

  let content: ReactNode;
  let title: string;
  if (connected) {
    title = t("connectedTitle");
    content = (
      <>
        <span className="text-xs font-extrabold tracking-[0.08em] text-pos uppercase">
          {t("step2")}
        </span>
        <div className="flex items-center gap-3.5">
          <span
            aria-hidden="true"
            className="flex size-[52px] shrink-0 items-center justify-center rounded-full bg-pos-bg text-pos"
          >
            <Check size={26} />
          </span>
          <span className="text-sm text-muted">
            {status.username == null
              ? t("alertsGoToNoUsername")
              : t.rich("alertsGoTo", {
                  username: status.username,
                  b: (c) => <b className="text-ink">{c}</b>,
                })}
          </span>
        </div>
        <div className="flex flex-col gap-2 rounded-tile bg-bg px-4 py-3.5 text-sm">
          <b>{t("youGet")}</b>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {on.map((g) => (
              <li key={g}>
                <span aria-hidden="true">✓ </span>
                {t(`items.${g}`)}
                {g === "botErrors" ? <span className="text-muted"> {t("always")}</span> : null}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="self-start border-none bg-transparent p-0 text-[13px] font-bold text-accent-ink"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t("change")}
          </button>
        </div>
        <SendTest />
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t("done")}
        </Button>
      </>
    );
  } else if (expired) {
    title = t("expiredTitle");
    content = (
      <>
        <span className="inline-flex self-start rounded-full bg-neg-bg px-2.5 py-0.5 text-xs font-extrabold text-neg-ink">
          {t("expiredChip")}
        </span>
        <p className="m-0 text-sm leading-normal text-ink-2">{t("expiredBody")}</p>
        <Button className="self-start" pending={renewing} onClick={onRenew}>
          {renewing ? t("gettingLink") : t("newLink")}
        </Button>
      </>
    );
  } else {
    title = t("title");
    content = (
      <>
        <span className="text-xs font-extrabold tracking-[0.08em] text-accent-ink uppercase">
          {t("step1")}
        </span>
        <p className="m-0 text-[15px] leading-normal text-ink-2">{t.rich("body", { b: bold })}</p>
        <div className="flex flex-col items-start gap-5 rounded-[20px] bg-bg p-[18px] sm:flex-row sm:items-center">
          <div className="flex size-[150px] shrink-0 items-center justify-center rounded-[14px] border border-border bg-surface">
            {qr === null ? null : (
              // Ảnh QR sinh tại chỗ (data URL) từ deep link, như QR 2FA ở security-tab.
              <img
                src={qr}
                alt={t("qrLabel")}
                width={150}
                height={150}
                className="rounded-[14px]"
              />
            )}
          </div>
          <div className="flex flex-col gap-2.5">
            <b className="text-[15px]">{t("onPhone")}</b>
            {deepLink === null ? null : (
              <a
                href={deepLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-tap items-center justify-center self-start rounded-control bg-accent px-[18px] text-sm font-extrabold text-white no-underline"
              >
                {t("open")}
              </a>
            )}
            <span className="text-[13px] leading-normal text-muted">{t("onComputer")}</span>
          </div>
        </div>
        <div className="flex items-center gap-2.5 rounded-control bg-accent-tint px-3.5 py-3 text-[13.5px]">
          <span
            aria-hidden="true"
            className="size-[18px] shrink-0 animate-spin rounded-full border-[3px] border-accent-tint border-t-accent motion-reduce:animate-none"
          />
          <span role="status">
            {t("waiting")}{" "}
            <span className="text-muted tabular-nums">
              {t("worksFor", { time: formatCountdown(left) })}
            </span>
          </span>
        </div>
        <ul className="m-0 flex flex-col gap-1 pl-[18px] text-[13px] leading-relaxed text-ink-2">
          <li>{t("safety1")}</li>
          <li>{t("safety2")}</li>
        </ul>
      </>
    );
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title={title} closeLabel={t("close")}>
      {content}
    </BottomSheet>
  );
}
