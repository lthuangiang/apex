"use client";

import {
  disconnectResponseSchema,
  DRIFT_BUILDER_FEE_RATE,
  signatureRequestSchema,
  type SodexConnection,
} from "@drift/shared";
import { Button, ConfirmDialog, EmptyState, ErrorState, Skeleton } from "@drift/ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { api, ApiError } from "@/lib/api";
import { feeLabels, formatDate, formatDateTime, shortAddress } from "@/lib/format";
import { useSodexConnection } from "@/lib/queries";
import { useSodexSignature } from "@/lib/use-sodex-signature";

import { useMasterWallet } from "./master-wallet";

// Settings › SoDEX access (artboard "Desktop · Settings", tab SoDEX access; SCREENS.md mục 8.5).
// Trạng thái phí lấy từ lần đọc lại SoDEX của api, không suy ra từ nút đã bấm (quy tắc 1.6).

export const CONNECTION_KEY = ["sodex", "connection"] as const;

type Connected = NonNullable<SodexConnection["connection"]>;

export function SodexAccessTab() {
  const t = useTranslations("settings.sodexAccess");
  const tc = useTranslations("common.errors");
  const query = useSodexConnection();

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-56 rounded-card" />
        <Skeleton className="h-48 rounded-card" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title={tc("generic")}
        retryLabel={tc("retry")}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const connection = query.data.connection;
  if (connection === null) {
    return (
      <EmptyState
        title={t("notConnected")}
        action={
          <Link
            href="/onboarding/connect"
            className="inline-flex min-h-tap items-center rounded-control bg-accent px-5 text-sm font-bold text-surface no-underline"
          >
            {t("connectCta")}
          </Link>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <AccountCard connection={connection} />
      <FeeCard connection={connection} />
    </div>
  );
}

function AccountCard({ connection }: { connection: Connected }) {
  const t = useTranslations("settings.sodexAccess");
  const tm = useTranslations("common.missing");
  const key = connection.apiKey;
  const expired = key?.status === "expired";
  // Key còn hạn nhưng DRIFT không ký được (signer verify fail hoặc bot pause API_KEY_UNUSABLE, UI_REVIEW J2).
  const unusable = key?.status === "unusable";
  return (
    <section
      aria-labelledby="acc-h"
      className="flex flex-col gap-4 rounded-card bg-surface p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-11 items-center justify-center rounded-control bg-ink text-sm font-extrabold text-surface"
          >
            SX
          </span>
          <div className="flex flex-col">
            <h2 id="acc-h" className="m-0 text-base font-extrabold">
              {t("account", { id: connection.sodexAccountId })}
            </h2>
            <span className="text-[13px] text-muted tabular-nums">
              {t("masterWallet", { address: shortAddress(connection.address) })}
            </span>
          </div>
        </div>
        <span
          className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-bold whitespace-nowrap ${expired ? "bg-neg-bg text-neg-ink" : unusable ? "bg-warn-bg text-warn" : "bg-pos-bg text-pos"}`}
        >
          {expired ? t("keyExpiredPill") : unusable ? t("keyUnusablePill") : t("connected")}
        </span>
      </div>
      {unusable ? (
        <div
          role="alert"
          className="rounded-control border border-warn-bar bg-warn-bg px-3.5 py-3 text-sm font-semibold text-warn"
        >
          {t("keyUnusableBody")}
        </div>
      ) : null}
      {/* Ba ô nền xám bo góc (artboard Connections). */}
      <dl className="m-0 grid gap-2.5 sm:grid-cols-3">
        <div className="flex flex-col gap-1 rounded-[14px] bg-surface-2 px-3.5 py-3">
          <dt className="text-xs text-muted">{t("apiKey")}</dt>
          <dd className="m-0 font-bold tabular-nums">
            {key === null ? tm("notAvailable") : t("apiKeyValue", { last4: key.last4 })}
          </dd>
        </div>
        <div className="flex flex-col gap-1 rounded-[14px] bg-surface-2 px-3.5 py-3">
          <dt className="text-xs text-muted">{t("expires")}</dt>
          <dd className="m-0 font-bold tabular-nums">
            {key === null
              ? tm("notAvailable")
              : daysLeft(key.expiresAt) > 0
                ? t("expiresIn", {
                    date: formatDate(Date.parse(key.expiresAt)),
                    n: daysLeft(key.expiresAt),
                  })
                : formatDate(Date.parse(key.expiresAt))}
          </dd>
        </div>
        <div className="flex flex-col gap-1 rounded-[14px] bg-surface-2 px-3.5 py-3">
          <dt className="text-xs text-muted">{t("lastUsed")}</dt>
          <dd className="m-0 font-bold tabular-nums">
            {key === null
              ? tm("notAvailable")
              : key.lastUsedAt === null
                ? t("never")
                : formatDateTime(Date.parse(key.lastUsedAt))}
          </dd>
        </div>
      </dl>
      {expired ? (
        <div role="alert" className="rounded-control bg-neg-bg px-3.5 py-3 text-sm text-neg-ink">
          <strong>{t("keyExpiredTitle")}</strong> {t("keyExpiredBody")}
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-3">
        <Permission title={t("permRead")} sub={t("permReadSub")} ok />
        <Permission title={t("permTrade")} sub={t("permTradeSub")} ok />
        <Permission title={t("permWithdraw")} sub={t("permWithdrawSub")} ok={false} />
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <RenewButton connection={connection} primary={expired || unusable} />
        <DisconnectButton connection={connection} />
      </div>
    </section>
  );
}

/** Mở bước tiếp theo sau khi ví đúng master wallet đã kết nối; người dùng huỷ chọn ví thì không làm gì. */
function gated(ensure: () => Promise<void>, next: () => void) {
  return () => {
    ensure().then(next, () => undefined);
  };
}

const daysLeft = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);

/** "Renew key (sign again)…" (DEC-59): key mới, một chữ ký của master wallet; key cũ thôi được dùng. */
function RenewButton({ connection, primary }: { connection: Connected; primary: boolean }) {
  const t = useTranslations("settings.sodexAccess");
  const tc = useTranslations("common.errors");
  const tConnect = useTranslations("onboarding.connect");
  const queryClient = useQueryClient();
  const signAndSubmit = useSodexSignature();
  const wallet = useMasterWallet(connection.address);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function renew() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setOpen(false);
    setBusy(true);
    try {
      const request = await api(
        "POST",
        "/api/v1/sodex/connection/renewal",
        signatureRequestSchema,
        {
          idempotencyKey: crypto.randomUUID(),
        },
      );
      const outcome = await signAndSubmit(request);
      if (outcome.kind === "failed")
        setError(tConnect("errors.rejectedBySodex", { reason: outcome.request.sodexError ?? "" }));
      else if (outcome.kind !== "rejected") setDone(true);
    } catch {
      setError(tc("generic"));
    } finally {
      inFlight.current = false;
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: CONNECTION_KEY });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {busy ? (
        <p
          role="status"
          className="m-0 flex items-center gap-2.5 text-sm font-semibold text-accent-ink"
        >
          <span aria-hidden="true" className="size-2.5 animate-pulse rounded-full bg-accent" />
          {t("busyRenewing")}
        </p>
      ) : (
        <Button
          variant={primary ? "primary" : "tonal"}
          onClick={gated(wallet.ensure, () => {
            setOpen(true);
          })}
        >
          {t("renew")}
        </Button>
      )}
      {wallet.prompt}
      {done ? (
        <p role="status" className="m-0 text-sm font-semibold text-pos">
          {t("renewed")}
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="m-0 text-sm font-semibold text-neg-ink">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("renewDialog.title")}
        consequencesLabel={t("renewDialog.title")}
        consequences={[
          t("renewDialog.point1", { last4: connection.apiKey?.last4 ?? "" }),
          t("renewDialog.point2"),
          t("renewDialog.point3"),
          t("renewDialog.sign"),
        ]}
        confirmLabel={t("renewDialog.cta")}
        cancelLabel={t("renewDialog.cancel")}
        tone="primary"
        onConfirm={() => void renew()}
      />
    </div>
  );
}

/** "Disconnect…": dialog + 2FA, rồi master wallet ký xoá key ở Spot và Perps (DEC-31). */
function DisconnectButton({ connection }: { connection: Connected }) {
  const t = useTranslations("settings.sodexAccess");
  const tDialog = useTranslations("common.dialog");
  const ts = useTranslations("settings.security");
  const tc = useTranslations("common.errors");
  const tConnect = useTranslations("onboarding.connect");
  const queryClient = useQueryClient();
  const signAndSubmit = useSodexSignature();
  const wallet = useMasterWallet(connection.address);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [step, setStep] = useState<1 | 2 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function disconnect() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const { spot, perps } = await api(
        "POST",
        "/api/v1/sodex/disconnection",
        disconnectResponseSchema,
        {
          body: { twoFactorCode: code },
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setOpen(false);
      for (const [index, request] of [spot, perps].entries()) {
        setStep(index === 0 ? 1 : 2);
        const outcome = await signAndSubmit(request);
        if (outcome.kind === "rejected") return;
        if (outcome.kind === "failed") {
          setError(
            tConnect("errors.rejectedBySodex", { reason: outcome.request.sodexError ?? "" }),
          );
          return;
        }
      }
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.code === "TWO_FACTOR_INVALID" || e.code === "TWO_FACTOR_REQUIRED")
      ) {
        setCodeError(ts("errors.invalid"));
      } else {
        setOpen(false);
        setError(tc("generic"));
      }
    } finally {
      inFlight.current = false;
      setStep(null);
      setCode("");
      await queryClient.invalidateQueries({ queryKey: CONNECTION_KEY });
    }
  }

  return (
    <>
      {error === null ? null : (
        <p
          role="alert"
          className="m-0 rounded-control bg-neg-bg px-3.5 py-3 text-sm font-semibold text-neg-ink"
        >
          {error}
        </p>
      )}
      {step === null ? (
        <button
          type="button"
          className="flex min-h-tap items-center rounded-control border-[1.5px] border-neg bg-surface px-4 text-sm font-extrabold text-neg-ink"
          onClick={gated(wallet.ensure, () => {
            setOpen(true);
          })}
        >
          {t("disconnect")}
        </button>
      ) : (
        <p
          role="status"
          className="m-0 flex items-center gap-2.5 text-sm font-semibold text-accent-ink"
        >
          <span aria-hidden="true" className="size-2.5 animate-pulse rounded-full bg-accent" />
          {t("busyDisconnecting", { step })}
        </p>
      )}
      {wallet.prompt}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setCodeError(undefined);
        }}
        title={t("disconnectDialog.title", { id: connection.sodexAccountId })}
        consequencesLabel={tDialog("consequences")}
        consequences={[
          t("disconnectDialog.point1"),
          t("disconnectDialog.point2"),
          t("disconnectDialog.point3"),
          t("disconnectDialog.point4"),
          t("disconnectDialog.sign"),
        ]}
        confirmLabel={t("disconnectDialog.cta")}
        cancelLabel={t("disconnectDialog.cancel")}
        tone="danger"
        twoFactor={{
          label: ts("codePrompt"),
          value: code,
          onChange: (value) => {
            setCode(value);
            setCodeError(undefined);
          },
          ...(codeError === undefined ? {} : { error: codeError }),
        }}
        pending={step !== null}
        onConfirm={() => void disconnect()}
      />
    </>
  );
}

function Permission({ title, sub, ok }: { title: string; sub: string; ok: boolean }) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-tile p-3.5 ${ok ? "bg-pos-bg/50" : "bg-surface-2"}`}
    >
      <span className={`text-sm font-bold ${ok ? "text-pos" : "text-ink-2"}`}>{title}</span>
      <span className="text-xs text-muted">{sub}</span>
    </div>
  );
}

function FeeCard({ connection }: { connection: Connected }) {
  const t = useTranslations("settings.sodexAccess");
  const tc = useTranslations("common.errors");
  const tDialog = useTranslations("common.dialog");
  const ts = useTranslations("settings.security");
  const queryClient = useQueryClient();
  const signAndSubmit = useSodexSignature();
  const wallet = useMasterWallet(connection.address);
  const [busy, setBusy] = useState<"revoking" | "approving" | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const approved = connection.builderFee?.approved === true;
  const { pct } = feeLabels(DRIFT_BUILDER_FEE_RATE);

  async function run(kind: "revoking" | "approving", open: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setError(null);
    try {
      const request = signatureRequestSchema.parse(await open());
      setDialogOpen(false);
      const outcome = await signAndSubmit(request);
      if (outcome.kind === "failed") {
        const reason = outcome.request.sodexError ?? "";
        setError(/builder approvals/i.test(reason) ? t("removeOtherBuilder") : reason);
      }
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.code === "TWO_FACTOR_INVALID" || e.code === "TWO_FACTOR_REQUIRED")
      ) {
        setCodeError(ts("errors.invalid"));
      } else {
        setDialogOpen(false);
        setError(tc("generic"));
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
      setCode("");
      await queryClient.invalidateQueries({ queryKey: CONNECTION_KEY });
    }
  }

  const revoke = () =>
    run("revoking", () =>
      api("POST", "/api/v1/sodex/builder-fee/revocation", signatureRequestSchema, {
        body: { twoFactorCode: code },
        idempotencyKey: crypto.randomUUID(),
      }),
    );
  const approve = () =>
    run("approving", () =>
      api("POST", "/api/v1/sodex/builder-fee/approval", signatureRequestSchema, {
        idempotencyKey: crypto.randomUUID(),
      }),
    );

  const pill =
    busy !== null
      ? { text: t("feeUpdating"), cls: "bg-accent-tint text-accent-ink" }
      : approved
        ? { text: t("feeApproved"), cls: "bg-pos-bg text-pos" }
        : { text: t("feeRevoked"), cls: "bg-warn-bg text-warn" };

  // Account của chính builder: không thu phí, không có approve / revoke (DEC-47).
  if (connection.builderFee?.exempt === true) {
    return (
      <section
        aria-labelledby="fee-h"
        className="flex flex-col gap-2 rounded-card bg-surface p-5 shadow-sm"
      >
        <h2 id="fee-h" className="m-0 text-base font-extrabold">
          {t("feeTitle")}
        </h2>
        <p className="m-0 text-sm text-ink-2">{t("feeExempt")}</p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="fee-h"
      className="flex flex-col gap-4 rounded-card bg-surface p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="fee-h" className="m-0 text-base font-extrabold">
          {t("feeTitle")}
        </h2>
        <span
          className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-bold ${pill.cls}`}
        >
          {pill.text}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-2 tabular-nums">
        <span className="text-3xl font-extrabold">{approved ? pct : "0"}</span>
        {approved && connection.builderFee !== null ? (
          <span className="text-[13px] text-muted">
            {t("feeSubOn", { builderId: connection.builderFee.builderId })}
          </span>
        ) : null}
      </div>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-normal text-ink-2">
        <li>{t("feePoint1")}</li>
        <li>{t("feePoint2")}</li>
        <li>{t("feePoint3")}</li>
      </ul>
      {error === null ? null : (
        <p
          role="alert"
          className="m-0 rounded-control bg-neg-bg px-3.5 py-3 text-sm font-semibold text-neg-ink"
        >
          {error}
        </p>
      )}
      {busy !== null ? (
        <p
          role="status"
          className="m-0 flex items-center gap-2.5 text-sm font-semibold text-accent-ink"
        >
          <span aria-hidden="true" className="size-2.5 animate-pulse rounded-full bg-accent" />
          {busy === "revoking" ? t("busyRevoking") : t("busyApproving")}
        </p>
      ) : approved ? (
        <Button
          variant="danger"
          className="self-start"
          onClick={gated(wallet.ensure, () => {
            setDialogOpen(true);
          })}
        >
          {t("revokeFee")}
        </Button>
      ) : (
        <>
          <div role="alert" className="rounded-control bg-warn-bg px-3.5 py-3 text-sm text-warn">
            <strong>{t("feeOffTitle")}</strong> {t("feeOffBody")}
          </div>
          <Button className="self-start" onClick={gated(wallet.ensure, () => void approve())}>
            {t("approveAgain")}
          </Button>
        </>
      )}
      {wallet.prompt}
      <ConfirmDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          setCodeError(undefined);
        }}
        title={t("revokeDialog.title")}
        consequencesLabel={tDialog("consequences")}
        consequences={[
          t("revokeDialog.point1"),
          t("revokeDialog.point2"),
          t("revokeDialog.point3"),
          t("revokeDialog.sign"),
        ]}
        confirmLabel={t("revokeDialog.cta")}
        cancelLabel={t("revokeDialog.cancel")}
        tone="danger"
        twoFactor={{
          label: ts("codePrompt"),
          value: code,
          onChange: (value) => {
            setCode(value);
            setCodeError(undefined);
          },
          ...(codeError === undefined ? {} : { error: codeError }),
        }}
        pending={busy === "revoking"}
        onConfirm={() => void revoke()}
      />
    </section>
  );
}
