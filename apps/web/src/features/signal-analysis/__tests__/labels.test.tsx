// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  researchLabelBodySchema,
  type ResearchArticleTrace,
  type ResearchLabelNext,
  type ResearchTraceStep,
  type ResearchTradesPage,
} from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { SignalAnalysisPage } from "../components/signal-analysis-page";
import { LabelForm, labelBody } from "../research/labels";
import type { Tr } from "../research/text";
import { traceView } from "../research/trace-text";

import { ETH_TRACE } from "./news-trace-fixtures";
import { RESEARCH_SUMMARY, RESEARCH_TRADES } from "./research-fixtures";
import { CLASSIFIERS, MARKETS, VERSIONS } from "./versions-fixtures";

// Nhãn phân loại (#306; mockup bot-versions-labels.html, API #304): bảng Classifier quality, "Label a random signal"
// (kết quả lệnh ẩn tới khi lưu), hộp nhãn trên thẻ Score, timeline "Opposite news … kept / closed", nhãn opposite /
// shadow ở bảng Trades.

const ART = "art-label-1";
const TRADE = "00000000-0000-4000-8000-0000000000a1";
const SHADOW = "00000000-0000-4000-8000-0000000000a2";

const NEXT: ResearchLabelNext = {
  item: {
    article: {
      id: ART,
      title:
        "A former Google software engineer accused of making an illegal bet on Polymarket may face additional charges",
      content: "Prosecutors said on Tuesday that more charges may follow.",
      url: null,
      source: "CoinDesk",
      tier: "top",
      publishedAt: "2026-11-19T06:10:00.000Z",
      tagged: ["GOOGL"],
    },
    classification: {
      classifierVersion: "news-classifier-v2",
      newsType: "regulatorAgainst",
      asset: "GOOGL",
      relevance: "direct",
      promotional: false,
      eventDate: "2026-11-18",
      claude: {
        calls: 1,
        tokens: { input: 900, cacheWrite: 0, cacheRead: 0, output: 80 },
        costUsd: "0.0021",
        model: "claude",
        promptVersion: "news-classifier-v2",
      },
    },
  },
  remaining: 12,
  labelToken: "tok_".padEnd(43, "x"),
};

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}
const state = vi.hoisted((): { calls: Call[]; next: number } => ({ calls: [], next: 0 }));

vi.mock("@/features/account/market-hours-time", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/account/market-hours-time")>();
  return { ...real, browserTimeZone: () => "Asia/Ho_Chi_Minh" };
});

const TRADES: ResearchTradesPage = {
  items: RESEARCH_TRADES.items.map((x) =>
    x.id === "sr-0004"
      ? {
          ...x,
          opposite: {
            at: "2026-11-19T07:05:00.000Z",
            storyId: null,
            action: "kept" as const,
            exitPrice: "142.10",
            resultUsdc: "-1.20",
            resultPct: -0.24,
          },
        }
      : x.id === "sr-0003"
        ? {
            ...x,
            skipped: {
              reason: "limitOpen" as const,
              tpPct: null,
              neededPct: null,
              limit: 20,
              shadow: { tradeId: SHADOW, outcome: "tp" as const, pnl: "4.20" },
            },
          }
        : x,
  ),
  nextCursor: null,
};

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (
      method: string,
      path: string,
      schema: z.ZodType,
      options: { body?: unknown; idempotencyKey?: string } = {},
    ) => {
      state.calls.push({ method, path, body: options.body, key: options.idempotencyKey });
      const p = new URL(path, "http://x").pathname;
      if (method === "PUT" && p.endsWith(`/articles/${ART}/label`)) {
        const b = researchLabelBodySchema.parse(options.body);
        return Promise.resolve(
          schema.parse({
            articleId: ART,
            label: {
              classifierVersion: "news-classifier-v2",
              labeledBy: "a91f",
              verdict: b.verdict,
              reason: b.reason ?? null,
              note: b.note ?? null,
              source: b.labelToken == null ? "trace" : "random",
              createdAt: "2026-11-19T06:22:00.000Z",
              updatedAt: "2026-11-19T06:22:00.000Z",
            },
            trades: [
              {
                tradeId: TRADE,
                versionId: null,
                side: "short",
                status: "closed",
                outcome: "tp",
                resultPct: 0.84,
                resultUsdc: "4.20",
              },
            ],
          }),
        );
      }
      if (p.endsWith("/signal-research/labels/next")) {
        state.next += 1;
        return Promise.resolve(schema.parse(NEXT));
      }
      if (p.endsWith("/signal-research/versions")) return Promise.resolve(schema.parse(VERSIONS));
      if (p.endsWith("/signal-research/classifiers"))
        return Promise.resolve(schema.parse(CLASSIFIERS));
      if (p.endsWith("/signal-research/markets")) return Promise.resolve(schema.parse(MARKETS));
      if (p.endsWith("/signal-research/summary"))
        return Promise.resolve(schema.parse(RESEARCH_SUMMARY));
      if (p.endsWith("/signal-research/trades")) return Promise.resolve(schema.parse(TRADES));
      if (p.endsWith("/signal-research/articles"))
        return Promise.resolve(
          schema.parse({ items: [], nextCursor: null, total: 0, totalInRange: 0 }),
        );
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});
vi.mock("@/lib/use-media", () => ({
  useMediaQuery: () => false,
  BELOW_LG: "(max-width: 1023px)",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
vi.mock("@/components/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title, action }: { title: string; action?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {action}
    </header>
  ),
}));

const intlErrors: string[] = [];
function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        timeZone="UTC"
        onError={(e) => {
          intlErrors.push(e.message);
        }}
      >
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  state.calls = [];
  state.next = 0;
  intlErrors.length = 0;
  window.history.replaceState(null, "", "/admin/signal-analysis?tab=research");
});
afterEach(() => {
  cleanup();
});

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}
const puts = () => state.calls.filter((c) => c.method === "PUT");

describe("Classifier quality and Label a random signal", { timeout: 20_000 }, () => {
  it("quality table: labels, right %, Wilson range from the API, trades count with the label count", async () => {
    render(
      <Providers>
        <SignalAnalysisPage />
      </Providers>,
    );
    const block = await screen.findByRole(
      "region",
      { name: "Is Claude reading news right?" },
      { timeout: 5_000 },
    );
    const tbl = await within(block).findByRole("table", {
      name: "Claude reader quality by version",
    });
    const cur = within(tbl).getByRole("row", { name: /v2 \(current\)/ });
    expect(within(cur).getByText("37")).toBeInTheDocument();
    // #348: nhãn từ trace hiện riêng, không cộng vào số nhãn của cổng.
    expect(within(cur).getByText("from traces: 9")).toBeInTheDocument();
    expect(within(tbl).getAllByText(/from traces/)).toHaveLength(1);
    // Trang gọn: giải thích "Which labels count" nằm ở drawer How it works › Labels, không ở khu này.
    expect(within(block).queryByText(/Only labels from/)).toBeNull();
    expect(within(cur).getByText("84%")).toBeInTheDocument();
    expect(within(cur).getByText("likely 69–92%")).toBeInTheDocument();
    expect(within(cur).getByText("Not yet · 13 more labels")).toBeInTheDocument();
    const v1 = within(tbl).getByRole("row", { name: /v1/ });
    // PM (#313): "under 80%" luôn kèm số nhãn.
    expect(within(v1).getByText("No · under 80% · 24 labels")).toBeInTheDocument();
    // Khoảng tin cậy là số API tính, không phải câu cố định "69% to 91%".
    expect(
      within(block)
        .getByText(/Trades count once a Claude reader has/)
        .closest("p"),
    ).toHaveTextContent(
      "Trades count once a Claude reader has 50 random labels and at least 80% are marked right. With 37 labels at 84%, the real share could be anywhere from about 69% to 92%, so this is a minimum, not proof.",
    );
    expect(
      within(block).getByRole("heading", { name: "Most common mistakes (reader v2)" }),
    ).toBeInTheDocument();
    expect(
      within(block).getByText("The subject is a person, not the company · 3"),
    ).toBeInTheDocument();
    expect(within(block).queryByText(/Picks at random/)).toBeNull();
  });

  it("random signal: the trade result stays hidden until the label is saved", async () => {
    render(
      <Providers>
        <SignalAnalysisPage />
      </Providers>,
    );
    const block = await screen.findByRole(
      "region",
      { name: "Is Claude reading news right?" },
      { timeout: 5_000 },
    );
    await userEvent.click(within(block).getByRole("button", { name: "Label signals" }));
    const card = await within(block).findByRole("article", { name: "Claude said" });
    expect(within(card).getByText(/A former Google software engineer/)).toBeInTheDocument();
    expect(within(card).getByText(/^News type/)).toHaveTextContent(
      "News type Regulator acts against · asset GOOGL · relevance main subject · not promotional",
    );
    expect(within(card).getByText("Claude reader v2 · $0.0021")).toBeInTheDocument();
    expect(
      within(card).getByText("12 signals of Claude reader v2 left to label"),
    ).toBeInTheDocument();
    expect(within(card).getByText("Result hidden while labelling")).toBeInTheDocument();
    expect(
      within(card).getByText(
        "The trade result stays hidden until you save, so it can’t sway the label.",
      ),
    ).toBeInTheDocument();
    expect(within(card).queryByText(/take profit/)).toBeNull();

    const save = within(card).getByRole("button", { name: "Save label" });
    expect(save).toBeDisabled();
    await userEvent.click(within(card).getByRole("button", { name: "Wrong" }));
    expect(within(card).getByRole("button", { name: "Wrong" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Wrong cần lý do.
    expect(save).toBeDisabled();
    await userEvent.selectOptions(
      within(card).getByRole("combobox", { name: "What is wrong" }),
      "person_not_company",
    );
    await userEvent.type(
      within(card).getByRole("textbox", { name: "Note (optional)" }),
      "Charges against an ex-employee, not Alphabet",
    );
    await noViolations();
    await userEvent.click(save);
    await waitFor(() => {
      expect(puts()).toHaveLength(1);
    });
    // #348: lần lưu đầu của luồng ngẫu nhiên gửi token của labels/next.
    expect(puts()[0]?.body).toEqual({
      verdict: "wrong",
      reason: "person_not_company",
      note: "Charges against an ex-employee, not Alphabet",
      labelToken: NEXT.labelToken,
    });
    expect(puts()[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    // Sau khi lưu mới thấy kết quả lệnh.
    expect(
      await within(card).findByText("Short · hit take profit ·", { exact: false }),
    ).toBeInTheDocument();
    expect(within(card).getByText("+0.84% (+$4.20)")).toBeInTheDocument();
    expect(within(card).queryByText("Result hidden while labelling")).toBeNull();
    expect(
      within(card).getByText(
        "Labelled by ··a91f at 13:22 · one label per person per article · change it any time",
      ),
    ).toBeInTheDocument();
    // Sửa sau khi lưu: không gửi lại token (đã dùng).
    await userEvent.clear(within(card).getByRole("textbox", { name: "Note (optional)" }));
    await userEvent.click(within(card).getByRole("button", { name: "Save label" }));
    await waitFor(() => {
      expect(puts()).toHaveLength(2);
    });
    expect(puts()[1]?.body).toEqual({ verdict: "wrong", reason: "person_not_company", note: null });
    // Bài tiếp theo: đọc lại labels/next.
    await userEvent.click(within(block).getByRole("button", { name: "Label another" }));
    await waitFor(() => {
      expect(state.next).toBe(2);
    });
    expect(intlErrors).toEqual([]);
  });
});

describe("label box on the trace Score card", () => {
  it("shows the viewer's saved label and saves a change with an Idempotency-Key", async () => {
    render(
      <Providers>
        <LabelForm
          articleId={ART}
          tz="Asia/Ho_Chi_Minh"
          hidden={false}
          initial={{
            classifierVersion: "news-classifier-v2",
            labeledBy: "b7c2",
            verdict: "right",
            reason: null,
            note: null,
            source: "trace",
            createdAt: "2026-11-19T06:00:00.000Z",
            updatedAt: "2026-11-19T06:00:00.000Z",
          }}
        />
      </Providers>,
    );
    expect(screen.getByRole("button", { name: "Right" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Save label" })).toBeDisabled();
    expect(screen.queryByText(/stays hidden/)).toBeNull();
    expect(
      screen.getByText(
        "Labelled by ··b7c2 at 13:00 · one label per person per article · change it any time",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Wrong" }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "What is wrong" }),
      "wrong_asset",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save label" }));
    await waitFor(() => {
      // Trace: không bao giờ có token.
      expect(puts()[0]?.body).toEqual({ verdict: "wrong", reason: "wrong_asset", note: null });
    });
  });

  it("labelBody: Right has no reason, Wrong needs one, the note is trimmed", () => {
    expect(labelBody(null, "", "")).toBeNull();
    expect(labelBody("wrong", "", "x")).toBeNull();
    expect(labelBody("right", "wrong_type", "  ")).toEqual({
      verdict: "right",
      reason: null,
      note: null,
    });
    expect(labelBody("wrong", "other", " why ")).toEqual({
      verdict: "wrong",
      reason: "other",
      note: "why",
    });
  });
});

const t = createTranslator({
  locale: "en",
  messages,
  namespace: "signalAnalysis.research" as never,
}) as unknown as Tr;
function withSteps(map: (s: ResearchTraceStep) => ResearchTraceStep): ResearchArticleTrace {
  return { ...ETH_TRACE, steps: ETH_TRACE.steps.map(map) };
}

describe("trace timeline: opposite news and would-have trades", () => {
  it("Decide: Opposite news HH:MM · kept / closed with the would-have result", () => {
    const opp = (action: "kept" | "closed") =>
      withSteps((s) =>
        s.key === "decide" && s.detail !== null
          ? {
              ...s,
              detail: {
                ...s.detail,
                opposite: {
                  at: "2026-11-19T07:05:00.000Z",
                  storyId: null,
                  action,
                  exitPrice: "3401.00",
                  resultUsdc: "-1.20",
                  resultPct: -0.24,
                },
              },
            }
          : s,
      );
    const row = (tr: ResearchArticleTrace) =>
      traceView(tr, "Asia/Ho_Chi_Minh", t).steps[4]?.rows.find((r) => r.label === "Opposite news");
    expect(row(opp("kept"))?.value).toBe("14:05 · kept · closing then: −$1.20 (−0.24%)");
    expect(row(opp("closed"))?.value).toBe("14:05 · closed · closing then: −$1.20 (−0.24%)");
    expect(row(ETH_TRACE)).toBeUndefined();
  });

  it("Filter: an article that is opposite news, and a signal followed as a would-have trade", () => {
    const tr = withSteps((s) =>
      s.key === "filter" && s.detail !== null
        ? {
            ...s,
            status: "drop",
            reason: "limitOpen",
            detail: {
              ...s.detail,
              reasonLimit: 20,
              shadowTradeId: SHADOW,
              opposite: { action: "closed", tradeId: TRADE },
            },
          }
        : s.key === "decide"
          ? { ...s, status: "notReached", detail: null }
          : s,
    );
    const rows = traceView(tr, "UTC", t).steps[3]?.rows ?? [];
    expect(rows.find((r) => r.label === "Opposite news")?.value).toBe("Closed the open trade");
    expect(rows.find((r) => r.label === "Would-have trade")?.value).toBe(
      "Followed outside the balance",
    );
  });
});

describe("Trades table labels", { timeout: 20_000 }, () => {
  it("opposite news tag on a trade, and the would-have result of a limit-blocked signal", async () => {
    render(
      <Providers>
        <SignalAnalysisPage />
      </Providers>,
    );
    const tbl = await screen.findByRole(
      "table",
      { name: "Signal research trades" },
      { timeout: 5_000 },
    );
    const nvda = within(tbl).getByRole("row", { name: /NVDA/ });
    const tag = within(nvda).getByText("opposite news");
    expect(tag).toHaveAttribute(
      "title",
      "Opposite news at 14:05 · kept · closing then: −$1.20 (−0.24%)",
    );
    const btc = within(tbl).getByRole("row", { name: /BTC/ });
    expect(within(btc).getByText("Skipped: Limit: 20 open")).toBeInTheDocument();
    expect(within(btc).getByText("Would have: hit take profit · +$4.20")).toBeInTheDocument();
  });
});
