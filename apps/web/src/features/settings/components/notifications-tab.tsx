"use client";

import { notificationSettingsSchema, type NotificationGroup } from "@drift/shared";
import { Button, ComingSoonChip, Switch } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useNotifications } from "@/lib/queries";

// Settings › Notifications (SCREENS.md mục 8.5): nhóm "bot errors" luôn bật (switch khoá); kênh in-app và email.

export function NotificationsTab() {
  const t = useTranslations("settings.notifications");
  const tn = useTranslations("notifications");
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["notifications", "settings"],
    queryFn: () => api("GET", "/api/v1/notifications/settings", notificationSettingsSchema),
  });
  const list = useNotifications();
  const set = useMutation({
    mutationFn: (b: { group: NotificationGroup; channel: "in_app" | "email"; enabled: boolean }) =>
      api("PUT", "/api/v1/notifications/settings", notificationSettingsSchema, {
        idempotencyKey: crypto.randomUUID(),
        body: b,
      }),
    onSuccess: (data) => {
      qc.setQueryData(["notifications", "settings"], data);
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

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-card bg-surface p-5">
        <h2 className="m-0 text-lg font-extrabold">{t("title")}</h2>
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {(settings.data?.groups ?? []).map((g) => (
            <li key={g.group} className="flex flex-col gap-2 border-b border-border pb-3">
              <strong>{t(`groups.${g.group}`)}</strong>
              <div className="flex flex-wrap gap-4">
                {(["in_app", "email"] as const).map((c) => (
                  <Switch
                    key={c}
                    label={c === "in_app" ? t("inApp") : t("email")}
                    checked={g[c]}
                    {...(g.alwaysOn ? { disabled: true, disabledReason: t("alwaysOn") } : {})}
                    onCheckedChange={(enabled) => {
                      set.mutate({ group: g.group, channel: c, enabled });
                    }}
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
        <ComingSoonChip label={t("telegram")} className="self-start" />
      </section>

      <section className="flex flex-col gap-3 rounded-card bg-surface p-5">
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
              <span>{tn(`types.${n.type}`)}</span>
              <span className="text-muted tabular-nums">{formatDateTime(n.createdAt)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
