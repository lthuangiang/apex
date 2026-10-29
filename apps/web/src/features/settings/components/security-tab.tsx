"use client";

import {
  backupCodesSchema,
  sessionListSchema,
  twoFactorSetupSchema,
  type TwoFactorSetup,
} from "@drift/shared";
import { Button, ErrorState, inputClassName, Skeleton } from "@drift/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";

import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/queries";

// Settings › Security (artboard "Desktop · Settings", tab Security). Không có dòng "Wallet · Primary"
// vì DRIFT không đăng nhập bằng ví (DEC-28, DEC-31).

export const ME_KEY = ["me"] as const;
const SESSIONS_KEY = ["security", "sessions"] as const;

export function SecurityTab() {
  return (
    <div className="flex flex-col gap-4">
      <TwoFactorCard />
      <SessionsCard />
    </div>
  );
}

type Enroll =
  | { step: 1; setup: TwoFactorSetup; qr: string }
  | { step: 2; setup: TwoFactorSetup }
  | { step: 3; codes: string[] };

function TwoFactorCard() {
  const t = useTranslations("settings.security");
  const tc = useTranslations("common.errors");
  const queryClient = useQueryClient();
  const codeId = useId();
  const me = useMe();
  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  async function guarded(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "TWO_FACTOR_INVALID"
          ? t("errors.invalid")
          : tc("generic"),
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const start = () =>
    guarded(async () => {
      const setup = await api("POST", "/api/v1/security/2fa/setup", twoFactorSetupSchema, {
        idempotencyKey: crypto.randomUUID(),
      });
      const qr = await QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 168 });
      setEnroll({ step: 1, setup, qr });
    });

  const verify = () =>
    guarded(async () => {
      const { backupCodes } = await api("POST", "/api/v1/security/2fa/enable", backupCodesSchema, {
        body: { code },
        idempotencyKey: crypto.randomUUID(),
      });
      setEnroll({ step: 3, codes: backupCodes });
      setCode("");
    });

  if (me.isPending) return <Skeleton className="h-56 rounded-card" />;
  if (me.isError)
    return (
      <ErrorState
        title={tc("generic")}
        retryLabel={tc("retry")}
        onRetry={() => void me.refetch()}
      />
    );

  const on = me.data.twoFactorEnabled && enroll?.step !== 3;
  const currentStep = enroll?.step ?? 0;

  return (
    <section
      aria-labelledby="tfa-h"
      className="flex flex-col gap-4 rounded-card bg-surface p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="tfa-h" className="m-0 text-base font-extrabold">
          {t("tfaTitle")}
        </h2>
        <span
          className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-bold ${me.data.twoFactorEnabled ? "bg-pos-bg text-pos" : "bg-warn-bg text-warn"}`}
        >
          {me.data.twoFactorEnabled ? t("tfaOn") : t("tfaNotSet")}
        </span>
      </div>
      <p className="m-0 text-sm leading-relaxed text-ink-2">{t("tfaBody")}</p>
      {on ? (
        <div role="status" className="rounded-control bg-pos-bg px-3.5 py-3 text-sm text-pos">
          <strong>{t("enabledTitle")}</strong> {t("enabledBody")}
        </div>
      ) : (
        <>
          <ol className="m-0 grid list-none gap-2 p-0 sm:grid-cols-3">
            {(["scan", "code", "backup"] as const).map((key, i) => {
              const n = i + 1;
              const active = n === currentStep;
              const done = n < currentStep;
              return (
                <li
                  key={key}
                  aria-current={active ? "step" : undefined}
                  className={`flex items-center gap-2 rounded-control border-[1.5px] px-3 py-2.5 text-[13px] font-bold ${active ? "border-accent bg-accent-tint" : "border-transparent bg-surface-2"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex size-6 flex-none items-center justify-center rounded-full text-xs font-extrabold ${active ? "bg-accent text-surface" : done ? "bg-pos-bg text-pos" : "bg-border text-ink-2"}`}
                  >
                    {done ? "✓" : n}
                  </span>
                  {t(`steps.${key}`)}
                </li>
              );
            })}
          </ol>
          {error === null ? null : (
            <p
              role="alert"
              className="m-0 rounded-control bg-neg-bg px-3.5 py-3 text-sm font-semibold text-neg-ink"
            >
              {error}
            </p>
          )}
          {enroll === null ? (
            <Button className="self-start" pending={pending} onClick={() => void start()}>
              {t("start")}
            </Button>
          ) : null}
          {enroll?.step === 1 ? (
            <>
              <div className="flex flex-wrap items-center gap-4">
                <img
                  src={enroll.qr}
                  alt={t("qrLabel")}
                  width={168}
                  height={168}
                  className="rounded-tile border border-border"
                />
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="text-sm text-ink-2">{t("scanHint")}</span>
                  <code className="break-all rounded-control bg-surface-2 px-3 py-2 font-mono text-sm font-bold tracking-wider">
                    {enroll.setup.secret.replace(/(.{4})/g, "$1 ").trim()}
                  </code>
                </div>
              </div>
              <Button
                className="self-start"
                onClick={() => {
                  setEnroll({ step: 2, setup: enroll.setup });
                }}
              >
                {t("next")}
              </Button>
            </>
          ) : null}
          {enroll?.step === 2 ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <label htmlFor={codeId} className="flex max-w-xs flex-col gap-1.5">
                <span className="text-[13px] font-bold">{t("codeLabel")}</span>
                <input
                  id={codeId}
                  className={inputClassName}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, ""));
                  }}
                />
              </label>
              <Button
                type="submit"
                className="self-start"
                pending={pending}
                disabled={code.length !== 6}
              >
                {t("verify")}
              </Button>
            </form>
          ) : null}
        </>
      )}
      {enroll?.step === 3 ? (
        <>
          <p className="m-0 text-sm text-ink-2">{t("backupHint")}</p>
          <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 font-mono text-sm font-bold sm:grid-cols-5">
            {enroll.codes.map((c) => (
              <li key={c} className="rounded-control bg-surface-2 px-3 py-2 text-center">
                {c}
              </li>
            ))}
          </ul>
          <Button
            className="self-start"
            onClick={() => {
              setEnroll(null);
              void queryClient.invalidateQueries({ queryKey: ME_KEY });
            }}
          >
            {t("backupDone")}
          </Button>
        </>
      ) : null}
    </section>
  );
}

function SessionsCard() {
  const t = useTranslations("settings.security");
  const tc = useTranslations("common.errors");
  const queryClient = useQueryClient();
  const me = useMe();
  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => api("GET", "/api/v1/security/sessions", sessionListSchema),
  });
  const [signingOut, setSigningOut] = useState<string | null>(null);

  useEffect(() => {
    if (signingOut === null) return;
    void api("DELETE", `/api/v1/security/sessions/${signingOut}`, z.null(), {
      idempotencyKey: crypto.randomUUID(),
    })
      .catch(() => undefined)
      .finally(() => {
        setSigningOut(null);
        void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      });
  }, [signingOut, queryClient]);

  return (
    <section
      aria-labelledby="ses-h"
      className="flex flex-col gap-3 rounded-card bg-surface p-5 shadow-sm"
    >
      <h2 id="ses-h" className="m-0 text-base font-extrabold">
        {t("sessionsTitle")}
      </h2>
      {sessions.isPending || me.isPending ? (
        <Skeleton className="h-32 rounded-tile" />
      ) : sessions.isError || me.isError ? (
        <ErrorState
          title={tc("generic")}
          retryLabel={tc("retry")}
          onRetry={() => void sessions.refetch()}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          <li className="flex min-h-tap flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-sm">
            <span>
              <strong>{t("email")}</strong> {me.data.email}
            </span>
            <span className="text-xs font-bold text-pos">{t("verified")}</span>
          </li>
          {sessions.data.items.map((s) => (
            <li
              key={s.id}
              className="flex min-h-tap flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-sm last:border-b-0"
            >
              <span className="min-w-0 break-words">
                {[s.userAgent, s.ip, formatDate(Date.parse(s.lastSeenAt))]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {s.current ? (
                <span className="text-xs font-bold text-accent-ink">{t("current")}</span>
              ) : (
                <Button
                  variant="secondary"
                  pending={signingOut === s.id}
                  onClick={() => {
                    setSigningOut(s.id);
                  }}
                >
                  {t("signOut")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
