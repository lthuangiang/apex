"use client";

import {
  IN_APP_ONLY_GROUPS,
  notificationSettingsSchema,
  type NotificationChannel,
  type NotificationGroup,
} from "@drift/shared";
import { Button, Switch } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { z } from "zod";

import { TelegramChannel } from "@/features/notifications/components/telegram-channel";
import {
  maskEmail,
  SETTINGS_GROUP_ORDER,
  useTelegramLink,
} from "@/features/notifications/telegram";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useFeatures, useMe, useNotifications } from "@/lib/queries";

// Settings › Notifications (SCREENS.md mục 8.5, artboard NT-Settings, DEC-170): "Where we reach you" (In-app,
// Email, Telegram) và "What we tell you" (nhóm × kênh). Nhóm Bot problems luôn bật (switch khoá).

const SETTINGS_KEY = ["notifications", "settings"] as const;

export function NotificationsTab() {
  const t = useTranslations("settings.notifications");
  const tn = useTranslations("notifications");
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api("GET", "/api/v1/notifications/settings", notificationSettingsSchema),
  });
  const list = useNotifications();
  const me = useMe();
  // Nhóm Copy Trading chỉ có ý nghĩa khi tài khoản được bật AI Desk (DEC-163).
  const aiDesk = useFeatures().data?.aiDesk === true;
  // Cột Telegram chỉ hiện khi server bật Telegram (TELEGRAM_ENABLED).
  const telegramOn = useTelegramLink(false).data?.status !== "disabled";
  const set = useMutation({
    mutationFn: (b: { group: NotificationGroup; channel: NotificationChannel; enabled: boolean }) =>
      api("PUT", "/api/v1/notifications/settings", notificationSettingsSchema, {
        idempotencyKey: crypto.randomUUID(),
        body: b,
      }),
    onSuccess: (data) => {
      qc.setQueryData(SETTINGS_KEY, data);
    },
  });
  const readAll = useMutation({
    mutationFn: () =>
      api("POST", "/api/v1/notifications/all/read", z.unknown(), {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const groups = settings.data?.groups ?? [];
  const rows = SETTINGS_GROUP_ORDER.flatMap((g) => {
    const row = groups.find((x) => x.group === g);
    return row === undefined || (g === "copyTrading" && !aiDesk) ? [] : [row];
  });
  const channels: NotificationChannel[] = telegramOn
    ? ["in_app", "email", "telegram"]
    : ["in_app", "email"];
  const channelName = (c: NotificationChannel) =>
    c === "in_app" ? t("inApp") : c === "email" ? t("email") : t("telegramName");
  const cols = telegramOn
    ? "md:grid-cols-[minmax(0,1fr)_80px_80px_90px]"
    : "md:grid-cols-[minmax(0,1fr)_80px_80px]";

  return (
    <div className="flex flex-col gap-5">
      <section
        aria-labelledby="notif-where"
        className="flex flex-col gap-3.5 rounded-card border border-border bg-surface p-5 md:px-6"
      >
        <h2 id="notif-where" className="m-0 text-lg font-extrabold">
          {t("where.title")}
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          <ChannelCard
            icon={<Bell aria-hidden="true" size={20} />}
            name={t("inApp")}
            detail={t("where.inAppBody")}
            on={t("where.on")}
          />
          <ChannelCard
            icon={<Mail aria-hidden="true" size={20} />}
            name={t("email")}
            detail={me.data === undefined ? null : maskEmail(me.data.email)}
            on={t("where.on")}
          />
          <TelegramChannel groups={groups} aiDesk={aiDesk} />
        </div>
      </section>

      <section
        aria-labelledby="notif-what"
        className="flex flex-col gap-1.5 rounded-card border border-border bg-surface p-5 md:px-6"
      >
        <h2 id="notif-what" className="m-0 mb-1.5 text-lg font-extrabold">
          {t("what.title")}
        </h2>
        {settings.isError ? (
          <p role="alert" className="m-0 text-sm text-ink-2">
            {t("what.loadFailed")}
          </p>
        ) : null}
        <div role="table" aria-label={t("what.tableLabel")} className="flex flex-col">
          <div
            role="row"
            className={`hidden gap-2 py-1.5 text-[12.5px] font-extrabold text-muted md:grid ${cols}`}
          >
            <span role="columnheader">{t("what.type")}</span>
            {channels.map((c) => (
              <span key={c} role="columnheader">
                {channelName(c)}
              </span>
            ))}
          </div>
          {rows.map((g) => (
            <div
              key={g.group}
              role="row"
              className={`grid grid-cols-3 items-center gap-x-2 gap-y-2 border-t border-border py-3 ${cols}`}
            >
              <span role="cell" className="col-span-3 md:col-span-1">
                <b className="text-[14.5px]">{t(`what.rows.${g.group}.name`)}</b>
                <br />
                <span className="text-[12.5px] text-muted">{t(`what.rows.${g.group}.body`)}</span>
              </span>
              {channels.map((c) => {
                const label = t("what.cellLabel", {
                  row: t(`what.rows.${g.group}.name`),
                  channel: channelName(c),
                });
                const unavailable = c === "email" && IN_APP_ONLY_GROUPS.includes(g.group);
                return (
                  <span key={c} role="cell" className="flex flex-col items-start gap-1">
                    {/* Tên kênh hiện dưới 768px vì không có hàng tiêu đề cột. */}
                    <span
                      aria-hidden="true"
                      className="text-[11.5px] font-bold text-muted md:hidden"
                    >
                      {channelName(c)}
                    </span>
                    {unavailable ? (
                      <span className="text-xs text-muted">
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">{t("what.notAvailable", { row: label })}</span>
                      </span>
                    ) : (
                      <Switch
                        hideLabel
                        label={g.alwaysOn ? t("what.alwaysOnLabel", { row: label }) : label}
                        checked={g[c]}
                        disabled={g.alwaysOn || set.isPending}
                        onCheckedChange={(enabled) => {
                          set.mutate({ group: g.group, channel: c, enabled });
                        }}
                      />
                    )}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
        {set.isError ? (
          <p role="alert" className="m-0 text-xs font-semibold text-neg-ink">
            {t("what.saveFailed")}
          </p>
        ) : null}
        {telegramOn ? (
          <p className="m-0 mt-1.5 text-[12.5px] text-muted">{t("what.note")}</p>
        ) : null}
      </section>

      {/* Đích của "See all" trong panel chuông. */}
      <section id="all-notifications" className="flex flex-col gap-3 rounded-card bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-lg font-extrabold">{tn("title")}</h2>
          {list.data === undefined || list.data.unread === 0 ? null : (
            <Button
              variant="secondary"
              onClick={() => {
                readAll.mutate();
              }}
            >
              {tn("markAll")}
            </Button>
          )}
        </div>
        {list.data?.items.length === 0 ? (
          <p className="m-0 text-sm text-ink-2">{tn("none")}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {(list.data?.items ?? []).map((n) => (
            <li
              key={n.id}
              className={`flex justify-between gap-2 ${n.readAt === null ? "font-bold" : ""}`}
            >
              <span>
                {/* Bài thử tiền giả (DEC-105) ghi rõ "fake-money test". */}
                {n.data.paper === true && (n.type === "bot_paused" || n.type === "bot_stopped")
                  ? tn(`paperTypes.${n.type}`)
                  : tn(`types.${n.type}`)}
              </span>
              <span className="text-muted tabular-nums">{formatDateTime(n.createdAt)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ChannelCard({
  icon,
  name,
  detail,
  on,
}: {
  icon: ReactNode;
  name: string;
  detail: string | null;
  on: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[18px] bg-bg p-4">
      <span className="text-ink-2">{icon}</span>
      <b className="text-[15px]">{name}</b>
      {detail === null ? null : <span className="text-[13px] text-muted">{detail}</span>}
      <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-pos-bg px-2.5 py-0.5 text-xs font-extrabold text-pos">
        <span aria-hidden="true">●</span>
        {on}
      </span>
    </div>
  );
}
