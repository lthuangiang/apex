"use client";

import { Switch } from "@drift/ui";
import { useTranslations } from "next-intl";

import { Card } from "@/components/workspace";
import { useFeatures } from "@/lib/queries";

import { useSetWealthWatch, useWealthWatch } from "../wealth-watch";

// Thẻ "Alerts" ở Portfolio › My Wealth (#594, DEC-404 mục 7; bản phác docs/mockups/us-market màn 05, PM gộp ba dòng
// thành một công tắc). Chỉ hiện khi `/features.wealthAlerts` (US Market bật và `WEALTH_WATCH_ENABLED`, hoặc role team) và
// `GET /api/v1/wealth/watch` không 404. Công tắc phản ánh trạng thái backend; lúc chờ hiện "Turning on…" / "Turning off…".

export function WealthAlertsCard() {
  const t = useTranslations("myWealth.alerts");
  const visible = useFeatures().data?.wealthAlerts === true;
  const watch = useWealthWatch(visible);
  const set = useSetWealthWatch();
  const state = watch.data;
  if (!visible || state == null) return null;
  const on = state.status === "active";
  const pending = set.isPending ? (set.variables ? t("turningOn") : t("turningOff")) : null;
  return (
    <Card title={t("title")}>
      <span className="self-start rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-extrabold text-ink-2">
        {t("channels")}
      </span>
      <Switch
        label={t("toggle")}
        description={pending ?? (on ? t("on") : t("off"))}
        checked={on}
        disabled={set.isPending}
        onCheckedChange={(next) => {
          set.mutate(next);
        }}
      />
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-2">
        <li>{t("settles")}</li>
        <li>{t("recurring")}</li>
      </ul>
      {on && state.delayed ? <p className="m-0 text-xs text-ink-2">{t("delayed")}</p> : null}
      {set.isError ? (
        <p role="alert" className="m-0 text-xs font-semibold text-neg-ink">
          {t("failed")}
        </p>
      ) : null}
      <p className="m-0 text-xs text-muted">{t("note")}</p>
    </Card>
  );
}
