"use client";

import { adminUsersViewSchema, type AdminUsersView } from "@drift/shared";
import { Button, DataTable, inputClassName } from "@drift/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatInteger, shortAddress } from "@/lib/format";

// Users (chỉ role `team`, chỉ đọc; DEC-64): danh sách người đã đăng ký. Không có thao tác đổi role,
// khoá hay xoá; api tự kiểm tra role, menu ẩn chỉ là tiện lợi.

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

  return (
    <Workspace current="users">
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {forbidden ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : (
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
                      <span className="break-all">{u.email}</span>
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
                        <span className="text-xs text-ink-2">{t(`status.${u.sodex.status}`)}</span>
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
                  key: "twoFactor",
                  header: t("cols.twoFactor"),
                  cell: (u: Row) => (u.twoFactor ? t("on") : t("off")),
                },
              ]}
            />
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
        )}
      </div>
    </Workspace>
  );
}
