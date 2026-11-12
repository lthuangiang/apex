"use client";

import {
  adminResetPasswordSchema,
  adminUsersViewSchema,
  adminAiDeskSchema,
  adminVolumeBotsSchema,
  type AdminResetPassword,
  type AdminUsersView,
} from "@drift/shared";
import { Button, ConfirmDialog, DataTable, inputClassName } from "@drift/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatAmount, formatDate, formatInteger, shortAddress } from "@/lib/format";

// Users (chỉ role `team`; DEC-64): danh sách người đã đăng ký. Thao tác: đặt lại mật khẩu (DEC-77, cần 2FA
// của người thao tác) và bật / tắt bot khối lượng (DEC-80); không đổi role, khoá hay xoá. api tự kiểm tra role.

type Row = AdminUsersView["items"][number];

export function UsersPage() {
  const t = useTranslations("adminUsers");
  const tm = useTranslations("common.missing");
  const searchId = useId();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  // Gõ xong 300 ms mới tìm, và quay về trang 1.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(input.trim());
      setPage(1);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [input]);

  const query = useQuery({
    queryKey: ["admin-users", q, page],
    queryFn: () =>
      api(
        "GET",
        `/api/v1/admin/users?${new URLSearchParams({ q, page: String(page) }).toString()}`,
        adminUsersViewSchema,
      ),
    placeholderData: keepPreviousData,
  });
  const v = query.data;
  const forbidden = query.error instanceof ApiError && query.error.code === "FORBIDDEN";
  const status = query.isPending ? "loading" : query.isError ? "error" : "ready";
  const pages = v === undefined ? 1 : Math.max(1, Math.ceil(v.total / v.pageSize));

  // Đặt lại mật khẩu: một Idempotency-Key cho mỗi lần mở dialog; kết quả chỉ giữ trong state, hiện một lần.
  const [target, setTarget] = useState<Row | null>(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<AdminResetPassword | null>(null);
  const [copied, setCopied] = useState(false);
  const resetKey = useRef("");
  const reset = useMutation({
    mutationFn: (u: Row) =>
      api("POST", `/api/v1/admin/users/${u.id}/password`, adminResetPasswordSchema, {
        idempotencyKey: resetKey.current,
        body: { twoFactorCode: code },
      }),
    onSuccess: (r) => {
      setTarget(null);
      setCode("");
      setCopied(false);
      setResult(r);
    },
  });
  // Bật / tắt bot khối lượng (Volume Maker, Volume Farm) cho một user (DEC-80).
  const qc = useQueryClient();
  const [volumeTarget, setVolumeTarget] = useState<Row | null>(null);
  const volume = useMutation({
    mutationFn: (u: Row) =>
      api("POST", `/api/v1/admin/users/${u.id}/volume-bots`, adminVolumeBotsSchema, {
        body: { enabled: !u.volumeBots },
      }),
    onSuccess: async () => {
      setVolumeTarget(null);
      await qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  // Bật / tắt AI Desk (DEC-105): không dừng bot nào nên không cần hộp thoại xác nhận.
  const desk = useMutation({
    mutationFn: (u: Row) =>
      api("POST", `/api/v1/admin/users/${u.id}/ai-desk`, adminAiDeskSchema, {
        body: { enabled: !u.aiDesk },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  const resetError = (() => {
    const e = reset.error;
    if (!(e instanceof ApiError)) return e === null ? undefined : t("reset.errors.generic");
    if (e.code === "TWO_FACTOR_INVALID") return t("reset.errors.twoFactor");
    if (e.code === "TWO_FACTOR_REQUIRED") return t("reset.errors.twoFactorOff");
    return t("reset.errors.generic");
  })();

  return (
    <Workspace current="users">
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {forbidden ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : (
          <>
            {result === null ? null : (
              <Card>
                <div role="status" className="flex flex-col gap-3">
                  <strong className="text-base">
                    {t("reset.resultTitle", { email: result.email })}
                  </strong>
                  <div className="flex flex-wrap items-center gap-3">
                    <code className="rounded-control bg-surface-2 px-3.5 py-2.5 font-mono text-lg tracking-wider select-all">
                      {result.temporaryPassword}
                    </code>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void navigator.clipboard.writeText(result.temporaryPassword).then(() => {
                          setCopied(true);
                        });
                      }}
                    >
                      {copied ? t("reset.copied") : t("reset.copy")}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setResult(null);
                      }}
                    >
                      {t("reset.dismiss")}
                    </Button>
                  </div>
                  <p className="m-0 text-sm text-ink-2">{t("reset.resultBody")}</p>
                </div>
              </Card>
            )}
            <Card>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
                  <label htmlFor={searchId} className="text-sm font-semibold text-ink">
                    {t("search")}
                  </label>
                  <input
                    id={searchId}
                    type="search"
                    className={inputClassName}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                    }}
                  />
                </div>
                {v === undefined ? null : (
                  <span className="text-sm text-ink-2 tabular-nums" aria-live="polite">
                    {t("count", { total: v.total })}
                  </span>
                )}
              </div>
              <DataTable
                caption={t("title")}
                label={t("title")}
                status={status === "ready" && v?.items.length === 0 ? "empty" : status}
                empty={{ title: t("empty") }}
                error={{ title: tm("notAvailable") }}
                rows={v?.items ?? []}
                getRowKey={(u) => u.id}
                columns={[
                  {
                    key: "email",
                    header: t("cols.email"),
                    cell: (u: Row) => (
                      <span className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/admin/users/${u.id}`}
                          className="font-semibold break-all text-accent-ink hover:underline"
                        >
                          {u.email}
                        </Link>
                        {u.role === "team" ? (
                          <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[12px] font-semibold text-accent-ink">
                            {t("team")}
                          </span>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    key: "registered",
                    header: t("cols.registered"),
                    cell: (u: Row) => formatDate(Date.parse(u.createdAt)),
                  },
                  {
                    key: "sodex",
                    header: t("cols.sodex"),
                    cell: (u: Row) =>
                      u.sodex === null ? (
                        <span className="text-ink-2">{t("notConnected")}</span>
                      ) : (
                        <span className="flex flex-col">
                          <span className="font-mono text-xs" title={u.sodex.address}>
                            {shortAddress(u.sodex.address)} · #{u.sodex.accountId}
                          </span>
                          <span className="text-xs text-ink-2">
                            {t(`status.${u.sodex.status}`)}
                          </span>
                        </span>
                      ),
                  },
                  {
                    key: "fee",
                    header: t("cols.fee"),
                    cell: (u: Row) =>
                      u.builderFee === null ? (
                        <span className="text-ink-2">{tm("notAvailable")}</span>
                      ) : (
                        <span
                          className={
                            u.builderFee === "approved" || u.builderFee === "exempt"
                              ? "text-pos"
                              : "text-warn"
                          }
                        >
                          {t(`fee.${u.builderFee}`)}
                        </span>
                      ),
                  },
                  {
                    key: "bots",
                    header: t("cols.bots"),
                    numeric: true,
                    cell: (u: Row) =>
                      t("bots", {
                        running: formatInteger(u.bots.running),
                        total: formatInteger(u.bots.total),
                      }),
                  },
                  {
                    key: "equity",
                    header: t("cols.equity"),
                    numeric: true,
                    cell: (u: Row) =>
                      u.equity === null ? (
                        <span className="text-ink-2">{tm("notAvailable")}</span>
                      ) : (
                        (formatAmount(u.equity, 2)?.text ?? u.equity)
                      ),
                  },
                  {
                    key: "volume",
                    header: t("cols.volume"),
                    numeric: true,
                    cell: (u: Row) => formatAmount(u.volume, 2)?.text ?? u.volume,
                  },
                  {
                    key: "volumeBots",
                    header: t("cols.volumeBots"),
                    cell: (u: Row) => (
                      <span className="flex items-center gap-2">
                        <span className={u.volumeBots ? "font-bold text-pos" : "text-muted"}>
                          {u.volumeBots ? t("on") : t("off")}
                        </span>
                        <Button
                          variant="secondary"
                          aria-label={t(u.volumeBots ? "volume.offLabel" : "volume.onLabel", {
                            email: u.email,
                          })}
                          onClick={() => {
                            volume.reset();
                            setVolumeTarget(u);
                          }}
                        >
                          {t(u.volumeBots ? "volume.turnOff" : "volume.turnOn")}
                        </Button>
                      </span>
                    ),
                  },
                  {
                    key: "aiDesk",
                    header: t("cols.aiDesk"),
                    cell: (u: Row) => (
                      <span className="flex items-center gap-2">
                        <span className={u.aiDesk ? "font-bold text-pos" : "text-muted"}>
                          {u.aiDesk ? t("on") : t("off")}
                        </span>
                        <Button
                          variant="secondary"
                          pending={desk.isPending && desk.variables.id === u.id}
                          aria-label={t(u.aiDesk ? "aiDesk.offLabel" : "aiDesk.onLabel", {
                            email: u.email,
                          })}
                          onClick={() => {
                            desk.mutate(u);
                          }}
                        >
                          {t(u.aiDesk ? "volume.turnOff" : "volume.turnOn")}
                        </Button>
                      </span>
                    ),
                  },
                  {
                    key: "actions",
                    header: t("cols.actions"),
                    cell: (u: Row) => (
                      <Button
                        aria-label={t("reset.title", { email: u.email })}
                        variant="secondary"
                        onClick={() => {
                          resetKey.current = crypto.randomUUID();
                          reset.reset();
                          setCode("");
                          setTarget(u);
                        }}
                      >
                        {t("reset.button")}
                      </Button>
                    ),
                  },
                ]}
              />
              {desk.isError ? (
                <p role="alert" className="m-0 text-sm text-neg-ink">
                  {t("aiDesk.error")}
                </p>
              ) : null}
              {pages <= 1 ? null : (
                <nav aria-label={t("title")} className="flex items-center justify-between gap-3">
                  <Button
                    variant="secondary"
                    disabled={page <= 1 || query.isFetching}
                    onClick={() => {
                      setPage((p) => p - 1);
                    }}
                  >
                    {t("prev")}
                  </Button>
                  <span className="text-sm tabular-nums">{t("page", { page, pages })}</span>
                  <Button
                    variant="secondary"
                    disabled={page >= pages || query.isFetching}
                    onClick={() => {
                      setPage((p) => p + 1);
                    }}
                  >
                    {t("next")}
                  </Button>
                </nav>
              )}
            </Card>
          </>
        )}
        <ConfirmDialog
          open={volumeTarget !== null}
          onOpenChange={(open) => {
            if (!open) setVolumeTarget(null);
          }}
          title={t(volumeTarget?.volumeBots === true ? "volume.offTitle" : "volume.onTitle", {
            email: volumeTarget?.email ?? "",
          })}
          consequencesLabel={t("reset.consequencesLabel")}
          consequences={[
            ...(volumeTarget?.volumeBots === true
              ? [t("volume.off.one"), t("volume.off.two")]
              : [t("volume.on.one"), t("volume.on.two")]),
            ...(volume.error === null ? [] : [t("volume.error")]),
          ]}
          confirmLabel={t(
            volumeTarget?.volumeBots === true ? "volume.confirmOff" : "volume.confirmOn",
          )}
          cancelLabel={t("reset.cancel")}
          pending={volume.isPending}
          pendingLabel={t("volume.pending")}
          onConfirm={() => {
            if (volumeTarget !== null) volume.mutate(volumeTarget);
          }}
        />
        <ConfirmDialog
          open={target !== null}
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          title={t("reset.title", { email: target?.email ?? "" })}
          consequencesLabel={t("reset.consequencesLabel")}
          consequences={[
            t("reset.consequences.one"),
            t("reset.consequences.two"),
            t("reset.consequences.three"),
          ]}
          confirmLabel={t("reset.confirm")}
          cancelLabel={t("reset.cancel")}
          tone="danger"
          twoFactor={{
            label: t("reset.twoFactor"),
            value: code,
            onChange: setCode,
            ...(resetError === undefined ? {} : { error: resetError }),
          }}
          pending={reset.isPending}
          pendingLabel={t("reset.pending")}
          onConfirm={() => {
            if (target !== null) reset.mutate(target);
          }}
        />
      </div>
    </Workspace>
  );
}
