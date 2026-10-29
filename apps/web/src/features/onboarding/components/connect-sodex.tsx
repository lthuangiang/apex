"use client";

import {
  DRIFT_BUILDER_FEE_RATE,
  signatureRequestSchema,
  sodexConnectionSchema,
  type SignatureRequest,
  type SodexConnection,
} from "@drift/shared";
import { Button, WalletSignaturePreview } from "@drift/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useConnect, useConnection, useDisconnect, type Connector } from "wagmi";

import { api, ApiError } from "@/lib/api";
import { feeLabels, formatDate, shortAddress } from "@/lib/format";
import { useSodexSignature } from "@/lib/use-sodex-signature";

import { StepHeading } from "./onboarding-shell";
import { WalletPicker } from "./wallet-picker";

// Onboarding 2 theo DEC-25 / DEC-31: hai chữ ký master wallet (key rồi phí). Trạng thái chỉ đổi
// sang "done" khi api xác nhận đã ĐỌC LẠI từ SoDEX (quy tắc 1.6). Không tự gửi lại khi không rõ kết quả.

type Phase =
  | { kind: "start" }
  | { kind: "review"; request: SignatureRequest; which: "key" | "fee"; rejected: boolean }
  | { kind: "signing"; request: SignatureRequest; which: "key" | "fee" }
  | { kind: "creating"; which: "key" | "fee"; unknown: boolean }
  | { kind: "done"; connection: NonNullable<SodexConnection["connection"]> };

export function ConnectSodex() {
  const t = useTranslations("onboarding.connect");
  const tc = useTranslations("common.errors");
  const tCommon = useTranslations("common");
  const { isConnected } = useConnection();
  const { mutateAsync: connectAsync } = useConnect();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const signAndSubmit = useSodexSignature();

  const [phase, setPhase] = useState<Phase>({ kind: "start" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Mở lại trang khi key đã có nhưng phí chưa approve: đi thẳng tới chữ ký 2.
  useEffect(() => {
    void api("GET", "/api/v1/sodex/connection", sodexConnectionSchema)
      .then(({ connection }) => {
        if (connection?.status !== "connected") return;
        if (connection.builderFee?.approved === true) setPhase({ kind: "done", connection });
      })
      .catch(() => undefined);
  }, []);

  const describe = (e: unknown): string => {
    if (!(e instanceof ApiError)) return tc("generic");
    const messages: Partial<Record<ApiError["code"], string>> = {
      SODEX_ACCOUNT_NOT_FOUND: t("errors.accountNotFound"),
      SODEX_ACCOUNT_IN_USE: t("errors.accountInUse"),
      SIGNATURE_INVALID: t("errors.signatureInvalid"),
      RATE_LIMITED: tc("rateLimited"),
      NETWORK: tc("network"),
    };
    if (e.code === "FORBIDDEN" && e.details.reason === "connect_disabled")
      return t("errors.disabled");
    return messages[e.code] ?? tc("generic");
  };

  async function guarded(task: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(describe(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function openKeyRequest(wallet: string) {
    const request = await api("POST", "/api/v1/sodex/connection", signatureRequestSchema, {
      body: { address: wallet },
      idempotencyKey: crypto.randomUUID(),
    });
    setPhase({ kind: "review", request, which: "key", rejected: false });
  }

  async function openFeeRequest() {
    const request = await api(
      "POST",
      "/api/v1/sodex/builder-fee/approval",
      signatureRequestSchema,
      {
        idempotencyKey: crypto.randomUUID(),
      },
    );
    setPhase({ kind: "review", request, which: "fee", rejected: false });
  }

  const [picking, setPicking] = useState(false);
  /**
   * Luôn mở danh sách ví để người dùng chọn đúng ví: không tự dùng ví trình duyệt còn nhớ từ phiên trước
   * (có thể là ví của tài khoản DRIFT khác).
   */
  const connectWallet = () =>
    guarded(() => {
      setPicking(true);
      return Promise.resolve();
    });

  const connectWith = (connector: Connector) =>
    guarded(async () => {
      let wallet: `0x${string}`;
      try {
        // Ngắt ví đang nhớ trước, để ví hỏi lại account (MetaMask, OKX… cho chọn account khác).
        if (isConnected) await disconnectAsync();
        wallet = (await connectAsync({ connector })).accounts[0];
      } catch {
        setError(t("errors.noWallet"));
        return;
      }
      setPicking(false);
      await openKeyRequest(wallet);
    });

  const sign = (request: SignatureRequest, which: "key" | "fee") =>
    guarded(async () => {
      setPhase({ kind: "signing", request, which });
      const outcome = await signAndSubmit(request, {
        onSigned: () => {
          setPhase({ kind: "creating", which, unknown: false });
        },
        onUnknown: () => {
          setPhase({ kind: "creating", which, unknown: true });
        },
      }).catch((e: unknown) => {
        setPhase({ kind: "review", request, which, rejected: false });
        throw e;
      });
      if (outcome.kind === "rejected") {
        setPhase({ kind: "review", request, which, rejected: true });
        return;
      }
      if (outcome.kind === "failed") {
        setPhase({ kind: "review", request: outcome.request, which, rejected: false });
        setError(t("errors.rejectedBySodex", { reason: outcome.request.sodexError ?? "" }));
        return;
      }
      const { connection } = await api("GET", "/api/v1/sodex/connection", sodexConnectionSchema);
      // Account của chính builder không cần approve phí (DEC-47): xong ngay sau chữ ký 1.
      if (which === "key" && connection?.builderFee?.exempt !== true) {
        await openFeeRequest();
        return;
      }
      if (connection !== null) setPhase({ kind: "done", connection });
    });

  const phaseIndex =
    phase.kind === "start" ? 1 : phase.kind === "done" ? 4 : phase.kind === "creating" ? 3 : 2;
  const { pct, bp } = feeLabels(DRIFT_BUILDER_FEE_RATE);

  return (
    <>
      <StepHeading step={2} title={t("title")} lead={t("lead")} />
      <ol aria-label={t("phases.label")} className="m-0 grid list-none grid-cols-3 gap-2 p-0">
        {(["wallet", "review", "confirmed"] as const).map((key, i) => {
          const n = i + 1;
          const on = n === phaseIndex;
          const done = n < phaseIndex;
          return (
            <li
              key={key}
              aria-current={on ? "step" : undefined}
              className={`flex items-center gap-2 rounded-control border-[1.5px] px-3 py-2.5 text-[13px] font-bold ${on ? "border-accent bg-accent-tint" : "border-transparent bg-surface-2"}`}
            >
              <span
                aria-hidden="true"
                className={`flex size-6 flex-none items-center justify-center rounded-full text-xs font-extrabold ${on ? "bg-accent text-surface" : done ? "bg-pos-bg text-pos" : "bg-border text-ink-2"}`}
              >
                {done ? "✓" : n}
              </span>
              {t(`phases.${key}`)}
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

      {phase.kind === "start" ? (
        <section className="flex flex-col gap-3 rounded-card border border-border p-5">
          {picking ? (
            <WalletPicker disabled={busy} onPick={(c) => void connectWith(c)} />
          ) : (
            <Button variant="dark" pending={busy} onClick={() => void connectWallet()}>
              {t("connectWallet")}
            </Button>
          )}
          <span className="text-xs leading-normal text-muted">{t("masterHint")}</span>
        </section>
      ) : null}

      {phase.kind === "review" || phase.kind === "signing" ? (
        <Review
          request={phase.request}
          which={phase.which}
          rejected={phase.kind === "review" && phase.rejected}
          signing={phase.kind === "signing"}
          busy={busy}
          pct={pct}
          bp={bp}
          onSign={() => void sign(phase.request, phase.which)}
        />
      ) : null}

      {phase.kind === "creating" ? (
        <p
          role="status"
          className="m-0 flex items-center gap-2.5 rounded-control bg-accent-tint px-3.5 py-3 text-sm font-semibold text-accent-ink"
        >
          <span aria-hidden="true" className="size-2.5 animate-pulse rounded-full bg-accent" />
          {phase.unknown
            ? t("unknown")
            : phase.which === "key"
              ? t("creatingKey")
              : t("creatingFee")}
        </p>
      ) : null}

      {phase.kind === "done" ? <Done connection={phase.connection} pct={pct} /> : null}

      <div className="flex items-center justify-between gap-3">
        <Link href="/signup" className="text-sm font-bold text-accent no-underline">
          {tCommon("back")}
        </Link>
        {phase.kind === "done" ? (
          <Link
            href="/onboarding/import"
            className="inline-flex min-h-tap items-center rounded-control bg-accent px-5 text-sm font-bold text-surface no-underline"
          >
            {t("next")}
          </Link>
        ) : (
          <Button disabled>{t("next")}</Button>
        )}
      </div>
      <p className="m-0 text-xs text-muted">{t("manage")}</p>
    </>
  );
}

function Review({
  request,
  which,
  rejected,
  signing,
  busy,
  pct,
  bp,
  onSign,
}: {
  request: SignatureRequest;
  which: "key" | "fee";
  rejected: boolean;
  signing: boolean;
  busy: boolean;
  pct: string;
  bp: string;
  onSign: () => void;
}) {
  const t = useTranslations("onboarding.connect");
  const m = request.typedData.message;
  const accountId = String(m.accountID ?? "");
  const emphasised = new Set(["builderID", "maxFeeRate", "permissions"]);
  return (
    <section className="flex flex-col gap-4">
      <p className="m-0 text-sm text-ink-2">{t("accountLine", { id: accountId })}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <article
          className={`flex flex-col gap-2 rounded-tile border p-4 ${which === "key" ? "border-[1.5px] border-accent" : "border-border"}`}
        >
          <span className="self-start rounded-full bg-accent-tint px-2.5 py-0.5 text-[11px] font-extrabold tracking-[0.06em] text-accent-ink">
            {t("key.tag")}
          </span>
          <h2 className="m-0 text-base font-extrabold">{t("key.title")}</h2>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-[13px] leading-normal text-ink-2">
            <li>{t.rich("key.named", { b: (c) => <strong>{c}</strong> })}</li>
            <li>{t("key.scope")}</li>
            {which === "key" ? (
              <li>
                {t.rich("key.expires", {
                  b: (c) => <strong>{c}</strong>,
                  date: formatDate(String(m.expiresAt)),
                })}
              </li>
            ) : null}
          </ul>
        </article>
        <article
          className={`flex flex-col gap-2 rounded-tile border p-4 ${which === "fee" ? "border-[1.5px] border-accent" : "border-border"}`}
        >
          <span className="self-start rounded-full bg-accent-tint px-2.5 py-0.5 text-[11px] font-extrabold tracking-[0.06em] text-accent-ink">
            {t("fee.tag")}
          </span>
          <h2 className="m-0 text-base font-extrabold">{t("fee.title")}</h2>
          <div className="flex items-baseline gap-2 tabular-nums">
            <span className="text-[26px] font-extrabold">{pct}</span>
            <span className="text-xs text-ink-2">{t("fee.perFill", { bp })}</span>
          </div>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-[13px] leading-normal text-ink-2">
            <li>{t("fee.onlyDrift")}</li>
            <li>{t("fee.inside")}</li>
            <li>{t("fee.revoke")}</li>
          </ul>
        </article>
      </div>
      <details className="rounded-tile bg-surface-2 p-4 text-sm">
        <summary className="cursor-pointer font-bold">{t("howTitle")}</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[13px] tabular-nums">
            <thead>
              <tr>
                <th scope="col">{t("table.market")}</th>
                <th scope="col">{t("table.chargedOn")}</th>
                <th scope="col">{t("table.approval")}</th>
                <th scope="col">{t("table.cap")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t("table.perps")}</td>
                <td>{t("table.perpsOn")}</td>
                <td>{pct}</td>
                <td>0.2%</td>
              </tr>
              <tr>
                <td>{t("table.spot")}</td>
                <td>{t("table.spotOn")}</td>
                <td>{pct}</td>
                <td>2%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mb-0 text-xs text-muted">{t("howNote")}</p>
      </details>

      <WalletSignaturePreview
        title={t("preview.title")}
        action={request.typedData.primaryType}
        fields={[
          { label: t("preview.domain"), value: t("preview.domainValue") },
          ...Object.entries(m).map(([label, value]) => ({
            label,
            value: String(value),
            emphasis: emphasised.has(label),
          })),
        ]}
        note={t("preview.check")}
      />

      {rejected ? (
        <div role="alert" className="rounded-control bg-warn-bg px-3.5 py-3 text-sm text-warn">
          <strong>{t("rejectedTitle")}</strong>{" "}
          {which === "key" ? t("rejectedKey") : t("rejectedFee")}
        </div>
      ) : null}

      {signing ? (
        <p
          role="status"
          className="m-0 flex items-center gap-2.5 text-sm font-semibold text-accent-ink"
        >
          <span aria-hidden="true" className="size-2.5 animate-pulse rounded-full bg-accent" />
          {t("waiting")}
        </p>
      ) : (
        <Button pending={busy} onClick={onSign}>
          {rejected ? t("retry") : which === "key" ? t("signKey") : t("signFee")}
        </Button>
      )}
      <span className="text-xs text-muted">{t("free")}</span>
    </section>
  );
}

function Done({
  connection,
  pct,
}: {
  connection: NonNullable<SodexConnection["connection"]>;
  pct: string;
}) {
  const t = useTranslations("onboarding.connect");
  const tm = useTranslations("common.missing");
  return (
    <section
      role="status"
      aria-label={t("doneTitle")}
      className="flex flex-col gap-3 rounded-card border border-pos-dot bg-pos-bg/40 p-5"
    >
      <div className="text-base font-extrabold text-pos">{t("doneTitle")}</div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">{t("done.account")}</dt>
        <dd className="m-0">
          {t("done.accountValue", {
            id: connection.sodexAccountId,
            address: shortAddress(connection.address),
          })}
        </dd>
        <dt className="text-muted">{t("done.apiKey")}</dt>
        <dd className="m-0">
          {connection.apiKey === null
            ? tm("notAvailable")
            : t("done.apiKeyValue", {
                last4: connection.apiKey.last4,
                date: formatDate(Date.parse(connection.apiKey.expiresAt)),
              })}
        </dd>
        <dt className="text-muted">{t("done.approval")}</dt>
        <dd className="m-0">
          {connection.builderFee === null
            ? tm("notAvailable")
            : t("done.approvalValue", { builderId: connection.builderFee.builderId, pct })}
        </dd>
        <dt className="text-muted">{t("done.equity")}</dt>
        <dd className="m-0">{tm("notAvailable")}</dd>
      </dl>
    </section>
  );
}
