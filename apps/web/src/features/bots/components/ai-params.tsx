"use client";

import {
  assetOf,
  goalsViewSchema,
  marketListSchema,
  RECO_STRATEGIES,
  suggestionViewSchema,
  type SuggestionView,
} from "@drift/shared";
import { Button, ConfirmDialog } from "@drift/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { MARKETS_KEY } from "@/lib/markets";

import { capitalOf } from "../capital";
import { emptyValues, FIELDS, fromConfig, type FormValues } from "../fields";

// AI parameters (SCREENS.md mục 8.2): một nút chuyển trạng thái Clear parameters ↔ ✦ AI parameters,
// chip AI / Edited theo field, hỏi trước khi ghi đè chỉnh sửa, lỗi hoặc > 5 s thì cho nhập tay.

type Strategy = keyof typeof FIELDS;
const paramsResponse = z.object({ suggestion: suggestionViewSchema.nullable() });
const goalsResponse = z.object({ goals: goalsViewSchema.nullable() });

export const supportsAi = (s: string): s is (typeof RECO_STRATEGIES)[number] =>
  (RECO_STRATEGIES as readonly string[]).includes(s);
const marketKey = (s: Strategy) => (s === "funding_arb" ? "perpMarket" : "market");
const engineOf = (s: Strategy) =>
  s.startsWith("futures") || s === "funding_arb" ? "perps" : "spot";
const isNumeric = (s: Strategy, key: string) =>
  FIELDS[s].some((f) => f.key === key && (f.type.kind === "decimal" || f.type.kind === "int"));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface AiState {
  mode: "ai" | "cleared" | "manual";
  suggestion: SuggestionView | null;
  sources: Record<string, "ai" | "edited">;
  placeholders: Record<string, string>;
  edits: number;
  paramSource: "ai" | "ai_edited" | "manual";
  loading: boolean;
  unavailable: boolean;
  /** Không có vốn (form trống, chưa lưu ở onboarding bước 5): cần nhập vốn rồi thử lại. */
  needsCapital: boolean;
}

export function useAiParameters(opts: {
  strategy: Strategy;
  values: FormValues;
  setValues: (v: FormValues) => void;
  context: "create" | "retune";
  /** Mở từ Strategy plan: suggestion đã lưu. */
  suggestionId?: string;
  /** Tự gọi engine khi mở màn (Create); Retune chỉ gọi khi bấm. */
  auto: boolean;
  /** Retune: chỉ ghi đè field sửa được. */
  editable?: (key: string) => boolean;
}) {
  const { strategy, values, setValues, context, suggestionId, auto, editable } = opts;
  const [suggestion, setSuggestion] = useState<SuggestionView | null>(null);
  const [aiValues, setAiValues] = useState<FormValues | null>(null);
  const [mode, setMode] = useState<AiState["mode"]>("manual");
  const [cleared, setCleared] = useState<FormValues | null>(null);
  const key = useRef(crypto.randomUUID());
  const enabled = supportsAi(strategy);

  const goals = useQuery({
    queryKey: ["goals"],
    queryFn: () => api("GET", "/api/v1/goals", goalsResponse),
    enabled: enabled && auto,
  });
  const markets = useQuery({
    queryKey: MARKETS_KEY,
    queryFn: () => api("GET", "/api/v1/markets", marketListSchema),
    staleTime: 60_000,
    enabled: enabled && auto,
  });

  const apply = useCallback(
    (s: SuggestionView, base: FormValues) => {
      const filled = fromConfig(strategy, s.values);
      const next: FormValues = { ...base };
      for (const [k, v] of Object.entries(filled)) {
        if (s.values[k] === undefined) continue;
        if (editable !== undefined && !editable(k)) continue;
        next[k] = v;
      }
      setSuggestion(s);
      setAiValues(next);
      setMode("ai");
      setCleared(null);
      setValues(next);
    },
    [strategy, editable, setValues],
  );

  const sentCapital = useRef<string | undefined>(undefined);
  const request = useMutation({
    mutationFn: async (market: string) => {
      sentCapital.current = capitalOf(strategy, valuesRef.current);
      // Quá 5 s thì coi như không có (SCREENS.md mục 8.2 bước 7).
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new ApiError("RECO_UNAVAILABLE", 503));
        }, 5_000),
      );
      const call = api("POST", "/api/v1/reco/params", paramsResponse, {
        idempotencyKey: key.current,
        // Vốn đang nhập trên form; chưa có thì api dùng vốn đã lưu ở onboarding bước 5.
        body: { strategy, market, context, ...withCapital(sentCapital.current) },
      });
      return Promise.race([call, timeout]);
    },
    onSettled: () => {
      key.current = crypto.randomUUID();
    },
  });

  const valuesRef = useRef(values);
  valuesRef.current = values;
  const fetchFor = useCallback(
    (market: string) => {
      request.mutate(market, {
        onSuccess: (r) => {
          if (r.suggestion === null) return;
          apply(r.suggestion, valuesRef.current);
        },
      });
    },
    [request, apply],
  );

  // Mở từ Strategy plan: đọc suggestion đã lưu.
  const stored = useQuery({
    queryKey: ["suggestion", suggestionId],
    queryFn: () =>
      api("GET", `/api/v1/reco/suggestions/${suggestionId ?? ""}`, suggestionViewSchema),
    enabled: suggestionId !== undefined,
    staleTime: Infinity,
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !enabled) return;
    if (suggestionId !== undefined) {
      if (stored.data === undefined) return;
      started.current = true;
      apply(stored.data, emptyValues(strategy));
      return;
    }
    if (!auto || goals.data === undefined || markets.data === undefined) return;
    started.current = true;
    // Market điền sẵn (Watchlist › "New bot on …"): giữ market đó, chỉ hỏi engine tham số.
    const preset = valuesRef.current[marketKey(strategy)];
    if (typeof preset === "string" && preset !== "") {
      fetchFor(preset);
      return;
    }
    const assets = goals.data.goals?.assets ?? [];
    const m = markets.data.items.find(
      (x) => x.engine === engineOf(strategy) && assets.includes(assetOf(x.name)),
    );
    if (m === undefined) return;
    setValues({ ...valuesRef.current, [marketKey(strategy)]: m.name });
    fetchFor(m.name);
  }, [
    enabled,
    suggestionId,
    stored.data,
    auto,
    goals.data,
    markets.data,
    strategy,
    apply,
    fetchFor,
    setValues,
  ]);

  // Đổi market khi đang dùng giá trị AI → gọi lại engine (bước 6).
  const currentMarket = values[marketKey(strategy)];
  useEffect(() => {
    if (
      mode !== "ai" ||
      suggestion === null ||
      typeof currentMarket !== "string" ||
      currentMarket === ""
    )
      return;
    if (currentMarket !== suggestion.market && !request.isPending) fetchFor(currentMarket);
  }, [mode, suggestion, currentMarket, request.isPending, fetchFor]);

  const sources: Record<string, "ai" | "edited"> = {};
  let edits = 0;
  if (mode === "ai" && aiValues !== null && suggestion !== null) {
    for (const k of Object.keys(suggestion.values)) {
      if (!isNumeric(strategy, k)) continue;
      if (same(values[k], aiValues[k])) sources[k] = "ai";
      else {
        sources[k] = "edited";
        edits += 1;
      }
    }
  }
  const placeholders: Record<string, string> = {};
  if (mode === "cleared" && cleared !== null) {
    for (const [k, v] of Object.entries(cleared))
      if (typeof v === "string" && v !== "") placeholders[k] = v;
  }

  const clear = () => {
    if (aiValues === null) return;
    const empty = emptyValues(strategy);
    const next: FormValues = { ...values };
    for (const k of Object.keys(next)) {
      if (
        k === marketKey(strategy) ||
        FIELDS[strategy].some((f) => f.key === k && f.locked === true)
      )
        continue;
      if (editable !== undefined && !editable(k)) continue;
      next[k] = empty[k] ?? "";
    }
    setCleared(aiValues);
    setMode("cleared");
    setValues(next);
  };

  const state: AiState = {
    mode,
    suggestion,
    sources,
    placeholders,
    edits,
    paramSource: mode === "ai" ? (edits === 0 ? "ai" : "ai_edited") : "manual",
    loading: request.isPending || stored.isLoading,
    unavailable: request.isError || stored.isError || request.data?.suggestion === null,
    needsCapital: request.data?.suggestion === null && sentCapital.current === undefined,
  };
  return {
    state,
    enabled,
    clear,
    refresh: () => {
      const m = valuesRef.current[marketKey(strategy)];
      if (typeof m === "string" && m !== "") fetchFor(m);
    },
  };
}

export function AiPanel({
  ai,
  retune = false,
}: {
  ai: ReturnType<typeof useAiParameters>;
  retune?: boolean;
}) {
  const t = useTranslations("createBot.ai");
  const tr = useTranslations("botEdit.retune");
  const [confirm, setConfirm] = useState(false);
  if (!ai.enabled) return null;
  const { state } = ai;
  const ask = () => {
    if (state.edits > 0) setConfirm(true);
    else ai.refresh();
  };
  return (
    <section
      aria-label={t("button")}
      className={`flex flex-col gap-2.5 text-sm ${
        state.mode === "ai" && state.suggestion !== null && !state.loading
          ? "rounded-[16px] border border-accent/25 bg-accent-tint p-3.5"
          : "rounded-[14px] bg-surface-2 px-3.5 py-3"
      }`}
    >
      {state.loading ? (
        <p role="status" className="m-0">
          {t("loading")}
        </p>
      ) : state.mode === "ai" && state.suggestion !== null ? (
        <>
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="text-accent-ink">{t("filled")}</strong>
              <span className="text-xs leading-[1.45]">{state.suggestion.basis}</span>
            </div>
            <Button variant="secondary" className="flex-none" onClick={ai.clear}>
              {t("clear")}
            </Button>
          </div>
          <details className="text-xs leading-normal">
            <summary className="cursor-pointer font-bold text-accent-ink">{t("why")}</summary>
            <ul className="m-0 mt-1.5 flex flex-col gap-1 pl-[18px]">
              {state.suggestion.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </details>
          <span className="text-[11px] text-ink-2">
            {t("suggested", { time: formatDateTime(state.suggestion.computedAt) })}
          </span>
        </>
      ) : retune ? (
        <>
          <strong>{tr("title")}</strong>
          <span className="text-ink-2">{tr("body")}</span>
          <Button className="self-start" onClick={ask}>
            {tr("cta")}
          </Button>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <span className="text-[13px] leading-[1.45] text-ink-2">{t("manual")}</span>
          <Button className="flex-none" onClick={ask}>
            {t("button")}
          </Button>
        </div>
      )}
      {state.unavailable && !state.loading ? (
        <p role="alert" className="m-0 text-warn">
          {state.needsCapital ? t("needsCapital") : t("unavailable")}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("replace", { n: state.edits })}
        consequencesLabel={t("why")}
        consequences={[]}
        confirmLabel={t("replaceCta")}
        cancelLabel={t("keep")}
        onConfirm={() => {
          setConfirm(false);
          ai.refresh();
        }}
      />
    </section>
  );
}

const withCapital = (capital: string | undefined) => (capital === undefined ? {} : { capital });
