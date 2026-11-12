"use client";

import {
  adminBuilderFeeSchema,
  DRIFT_BUILDER_FEE_RATE,
  type AdminBuilderFeeBody,
  type BuilderFeeRow,
} from "@drift/shared";
import { Button, DataTable, inputClassName } from "@drift/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Card } from "@/components/workspace";
import { useBotErrorText } from "@/features/bots/components/bot-errors";
import { api } from "@/lib/api";
import { feeLabels } from "@/lib/format";

// Builder fee riêng theo chiến lược của một user (DEC-159). Team nhập %, bước 0.001% (đơn vị của SoDEX), tối đa
// 0.01% vì user chỉ approve tới mức đó. Lệnh mới của user dùng mức mới ngay; bot đang chạy ghi một dòng Decisions.

const PCT = /^\d*(?:\.\d{0,3})?$/;

/** "0.003" → 3 (phần mười bp); null nếu không phải số hợp lệ trong 0–0.01%. */
function toRate(pct: string): number | null {
  if (pct.trim() === "" || !PCT.test(pct.trim())) return null;
  const rate = Math.round(Number(pct) * 1000);
  return rate >= 0 && rate <= DRIFT_BUILDER_FEE_RATE ? rate : null;
}

const pctOf = (rate: number) => feeLabels(rate).pct.replace("%", "");

function FeeRow({ userId, row, name }: { userId: string; row: BuilderFeeRow; name: string }) {
  const t = useTranslations("adminUser.fees");
  const errorText = useBotErrorText();
  const qc = useQueryClient();
  const [value, setValue] = useState(pctOf(row.rate));
  const save = useMutation({
    mutationFn: (body: AdminBuilderFeeBody) =>
      api("PUT", `/api/v1/admin/users/${userId}/builder-fees`, adminBuilderFeeSchema, { body }),
    onSuccess: async (r) => {
      const next = r.builderFees.find((x) => x.strategy === row.strategy);
      if (next !== undefined) setValue(pctOf(next.rate));
      await qc.invalidateQueries({ queryKey: ["admin-user", userId] });
    },
  });
  const rate = toRate(value);
  const invalid = value.trim() !== "" && rate === null;
  return (
    <div className="flex flex-col gap-1.5">
      <form
        className="flex flex-wrap items-center gap-2"
        aria-label={t("editLabel", { strategy: name })}
        onSubmit={(e) => {
          e.preventDefault();
          if (rate !== null) save.mutate({ strategy: row.strategy, rate });
        }}
      >
        <div className="relative w-28 [&_input]:pr-8">
          <input
            className={inputClassName}
            inputMode="decimal"
            aria-label={t("inputLabel", { strategy: name })}
            aria-invalid={invalid || undefined}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[13px] font-bold text-ink-2">
            %
          </span>
        </div>
        <Button
          type="submit"
          variant="secondary"
          pending={save.isPending}
          disabled={rate === null || (row.custom && rate === row.rate)}
        >
          {t("save")}
        </Button>
        {row.custom ? (
          <Button
            type="button"
            variant="tonal"
            disabled={save.isPending}
            onClick={() => {
              save.mutate({ strategy: row.strategy, rate: null });
            }}
          >
            {t("reset")}
          </Button>
        ) : null}
      </form>
      {invalid ? <span className="text-xs text-neg-ink">{t("invalid")}</span> : null}
      {save.error === null ? null : (
        <span className="text-xs text-neg-ink">{errorText(save.error)}</span>
      )}
      {save.data === undefined || save.data.notified === 0 ? null : (
        <span className="text-xs text-muted">{t("notified", { count: save.data.notified })}</span>
      )}
    </div>
  );
}

export function BuilderFeeCard({ userId, rows }: { userId: string; rows: BuilderFeeRow[] }) {
  const t = useTranslations("adminUser.fees");
  const tc = useTranslations("createBot");
  const name = (r: BuilderFeeRow) => tc(`strategies.${r.strategy}.name`);
  return (
    <Card>
      <h2 className="m-0 text-lg font-extrabold">{t("title")}</h2>
      <p className="m-0 text-sm text-ink-2">{t("intro")}</p>
      <DataTable
        caption={t("title")}
        label={t("title")}
        rows={rows}
        status="ready"
        empty={{ title: t("title") }}
        error={{ title: t("title") }}
        getRowKey={(r: BuilderFeeRow) => r.strategy}
        columns={[
          { key: "strategy", header: t("cols.strategy"), cell: name },
          {
            key: "default",
            header: t("cols.default"),
            cell: (r: BuilderFeeRow) => feeLabels(r.defaultRate).pct,
          },
          {
            key: "rate",
            header: t("cols.rate"),
            cell: (r: BuilderFeeRow) => (
              <span className="font-bold">
                {feeLabels(r.rate).pct}
                {r.custom ? (
                  <span className="ml-1.5 text-xs text-accent-ink">{t("custom")}</span>
                ) : null}
              </span>
            ),
          },
          {
            key: "edit",
            header: t("cols.edit"),
            cell: (r: BuilderFeeRow) => <FeeRow userId={userId} row={r} name={name(r)} />,
          },
        ]}
      />
    </Card>
  );
}
