"use client";

import { BotState, botListSchema, NUMBER_FORMATS } from "@drift/shared";
import { Button, ConfirmDialog, Field, inputClassName } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { z } from "zod";

import { useBotErrorText } from "@/features/bots/components/bot-errors";
import { api } from "@/lib/api";
import { useMe, useSodexConnection } from "@/lib/queries";

import { ME_KEY } from "./security-tab";

// Settings › Trading defaults và Profile (SCREENS.md mục 8.5, DEC-42).

const ZONES = [
  "UTC",
  "Asia/Ho_Chi_Minh",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
];
const STOPPED: readonly string[] = [BotState.draft, BotState.stopped, BotState.archived];

function useSavePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("PUT", "/api/v1/me/preferences", z.unknown(), {
        idempotencyKey: crypto.randomUUID(),
        body,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function TradingDefaultsTab() {
  const t = useTranslations("settings.defaults");
  const me = useMe();
  const save = useSavePreferences();
  const errorText = useBotErrorText();
  const [maxLoss, setMaxLoss] = useState("");
  const [tz, setTz] = useState("UTC");
  const [fmt, setFmt] = useState<string>("en-US");
  useEffect(() => {
    if (me.data === undefined) return;
    setMaxLoss(me.data.defaultMaxLossPct ?? "");
    setTz(me.data.timezone);
    setFmt(me.data.numberFormat);
  }, [me.data]);
  const zones = ZONES.includes(tz) ? ZONES : [tz, ...ZONES];
  return (
    <form
      className="flex flex-col gap-4 rounded-card bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          timezone: tz,
          numberFormat: fmt,
          defaultMaxLossPct: maxLoss.trim() === "" ? null : maxLoss.trim(),
        });
      }}
    >
      <h2 className="m-0 text-lg font-extrabold">{t("title")}</h2>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-bold">{t("mode")}</span>
        <span>{t("modeValue")}</span>
        <span className="text-xs text-muted">{t("paper")}</span>
      </div>
      <Field label={t("maxLoss")} unit="%" hint={t("maxLossHint")}>
        {(p) => (
          <input
            {...p}
            className={inputClassName}
            inputMode="decimal"
            value={maxLoss}
            onChange={(e) => {
              setMaxLoss(e.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t("timezone")} hint={t("timezoneHint")}>
        {(p) => (
          <select
            {...p}
            className={inputClassName}
            value={tz}
            onChange={(e) => {
              setTz(e.target.value);
            }}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t("numberFormat")}>
        {(p) => (
          <select
            {...p}
            className={inputClassName}
            value={fmt}
            onChange={(e) => {
              setFmt(e.target.value);
            }}
          >
            {NUMBER_FORMATS.map((f) => (
              <option key={f} value={f}>
                {new Intl.NumberFormat(f, { minimumFractionDigits: 2 }).format(12345.67)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Button type="submit" className="self-start" pending={save.isPending}>
        {t("save")}
      </Button>
      {save.isSuccess ? (
        <p role="status" className="m-0 text-sm">
          {t("saved")}
        </p>
      ) : null}
      {save.error === null ? null : (
        <p role="alert" className="m-0 text-sm text-neg-ink">
          {errorText(save.error)}
        </p>
      )}
    </form>
  );
}

export function ProfileTab() {
  const t = useTranslations("settings.profile");
  const router = useRouter();
  const me = useMe();
  const bots = useQuery({
    queryKey: ["bots"],
    queryFn: () => api("GET", "/api/v1/bots", botListSchema),
  });
  const conn = useSodexConnection();
  const save = useSavePreferences();
  const errorText = useBotErrorText();
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  useEffect(() => {
    setName(me.data?.displayName ?? "");
  }, [me.data]);
  const remove = useMutation({
    mutationFn: () =>
      api("DELETE", "/api/v1/account", z.unknown(), {
        idempotencyKey: crypto.randomUUID(),
        body: { twoFactorCode: code },
      }),
    onSuccess: () => {
      router.push("/signin");
    },
  });
  const botsActive = (bots.data?.items ?? []).some((b) => !STOPPED.includes(b.state));
  const linked = conn.data?.connection != null && conn.data.connection.status !== "disconnected";
  const blocked = botsActive ? t("deleteBlockedBots") : linked ? t("deleteBlockedSodex") : null;
  return (
    <div className="flex flex-col gap-5">
      <form
        className="flex flex-col gap-4 rounded-card bg-surface p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ displayName: name.trim() === "" ? null : name.trim() });
        }}
      >
        <h2 className="m-0 text-lg font-extrabold">{t("title")}</h2>
        <Field label={t("name")}>
          {(p) => (
            <input
              {...p}
              className={inputClassName}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t("email")} hint={t("emailHint")}>
          {(p) => <input {...p} className={inputClassName} value={me.data?.email ?? ""} readOnly />}
        </Field>
        <Button type="submit" className="self-start" pending={save.isPending}>
          {t("save")}
        </Button>
        {save.isSuccess ? (
          <p role="status" className="m-0 text-sm">
            {t("saved")}
          </p>
        ) : null}
      </form>
      <section className="flex flex-col gap-2 rounded-card bg-surface p-5">
        <a href="/api/v1/account/export.csv" download className="font-bold">
          {t("export")}
        </a>
        <span className="text-xs text-muted">{t("exportHint")}</span>
      </section>
      <section className="flex flex-col gap-2 rounded-card border border-neg bg-surface p-5">
        <Button
          variant="danger"
          className="self-start"
          disabled={blocked !== null}
          onClick={() => {
            setOpen(true);
          }}
        >
          {t("delete")}
        </Button>
        {blocked === null ? null : <span className="text-sm text-ink-2">{blocked}</span>}
      </section>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("deleteTitle")}
        consequencesLabel={t("deleteTitle")}
        consequences={[t("deleteBody")]}
        confirmLabel={t("deleteConfirm")}
        cancelLabel={t("cancel")}
        tone="danger"
        twoFactor={{
          label: t("twoFactor"),
          value: code,
          onChange: setCode,
          ...(remove.error === null ? {} : { error: errorText(remove.error) }),
        }}
        pending={remove.isPending}
        onConfirm={() => {
          remove.mutate();
        }}
      />
    </div>
  );
}
