"use client";

import { UserRole } from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useConnect, useConnection, useDisconnect, type Connector } from "wagmi";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { WalletPicker } from "@/features/onboarding/components/wallet-picker";
import { shortAddress } from "@/lib/format";
import { useFeatures, useMe } from "@/lib/queries";
import { connectWatched } from "@/lib/watch-wallet";

import { runAllProbes, type ProbeResult } from "../probes";
import type { FieldRow } from "../shape";
import { useRewardsAuth } from "../use-rewards-auth";

// Trang chẩn đoán SoDEX rewards (#547, chỉ team): đăng nhập bằng ví thật rồi đọc các endpoint ĐỌC của Rewards API, hiện
// tên trường · kiểu · giá trị mẫu (trường nhạy cảm chỉ hiện kiểu) để chốt các điểm [confirm]. Không bao giờ hiện token.
// Chạy được cả khi công tắc `REWARDS_ENABLED` tắt (DEC-397). Không có route trên sidebar; vào bằng URL.

export function RewardsDebugPage() {
  const me = useMe();
  if (me.data !== undefined && me.data.role !== UserRole.team) notFound();
  return (
    <Workspace current="sodexDebugger">
      {me.data === undefined ? <Skeleton className="h-40" /> : <Diagnostics />}
    </Workspace>
  );
}

function Diagnostics() {
  const t = useTranslations("rewardsDebug");
  const tr = useTranslations("rewards");
  const features = useFeatures();
  const auth = useRewardsAuth();
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [reading, setReading] = useState(false);

  async function readAll() {
    setReading(true);
    setResults([]);
    try {
      await runAllProbes(auth.authed, (r) => {
        setResults((prev) => [...prev, r]);
      });
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <PageHead title={t("title")} subtitle={t("subtitle")} />
      {features.data === undefined ? null : (
        <p className="m-0 text-sm text-ink-2">
          {features.data.sodexRewards ? t("switch.on") : t("switch.off")}
        </p>
      )}
      <Card>
        <SignInPanel auth={auth} />
        {auth.signedIn ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button pending={reading} onClick={() => void readAll()}>
              {reading ? t("reading") : t("read")}
            </Button>
            <Button variant="secondary" onClick={auth.signOut}>
              {tr("signOut")}
            </Button>
          </div>
        ) : null}
      </Card>
      {auth.signedIn ? (
        <Card title={t("claims")}>
          {auth.claims === null ? (
            <p className="m-0 text-sm text-ink-2">{t("claimsNone")}</p>
          ) : (
            <FieldTable rows={auth.claims} />
          )}
        </Card>
      ) : null}
      {results.map((r) => (
        <ProbeCard key={r.id} result={r} />
      ))}
    </div>
  );
}

function SignInPanel({ auth }: { auth: ReturnType<typeof useRewardsAuth> }) {
  const tr = useTranslations("rewards");
  const tc = useTranslations("onboarding.connect");
  const { isConnected } = useConnection();
  const { mutateAsync: connectAsync } = useConnect();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const [picking, setPicking] = useState(false);

  if (auth.sodexLoading) return <Skeleton className="h-10" />;
  if (auth.master === null)
    return <p className="m-0 text-sm font-semibold text-ink-2">{tr("notConnected")}</p>;
  const master = auth.master;

  // Ví chỉ được bật khi người dùng bấm (không tự bật ví).
  async function pick(connector: Connector) {
    if (isConnected) await disconnectAsync().catch(() => undefined);
    await connectWatched(connector, () => connectAsync({ connector })).catch(() => undefined);
    setPicking(false);
  }

  if (auth.signedIn)
    return (
      <p className="m-0 text-sm font-semibold text-ink">
        {tr("signedInAs", { address: shortAddress(master) })}
      </p>
    );

  const mismatch = auth.last?.kind === "wrong_wallet" ? auth.last.connected : null;
  const err = auth.error;
  return (
    <div className="flex flex-col gap-3">
      {auth.expired ? (
        <div role="status" className="flex flex-col gap-1">
          <p className="m-0 text-sm font-bold text-ink">{tr("expired.title")}</p>
          <p className="m-0 text-sm text-ink-2">{tr("expired.body")}</p>
        </div>
      ) : null}
      {mismatch === null ? null : (
        <div role="alert" className="flex flex-col gap-1">
          <p className="m-0 text-sm font-bold text-neg-ink">{tr("mismatch.title")}</p>
          <p className="m-0 text-sm text-ink-2">
            {tr("mismatch.connected")} {shortAddress(mismatch)} · {tr("mismatch.account")}{" "}
            {shortAddress(master)}. {tr("mismatch.switch", { address: shortAddress(master) })}
          </p>
        </div>
      )}
      {auth.last?.kind === "rejected" ? (
        <p className="m-0 text-sm text-ink-2">{tr("signIn.rejected")}</p>
      ) : null}
      {err === null ? null : (
        <p role="alert" className="m-0 text-sm font-semibold text-neg-ink">
          {err.kind === "rate_limited"
            ? err.retryAfterSec === null
              ? tr("errors.busyNoTime")
              : tr("errors.busy", { s: err.retryAfterSec })
            : err.kind === "business"
              ? `${tr("errors.business")} ${tr("errors.said")} “${err.sodexMessage ?? ""}”`
              : `${tr("errors.network")} ${tr("errors.networkBody")}`}
        </p>
      )}
      {auth.phase === "signing" ? (
        <p role="status" className="m-0 text-sm font-semibold text-ink">
          {tr("signIn.checkWallet")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button pending={auth.phase === "signing"} onClick={() => void auth.signIn()}>
          {auth.expired ? tr("expired.action") : tr("signIn.sign")}
        </Button>
        {auth.connected === undefined || mismatch !== null ? (
          <Button
            variant="secondary"
            onClick={() => {
              setPicking(true);
            }}
          >
            {auth.connected === undefined ? tc("connectWallet") : tr("mismatch.choose")}
          </Button>
        ) : null}
      </div>
      {picking ? <WalletPicker onPick={(c) => void pick(c)} /> : null}
    </div>
  );
}

function ProbeCard({ result: r }: { result: ProbeResult }) {
  const t = useTranslations("rewardsDebug");
  const tr = useTranslations("rewards");
  return (
    <Card title={r.id}>
      <p className="m-0 text-xs font-bold tracking-wide text-muted uppercase">
        {r.auth ? t("wallet") : t("public")}
      </p>
      {r.outcome === "ok" ? (
        r.schemaIssues === null ? (
          <p className="m-0 text-sm font-semibold text-pos">{t("schemaOk")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="m-0 text-sm font-semibold text-neg-ink">{t("schemaFail")}</p>
            <ul className="m-0 pl-5 font-mono text-xs text-ink-2">
              {r.schemaIssues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )
      ) : (
        <p role="alert" className="m-0 text-sm font-semibold text-neg-ink">
          {t(`outcome.${r.outcome}`, { status: r.status })}
          {r.outcome === "rate_limited" && r.retryAfterSec !== null
            ? ` · ${t("retryAfter", { s: r.retryAfterSec })}`
            : ""}
          {r.sodexMessage === null ? "" : ` · ${tr("errors.said")} “${r.sodexMessage}”`}
        </p>
      )}
      {r.enums === null ? null : (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-xs font-bold tracking-wide text-muted uppercase">
            {t("valuesSeen")}
          </p>
          <ul className="m-0 pl-5 font-mono text-xs text-ink-2">
            {r.enums.map((e) => (
              <li key={e.field}>
                {e.field}: {e.values.join(" | ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.rows === null ? null : <FieldTable rows={r.rows} />}
    </Card>
  );
}

function FieldTable({ rows }: { rows: readonly FieldRow[] }) {
  const t = useTranslations("rewardsDebug");
  if (rows.length === 0) return <p className="m-0 text-sm text-ink-2">{t("empty")}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-border text-muted">
            <th scope="col" className="py-1.5 pr-3 font-bold">
              {t("cols.field")}
            </th>
            <th scope="col" className="py-1.5 pr-3 font-bold">
              {t("cols.type")}
            </th>
            <th scope="col" className="py-1.5 font-bold">
              {t("cols.sample")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path} className="border-b border-border last:border-0">
              <td className="py-1.5 pr-3 font-mono break-all text-ink">{row.path}</td>
              <td className="py-1.5 pr-3 font-mono text-ink-2">{row.types.join(" | ")}</td>
              <td className="py-1.5 font-mono break-all text-ink-2">
                {row.hidden ? t("hidden") : (row.sample ?? "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
