// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  baselineVersionConfig,
  researchVersionCreateBodySchema,
  type ResearchMarkets,
} from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { SignalAnalysisPage } from "../components/signal-analysis-page";
import { AssetPicker, type MarketsState } from "../research/asset-picker";
import { bodyOf, configOf, draftOf, validate } from "../research/version-sheet";
import { gateLines, gateText } from "../research/version-text";

import { RESEARCH_SUMMARY, RESEARCH_TRADES } from "./research-fixtures";
import {
  BASELINE,
  CLASSIFIERS,
  MARKETS,
  V4,
  V4_ID,
  V5_ID,
  VERSIONS,
  VERSIONS_FULL,
} from "./versions-fixtures";

// News bot versions (#306; mockup docs/mockups/signal-research/bot-versions*.html, API #305): thẻ, cổng, bảng, sheet
// tạo version, picker tài sản, đổi versionId cho tổng kết / feed / lệnh. API giả trả fixture đã qua đúng zod schema.

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}
const state = vi.hoisted(
  (): {
    calls: Call[];
    versions: unknown;
    markets: unknown;
    create: "ok" | "stale" | "full" | "network-once" | "unlisted";
    networkFailed: boolean;
  } => ({
    calls: [],
    versions: null,
    markets: null,
    create: "ok",
    networkFailed: false,
  }),
);
const NEW_ID = "00000000-0000-4000-8000-000000000007";

vi.mock("@/features/account/market-hours-time", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/account/market-hours-time")>();
  return { ...real, browserTimeZone: () => "Asia/Ho_Chi_Minh" };
});

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
      if (method === "POST" && p.endsWith("/signal-research/versions")) {
        if (state.create === "full")
          return Promise.reject(
            new real.ApiError("STATE_CONFLICT", 409, { reason: "MAX_RUNNING_VERSIONS", max: 3 }),
          );
        if (state.create === "unlisted")
          return Promise.reject(
            new real.ApiError("VALIDATION_FAILED", 400, {
              fieldErrors: { "config.assets.markets": ["not_listed"] },
              markets: ["SOLV-USD"],
            }),
          );
        if (state.create === "network-once" && !state.networkFailed) {
          state.networkFailed = true;
          return Promise.reject(new real.ApiError("NETWORK", 0));
        }
        const body = options.body as z.infer<typeof researchVersionCreateBodySchema>;
        return Promise.resolve(
          schema.parse({
            ...V4,
            id: NEW_ID,
            number: 7,
            name: body.name,
            config: body.config,
            changedFromPrevious: null,
            savedFrom: null,
            warnings: state.create === "stale" ? ["market_list_stale"] : [],
          }),
        );
      }
      if (method === "POST" && p.includes("/signal-research/versions/"))
        return Promise.resolve(schema.parse({ ...V4, status: "paused" }));
      if (p.endsWith("/signal-research/versions"))
        return Promise.resolve(schema.parse(state.versions));
      if (p.endsWith("/signal-research/classifiers"))
        return Promise.resolve(schema.parse(CLASSIFIERS));
      if (p.endsWith("/signal-research/markets"))
        return Promise.resolve(schema.parse(state.markets));
      if (p.endsWith("/signal-research/summary"))
        return Promise.resolve(schema.parse(RESEARCH_SUMMARY));
      if (p.endsWith("/signal-research/trades"))
        return Promise.resolve(schema.parse(RESEARCH_TRADES));
      if (p.endsWith("/signal-research/articles"))
        return Promise.resolve(
          schema.parse({ items: [], nextCursor: null, total: 0, totalInRange: 0 }),
        );
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});
const media = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/lib/use-media", () => ({
  useMediaQuery: () => media.mobile,
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
function Intl({ children }: { children: ReactNode }) {
  return (
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
  );
}
function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Intl>
        <SignalAnalysisPage />
      </Intl>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.calls = [];
  state.versions = VERSIONS;
  state.markets = MARKETS;
  state.create = "ok";
  state.networkFailed = false;
  media.mobile = false;
  intlErrors.length = 0;
  window.history.replaceState(null, "", "/admin/signal-analysis?tab=research");
});
afterEach(() => {
  cleanup();
});

/** Mặc định quét cả trang; truyền một phần tử khi chỉ phần đó đổi từ lần quét cả trang trước (#540). */
async function noViolations(root: HTMLElement = document.body) {
  const r = await axe.run(root, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

const card = (name: string) => screen.findByRole("article", { name }, { timeout: 5_000 });
const posts = () => state.calls.filter((c) => c.method === "POST");
/** Nút "New version" ở đầu khối (thẻ "One more slot" có nút thứ hai cùng tên). */
function newVersion(): HTMLElement {
  const b = screen.getAllByRole("button", { name: "New version" })[0];
  if (b === undefined) throw new Error("New version button");
  return b;
}

/** #377: giả thuyết bắt buộc của version mới. */
const HYP = "Trading only High gives a better result after fees.";

describe("News bot versions: cards, gate and table", { timeout: 20_000 }, () => {
  it("summary bar, extra check and version cards follow the mockup", async () => {
    wrap();
    const bots = await screen.findByRole("region", { name: "Bots & labels" });
    const base = await card("News bot v3 · Baseline");
    expect(within(bots).getByText("2 of 3 slots in use")).toBeInTheDocument();
    expect(within(bots).getByText("Versions tried: 4")).toBeInTheDocument();
    expect(
      within(bots).getByText("Claude reader v2 · share right 84% (37 labels)", { exact: false }),
    ).toBeInTheDocument();
    expect(
      within(bots)
        .getByText(/Extra check is on\./)
        .closest("p"),
    ).toHaveTextContent("on its next 100 closed trades before it counts.");

    expect(
      within(base).getByText(
        "Saved Nov 18, 09:12 · can’t be changed · later versions are compared to it",
      ),
    ).toBeInTheDocument();
    expect(
      within(base).getByText(
        "All 12 news types · level Low and up · 500 USDC a trade · take profit 1.5× · stop loss 0.75× · uses Claude reader v2",
      ),
    ).toBeInTheDocument();
    expect(
      within(base)
        .getByText(/^7 open$/)
        .closest("p"),
    ).toHaveTextContent(
      "7 open (max 20) · 3 opened today (no daily limit) · 0 skipped by the limits",
    );
    expect(
      within(base).getByText(
        "31 closed trades aren’t counted: Claude reader v1 was right less than 80% of the time. Since Nov 19, 13:00 Claude reader v2 is used; it needs 13 labels.",
      ),
    ).toBeInTheDocument();
    expect(within(base).getByRole("button", { name: "Copy to new version" })).toBeInTheDocument();

    const v4 = await card("News bot v4 · Strict subject");
    expect(
      within(v4).getByText("Saved Nov 19, 13:05 by ··a91f · counts trades opened after that"),
    ).toBeInTheDocument();
    expect(within(v4).getByText(/^10 news types · level Medium and up/)).toBeInTheDocument();
    expect(within(v4).getByText("Not yet · label 13 signals first")).toBeInTheDocument();
    expect(
      within(v4)
        .getByText(/^0 open$/)
        .closest("p"),
    ).toHaveTextContent("0 open (max 20) · 0 opened today (max 5 a day) · 0 skipped by the limits");
    expect(
      within(v4).getByText(
        "Trades count once Claude reader v2 has 50 labels with 80% or more right (13 to go).",
      ),
    ).toBeInTheDocument();
    for (const b of ["Pause", "Stop", "Edit as new version", "Rules"])
      expect(within(v4).getByRole("button", { name: b })).toBeInTheDocument();

    // Paused + Only these 2 mã: Resume, "Effectively 2", tiến độ lặp lại của kiểm tra thêm.
    const v5 = await card("News bot v5 · Majors only");
    expect(within(v5).getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(within(v5).getByText("Effectively 2: one trade per asset")).toBeInTheDocument();
    expect(
      within(v5).getByText(
        "Passed on its first 120 closed trades. It must repeat the result on the next 100: 40 so far.",
      ),
    ).toBeInTheDocument();
    // Version đã dừng chỉ ở bảng.
    expect(screen.queryByRole("article", { name: "News bot v6 · Wider stops" })).toBeNull();
    expect(within(bots).getByRole("heading", { name: "One more slot" })).toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("All versions table: changes, classifiers, counted, blocked by limit and gate text", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "All News bot versions" });
    const row = (n: RegExp) => within(tbl).getByRole("row", { name: n });
    const v6 = row(/v6 · Wider stops/);
    expect(within(v6).getByText("SL 0.75× → 1.0×")).toBeInTheDocument();
    expect(within(v6).getByText("Stopped early")).toBeInTheDocument();
    expect(within(v6).getByText("2")).toBeInTheDocument();
    const v5 = row(/v5 · Majors only/);
    expect(within(v5).getByText("Passed once · repeat 40 / 100")).toBeInTheDocument();
    expect(
      within(v5).getByText(/Lowest level Medium → High · .*Only BTC-USD, ETH-USD/),
    ).toBeInTheDocument();
    expect(within(v5).getByText("+0.21%")).toBeInTheDocument();
    const v4 = row(/v4 · Strict subject/);
    expect(
      within(v4).getByText(/^Treasury buy off · Treasury sell off · Lowest level Low → Medium/),
    ).toBeInTheDocument();
    expect(within(v4).getByText("Not enough trades")).toBeInTheDocument();
    const v3 = row(/v3 · Baseline/);
    expect(within(v3).getByText("v1 → v2")).toBeInTheDocument();
    expect(within(v3).getByText("31 closed · 0 counted")).toBeInTheDocument();
    expect(within(v3).getByText("Not copied from a version")).toBeInTheDocument();
    // PM (#313): "under 80%" luôn kèm số nhãn.
    expect(
      within(v3).getByText("Not counting · Claude reader v1 under 80% right · 24 labels"),
    ).toBeInTheDocument();
  });

  it("gate texts: current classifier under 80% names it with its label count", () => {
    function Probe() {
      const t = useTranslations("signalAnalysis.research.versions");
      const labels = new Map(CLASSIFIERS.items.map((r) => [r.classifierVersion, r]));
      const v = {
        ...V4,
        gate: {
          ...V4.gate,
          status: "not_counted" as const,
          classifierStatus: "underPrecision" as const,
        },
      };
      return (
        <>
          <p>{gateText(v, labels, t)}</p>
          <p>{gateLines(v, labels, "UTC", t).join(" ")}</p>
          <p>
            {gateText(
              { ...BASELINE, gate: { ...BASELINE.gate, classifierStatus: "unknown" } },
              labels,
              t,
            )}
          </p>
        </>
      );
    }
    render(
      <Intl>
        <Probe />
      </Intl>,
    );
    expect(
      screen.getByText("Not counting · Claude reader v2 under 80% right · 37 labels"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Not counting: Claude reader v2 was right less than 80% of the time (37 labels).",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Not counted")).toBeInTheDocument();
  });

  it("choosing a version switches versionId of the summary, news feed and trades", async () => {
    wrap();
    const v4 = await card("News bot v4 · Strict subject");
    const pick = within(v4).getByRole("button", { name: "News bot v4 · Strict subject" });
    expect(pick).toHaveAttribute("aria-pressed", "false");
    state.calls = [];
    await userEvent.click(pick);
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.path.includes("/summary?") && c.path.includes(`versionId=${V4_ID}`),
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.path.includes("/articles?") && c.path.includes(`versionId=${V4_ID}`),
        ),
      ).toBe(true);
      expect(
        state.calls.some(
          (c) => c.path.includes("/trades?") && c.path.includes(`versionId=${V4_ID}`),
        ),
      ).toBe(true);
    });
    expect(
      within(await card("News bot v4 · Strict subject")).getByRole("button", {
        name: "News bot v4 · Strict subject",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    // Dải tóm tắt đánh dấu version đang hiện ở dưới ("shown below").
    const lines = screen.getByRole("list", { name: "Running News bot versions" });
    const cur = within(lines)
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("aria-current") === "true");
    expect(cur).toHaveTextContent(/^News bot · Strict subject \(v4\).*shown below$/);
    // Bảng All versions cũng chọn được.
    const tbl = screen.getByRole("table", { name: "All News bot versions" });
    await userEvent.click(within(tbl).getByRole("button", { name: "v5 · Majors only" }));
    await waitFor(() => {
      expect(state.calls.some((c) => c.path.includes(`versionId=${V5_ID}`))).toBe(true);
    });
  });

  it("Pause sends the status with an Idempotency-Key and shows Pausing… until the backend answers", async () => {
    wrap();
    const v4 = await card("News bot v4 · Strict subject");
    await userEvent.click(within(v4).getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const [p] = posts();
    expect(p?.path).toContain(`/versions/${V4_ID}/status`);
    expect(p?.body).toEqual({ status: "paused" });
    expect(p?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("Stop asks first, then sends stopped", async () => {
    wrap();
    const v4 = await card("News bot v4 · Strict subject");
    await userEvent.click(within(v4).getByRole("button", { name: "Stop" }));
    const dlg = await screen.findByRole("dialog", { name: "Stop v4 · Strict subject?" });
    expect(posts()).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole("button", { name: "Stop v4" }));
    await waitFor(() => {
      expect(posts()[0]?.body).toEqual({ status: "stopped" });
    });
  });
});

// Sheet dài, cả trang Signal Analysis render lại sau mỗi phím (#540): gõ không chờ timer giữa các phím
// (`delay: null`), dán câu giả thuyết dài thay vì gõ từng ký tự (không test nào kiểm hành vi từng phím của ô này),
// lần axe thứ hai chỉ quét phần mới (khối cảnh báo), và luồng dài được tách làm hai test.
describe("New version sheet", { timeout: 20_000 }, () => {
  let user: UserEvent;
  beforeEach(() => {
    user = userEvent.setup({ delay: null });
  });
  /** Ô giả thuyết (#377): dán cả câu, một lần render thay vì một lần mỗi ký tự. */
  async function pasteHypothesis(dlg: HTMLElement) {
    await user.click(within(dlg).getByRole("textbox", { name: "Hypothesis (one sentence)" }));
    await user.paste(HYP);
  }
  async function openNew(): Promise<HTMLElement> {
    await card("News bot v3 · Baseline");
    await user.click(newVersion());
    return screen.findByRole("dialog", { name: "New version" });
  }

  it("validation: dot decimals, TP vs cost at least 1, Name and hypothesis required", async () => {
    wrap();
    const dlg = await openNew();
    expect(within(dlg).getByText("Saving creates v7.")).toBeInTheDocument();
    expect(
      within(dlg).getByText("Running 2 of 3 · saving starts v7 now · written to the audit log"),
    ).toBeInTheDocument();

    const tp = within(dlg).getByRole("textbox", { name: "Take profit" });
    await user.clear(tp);
    await user.type(tp, "1,5");
    expect(
      within(dlg).getByText("Use a number like 1.5, with a dot for decimals."),
    ).toBeInTheDocument();
    const minTp = within(dlg).getByRole("textbox", { name: "Skip if take profit is under" });
    await user.clear(minTp);
    await user.type(minTp, "0.5");
    expect(
      within(dlg).getAllByText("At least 1. Below 1 the fees are bigger than the take profit."),
    ).toHaveLength(2);
    await user.click(within(dlg).getByRole("button", { name: "Save and start v7" }));
    expect(within(dlg).getByRole("alert")).toHaveTextContent("Fix the fields marked above.");
    expect(within(dlg).getByRole("textbox", { name: "Name" })).toHaveAccessibleDescription(
      "Required.",
    );
    expect(posts()).toHaveLength(0);

    await user.type(within(dlg).getByRole("textbox", { name: "Name" }), "High only");
    await user.clear(tp);
    await user.type(tp, "1.5");
    await user.clear(minTp);
    await user.type(minTp, "2");
    expect(within(dlg).queryByText("Use a number like 1.5, with a dot for decimals.")).toBeNull();
    // Chỉ còn câu gợi ý cố định của ô (cùng chữ với lỗi).
    expect(
      within(dlg).getAllByText("At least 1. Below 1 the fees are bigger than the take profit."),
    ).toHaveLength(1);
    // #377: thiếu giả thuyết thì không gửi.
    await user.click(within(dlg).getByRole("button", { name: "Save and start v7" }));
    const hyp = within(dlg).getByRole("textbox", { name: "Hypothesis (one sentence)" });
    expect(hyp).toHaveAttribute("aria-invalid", "true");
    expect(hyp).toHaveAccessibleDescription("Required.");
    expect(posts()).toHaveLength(0);
    expect(intlErrors).toEqual([]);
  });

  it("4 changes from Baseline warn first; Save and start anyway sends the exact payload with one key", async () => {
    wrap();
    const dlg = await openNew();
    await user.type(within(dlg).getByRole("textbox", { name: "Name" }), "High only");
    // Gõ lại TP và mức tối thiểu bằng đúng giá trị Baseline: payload phải giữ nguyên chuỗi.
    const tp = within(dlg).getByRole("textbox", { name: "Take profit" });
    await user.clear(tp);
    await user.type(tp, "1.5");
    const minTp = within(dlg).getByRole("textbox", { name: "Skip if take profit is under" });
    await user.clear(minTp);
    await user.type(minTp, "2");
    await user.selectOptions(
      within(dlg).getByRole("combobox", { name: "Lowest level to trade" }),
      "high",
    );
    await user.click(within(dlg).getByRole("checkbox", { name: "Trade Treasury buy" }));
    await user.click(within(dlg).getByRole("radio", { name: "Limit" }));
    await user.type(within(dlg).getByRole("textbox", { name: "Trades per day" }), "4");
    await user.click(within(dlg).getByRole("radio", { name: "Close at market" }));
    await pasteHypothesis(dlg);
    expect(within(dlg).getByRole("textbox", { name: "Hypothesis (one sentence)" })).toHaveValue(
      HYP,
    );
    await noViolations();
    await user.click(within(dlg).getByRole("button", { name: "Save and start v7" }));
    // Đổi 4 thứ so với Baseline (level, Treasury buy, giới hạn ngày, tin ngược chiều): cảnh báo, chưa gửi.
    const warn = await within(dlg).findByRole("alert");
    expect(warn).toHaveTextContent(
      "Changes from Baseline (v3): Treasury buy off · Lowest level Low → High · Max new trades per day Off → 4 · Opposite news Keep → Close at market",
    );
    expect(warn).toHaveTextContent(
      "This version changes 4 things from Baseline. If its result differs, you won’t know which change caused it. Keep one change per version.",
    );
    expect(posts()).toHaveLength(0);
    // Back to edit đóng cảnh báo; lưu lại thì cảnh báo hiện lại; Save and start anyway thì gửi.
    await user.click(within(warn).getByRole("button", { name: "Back to edit" }));
    expect(within(dlg).queryByText(/things from Baseline/)).toBeNull();
    await user.click(within(dlg).getByRole("button", { name: "Save and start v7" }));
    // Từ lần quét cả trang ở trên chỉ có khối cảnh báo là mới: quét lại riêng nó (luật cần cả trang như
    // duplicate-id vẫn tra theo document).
    const again = await within(dlg).findByRole("alert");
    await noViolations(again);
    await user.click(within(again).getByRole("button", { name: "Save and start anyway" }));
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const base = baselineVersionConfig();
    const want = {
      name: "High only",
      config: {
        ...base,
        minLevel: "high",
        news: { ...base.news, treasury_buy: { enabled: false, maxHoldHours: 48 } },
        maxNewTradesPerDay: 4,
        onOppositeNews: "close",
      },
      savedFromVersionId: null,
      start: true,
      hypothesis: HYP,
    };
    expect(posts()[0]?.body).toEqual(want);
    expect(researchVersionCreateBodySchema.parse(posts()[0]?.body)).toEqual(want);
    expect(posts()[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    // Lưu xong: sheet đóng, câu báo, tổng kết chuyển sang version mới.
    // #377: lưu qua "Save and start anyway" thì câu báo thêm "Saved anyway…" (mockup catalyst-experiments-1440).
    expect(
      await screen.findByText(
        "Saved v7 · High only. Saved anyway: the experiment shows “Not a clean test” in Bots & labels › Experiments.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(state.calls.some((c) => c.path.includes(`versionId=${NEW_ID}`))).toBe(true);
    });
    expect(intlErrors).toEqual([]);
  });

  it("copy from v4: Changed from v4 summary, Only these hides Crypto / Stocks, picker, Effectively N", async () => {
    wrap();
    const v4 = await card("News bot v4 · Strict subject");
    await user.click(within(v4).getByRole("button", { name: "Edit as new version" }));
    const dlg = await screen.findByRole("dialog", { name: "New version · from v4" });
    expect(
      within(dlg).getByText("Saving creates v7. v4 keeps running unchanged."),
    ).toBeInTheDocument();
    expect(within(dlg).getByText("No changes from v4 yet.")).toBeInTheDocument();
    await user.selectOptions(
      within(dlg).getByRole("combobox", { name: "Lowest level to trade" }),
      "high",
    );
    expect(within(dlg).getByText(/^Changed from v4:/)).toHaveTextContent(
      "Changed from v4: Lowest level Medium → High.",
    );
    expect(within(dlg).getByRole("checkbox", { name: "Crypto" })).toBeInTheDocument();
    await user.click(within(dlg).getByRole("radio", { name: "Only these" }));
    expect(within(dlg).queryByRole("checkbox", { name: "Crypto" })).toBeNull();
    expect(within(dlg).queryByRole("checkbox", { name: "Stocks on SoDEX" })).toBeNull();
    const search = await within(dlg).findByRole("combobox", { name: "Search SoDEX markets" });
    await user.type(search, "btc");
    await user.keyboard("{Enter}");
    await user.clear(search);
    await user.type(search, "eth");
    await user.keyboard("{Enter}");
    expect(within(dlg).getByText("Effectively 2: one trade per asset")).toBeInTheDocument();
    expect(within(dlg).getByText(/^Changed from v4:/)).toHaveTextContent(
      "Changed from v4: Lowest level Medium → High · Assets All → Only these · Only BTC-USD, ETH-USD.",
    );
    // Esc chỉ đóng danh sách, không đóng sheet.
    await user.keyboard("{Escape}");
    expect(within(dlg).queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "New version · from v4" })).toBeInTheDocument();
    await user.type(within(dlg).getByRole("textbox", { name: "Name" }), "Majors");
    await pasteHypothesis(dlg);
    await user.click(within(dlg).getByRole("button", { name: "Save and start v7" }));
    // #377: so với Baseline (không phải v4) đổi nhiều thứ → cảnh báo trước, lưu khi bấm "Save and start anyway".
    expect(
      await within(dlg).findByText(/^This version changes \d+ things from Baseline\./),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    await user.click(within(dlg).getByRole("button", { name: "Save and start anyway" }));
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const body = posts()[0]?.body as { config: { assets: unknown }; savedFromVersionId: string };
    expect(body.savedFromVersionId).toBe(V4_ID);
    expect(body.config.assets).toEqual({
      mode: "only",
      markets: ["BTC-USD", "ETH-USD"],
      crypto: true,
      stocks: true,
    });
  });

  it("at 3 of 3 the Save button is off: Pause or stop a version first.", async () => {
    state.versions = VERSIONS_FULL;
    wrap();
    await card("News bot v3 · Baseline");
    expect(screen.queryByRole("heading", { name: "One more slot" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "New version" }));
    const dlg = await screen.findByRole("dialog", { name: "New version" });
    expect(within(dlg).getByRole("button", { name: "Save and start v6" })).toBeDisabled();
    expect(within(dlg).getByText("Pause or stop a version first.")).toBeInTheDocument();
  });

  it("shows the stale market list warning of the response", async () => {
    state.create = "stale";
    wrap();
    await card("News bot v3 · Baseline");
    await user.click(newVersion());
    const dlg = await screen.findByRole("dialog", { name: "New version" });
    await user.type(within(dlg).getByRole("textbox", { name: "Name" }), "X");
    await pasteHypothesis(dlg);
    await user.click(within(dlg).getByRole("button", { name: "Save and start v7" }));
    expect(
      await screen.findByText(
        "Saved v7 · X. The market list was out of date when the assets were checked.",
      ),
    ).toBeInTheDocument();
  });

  it("API errors: 3 running and an unlisted market say what to do; the sheet stays open", async () => {
    state.create = "unlisted";
    wrap();
    await card("News bot v3 · Baseline");
    await user.click(newVersion());
    const dlg = await screen.findByRole("dialog", { name: "New version" });
    await user.type(within(dlg).getByRole("textbox", { name: "Name" }), "X");
    await pasteHypothesis(dlg);
    await user.click(within(dlg).getByRole("button", { name: "Save and start v7" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(
      "Not listed on SoDEX now: SOLV-USD.",
    );
    state.create = "full";
    await user.click(within(dlg).getByRole("button", { name: "Save and start v7" }));
    await waitFor(() => {
      expect(within(dlg).getByRole("alert")).toHaveTextContent("Pause or stop a version first.");
    });
  });

  it("a network error is retried once with the same Idempotency-Key", async () => {
    state.create = "network-once";
    wrap();
    await card("News bot v3 · Baseline");
    await user.click(newVersion());
    const dlg = await screen.findByRole("dialog", { name: "New version" });
    await user.type(within(dlg).getByRole("textbox", { name: "Name" }), "Retry");
    await pasteHypothesis(dlg);
    await user.click(within(dlg).getByRole("button", { name: "Save and start v7" }));
    await waitFor(
      () => {
        expect(posts()).toHaveLength(2);
      },
      { timeout: 4000 },
    );
    expect(posts()[0]?.key).toBe(posts()[1]?.key);
    expect(await screen.findByText("Saved v7 · Retry.")).toBeInTheDocument();
  });

  it("Rules opens the saved config read-only", async () => {
    wrap();
    const v4 = await card("News bot v4 · Strict subject");
    await user.click(within(v4).getByRole("button", { name: "Rules" }));
    const dlg = await screen.findByRole("dialog", { name: "Rules · News bot v4 · Strict subject" });
    expect(within(dlg).getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(within(dlg).getByRole("textbox", { name: "Name" })).toHaveValue("Strict subject");
    expect(within(dlg).getByRole("checkbox", { name: "Trade Treasury buy" })).not.toBeChecked();
    expect(within(dlg).queryByRole("button", { name: /Save/ })).toBeNull();
  });
});

describe("sheet helpers", () => {
  const ok = { ...draftOf(baselineVersionConfig(), "A", HYP) };
  it("validate: required, dot decimals, whole numbers, ranges, balance, assets", () => {
    expect(validate(ok)).toEqual({});
    expect(validate({ ...ok, name: " " }).name).toEqual({ key: "required" });
    // #377: giả thuyết bắt buộc, một dòng, tối đa 200 ký tự.
    expect(validate({ ...ok, hypothesis: "  " }).hypothesis).toEqual({ key: "required" });
    expect(validate({ ...ok, hypothesis: "x".repeat(201) }).hypothesis).toEqual({
      key: "range",
      min: 1,
      max: 200,
    });
    expect(validate({ ...ok, size: "1,5" }).size).toEqual({ key: "number" });
    expect(validate({ ...ok, size: "0" }).size).toEqual({ key: "positive" });
    expect(validate({ ...ok, size: "10000.01" }).size).toEqual({ key: "aboveBalance" });
    expect(validate({ ...ok, minTp: "0.99" }).minTp).toEqual({ key: "atLeastOne" });
    expect(validate({ ...ok, minTp: "1" }).minTp).toBeUndefined();
    expect(validate({ ...ok, maxDelay: "31" }).maxDelay).toEqual({ key: "range", min: 1, max: 30 });
    expect(validate({ ...ok, maxOpen: "2.5" }).maxOpen).toEqual({ key: "whole" });
    expect(validate({ ...ok, dayLimit: true, perDay: "" }).perDay).toEqual({ key: "required" });
    expect(validate({ ...ok, mode: "only", markets: [] }).markets).toEqual({ key: "pickAsset" });
    expect(validate({ ...ok, crypto: false, stocks: false }).kinds).toEqual({ key: "pickKind" });
    // Only these bỏ qua Crypto / Stocks.
    expect(
      validate({ ...ok, mode: "only", markets: ["SOL-USD"], crypto: false, stocks: false }),
    ).toEqual({});
  });
  it("configOf / bodyOf: All mode sends an empty list but keeps picked assets in the draft", () => {
    const d = { ...ok, mode: "all" as const, markets: ["SOL-USD"] };
    expect(configOf(d)?.assets.markets).toEqual([]);
    expect(configOf({ ...d, mode: "except" })?.assets.markets).toEqual(["SOL-USD"]);
    expect(bodyOf({ ...ok, name: "  B ", hypothesis: ` ${HYP} ` }, V4)).toMatchObject({
      name: "B",
      savedFromVersionId: V4_ID,
      start: true,
      hypothesis: HYP,
    });
    expect(bodyOf({ ...ok, hypothesis: "" }, null)).toBeNull();
    // Giả thuyết trống không chặn phần "Changed from vN" (config vẫn tính được).
    expect(configOf({ ...ok, hypothesis: "" })).not.toBeNull();
    expect(bodyOf({ ...ok, tp: "x" }, null)).toBeNull();
    expect(bodyOf({ ...ok, name: "" }, null)).toBeNull();
    // Tên trống không chặn phần "Changed from vN" (config vẫn tính được).
    expect(configOf({ ...ok, name: "" })).not.toBeNull();
  });
});

describe("asset picker", { timeout: 20_000 }, () => {
  function Harness({
    markets,
    mobile = false,
    initial = [],
  }: {
    markets: MarketsState;
    mobile?: boolean;
    initial?: string[];
  }) {
    const [v, setV] = useState<string[]>(initial);
    return (
      <Intl>
        <AssetPicker markets={markets} value={v} onChange={setV} mode="only" mobile={mobile} />
        <output data-testid="value">{v.join(",")}</output>
      </Intl>
    );
  }
  const ready: MarketsState = { data: MARKETS, loading: false, error: false };

  it("search, groups, Halted tag, keyboard ↑ ↓ Enter Esc, chips with × and Clear all", async () => {
    render(<Harness markets={ready} />);
    const input = screen.getByRole("combobox", { name: "Search SoDEX markets" });
    await userEvent.click(input);
    const list = screen.getByRole("listbox", { name: "SoDEX markets" });
    expect(within(list).getByRole("group", { name: "Crypto" })).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: /XYZ-USD/ })).toHaveTextContent("Halted");
    await userEvent.type(input, "sol");
    const opts = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(opts.map((o) => o.textContent)).toEqual([
      expect.stringContaining("SOL-USD · Solana"),
      expect.stringContaining("SOLV-USD · Solv Protocol"),
    ]);
    expect(screen.getByText('No stock matches "sol"')).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-activedescendant", opts[0]?.id);
    await userEvent.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", opts[1]?.id);
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("SOL-USD");
    expect(screen.getByRole("option", { name: /SOL-USD · Solana/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(screen.getByRole("option", { name: /SOLV-USD/ }));
    expect(screen.getByTestId("value")).toHaveTextContent("SOL-USD,SOLV-USD");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove SOL-USD" }));
    expect(screen.getByTestId("value")).toHaveTextContent("SOLV-USD");
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByTestId("value")).toHaveTextContent("");
    await noViolations();
  });

  it("stale list warns; missing list disables the picker with a message", () => {
    const stale: ResearchMarkets = { ...MARKETS, stale: true };
    const a = render(<Harness markets={{ data: stale, loading: false, error: false }} />);
    expect(screen.getByText("Market list may be out of date")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search SoDEX markets" })).toBeEnabled();
    a.unmount();
    render(
      <Harness
        markets={{
          data: { items: null, updatedAt: null, stale: true },
          loading: false,
          error: false,
        }}
        initial={["BTC-USD"]}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Search SoDEX markets" })).toBeDisabled();
    expect(
      screen.getByText(
        "The SoDEX market list isn’t available yet, so assets can’t be picked. Try again in a few minutes.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Market list may be out of date")).toBeNull();
    // Chip đã chọn vẫn hiện (không mất dữ liệu).
    expect(screen.getByRole("button", { name: "Remove BTC-USD" })).toBeInTheDocument();
  });

  it("mobile: bottom sheet with search, chips and Done · n picked", async () => {
    render(<Harness markets={ready} mobile initial={["BTC-USD"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Pick assets" }));
    const dlg = await screen.findByRole("dialog", { name: "Only these assets" });
    await userEvent.type(
      within(dlg).getByRole("combobox", { name: "Search SoDEX markets" }),
      "sol",
    );
    await userEvent.click(within(dlg).getByRole("option", { name: /SOL-USD · Solana/ }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Done · 2 picked" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("value")).toHaveTextContent("BTC-USD,SOL-USD");
  });
});
