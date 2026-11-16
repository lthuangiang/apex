// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { MarketHoursView } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { MarketHoursPage, usd } from "../components/market-hours-page";

// Market hours (docs/mockups/market-hours): múi giờ của trình duyệt (ở đây Asia/Kolkata +5:30) + nút đổi sang UTC;
// thiếu số → "n/a", không bao giờ 0; ô mẫu mỏng gắn "Thin"; trạng thái rỗng / lỗi / không phải team; axe.

vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../market-hours-time", async (orig) => ({
  ...(await orig<typeof import("../market-hours-time")>()),
  browserTimeZone: () => "Asia/Kolkata",
}));

const mock = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(public code: string) {
      super(code);
    }
  }
  const state: { respond: (path: string) => Promise<unknown> } = {
    respond: () => Promise.reject(new Error("not set")),
  };
  return { FakeApiError, calls: [] as string[], state };
});
const { FakeApiError, calls } = mock;
vi.mock("@/lib/api", () => ({
  ApiError: mock.FakeApiError,
  api: (_m: string, path: string) => {
    mock.calls.push(path);
    return mock.state.respond(path);
  },
}));
const setRespond = (fn: (path: string) => Promise<unknown>) => {
  mock.state.respond = fn;
};

function view(over: Partial<MarketHoursView> = {}): MarketHoursView {
  return {
    market: "BTC-USD",
    markets: ["BTC-USD", "ETH-USD"],
    days: 30,
    strategy: "both",
    tz: "Asia/Kolkata",
    hours: Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      volatility: {
        medianBp: h === 3 ? null : "4.25",
        p90Bp: h === 3 ? null : "9.1",
        ratio: h === 3 ? null : h === 20 ? "2.4" : "1",
        hotPct: h === 3 ? null : h === 20 ? 60 : 0,
        fiveMin: Array.from({ length: 12 }, () => "4.2"),
        swingBp: h === 3 ? null : h === 21 ? "12.43" : "4.1",
        estCostPerMillion: h === 3 ? null : h === 21 ? "214.37" : "88.5",
        // "incl. shock days": giờ 21 có 9 / 30 ngày sốc → trung bình cao hơn ngày điển hình.
        estShockCostPerMillion: h === 3 ? null : h === 21 ? "336.1" : "95.25",
        estDays: h === 3 ? null : 30,
        shockDays: h === 3 ? null : h === 21 ? 9 : 1,
        // Giờ 08 (Kolkata): một phút 133 bp và chuỗi 15 phút 276 bp (bắt đầu 08:57 Kolkata = 03:27 UTC).
        maxRangeBp: h === 3 ? null : h === 8 ? "133.24" : "8.5",
        maxRangeAt:
          h === 3 ? null : h === 8 ? "2026-11-15T03:31:00.000Z" : "2026-11-14T00:00:00.000Z",
        maxMove15Bp: h === 3 ? null : h === 8 ? "276.43" : "30.2",
        maxMove15At:
          h === 3 ? null : h === 8 ? "2026-11-15T03:27:00.000Z" : "2026-11-14T00:00:00.000Z",
      },
      cost: { markoutBp: h === 3 ? null : "-1.2", spreadTicks: h === 3 ? null : 1.5 },
      bots:
        h === 3
          ? { costPerMillion: null, volume: null, fees: null, botHours: 0, thin: false }
          : {
              costPerMillion: "150",
              volume: "73000",
              fees: h === 5 ? "0.3125" : "10.2",
              botHours: h === 4 ? 2 : 8,
              thin: h === 4,
            },
    })),
    heatmap: [
      {
        date: "2026-11-15",
        cells: Array.from({ length: 24 }, (_, h) => ({
          ratio: h === 3 ? null : "1",
          medianBp: h === 3 ? null : "4.2",
        })),
      },
    ],
    candlesSince: "2026-10-02T00:00:00.000Z",
    markoutSince: "2026-11-12T00:00:00.000Z",
    markoutDays: 4,
    fillsSince: "2026-10-20T00:00:00.000Z",
    estimate: {
      feesBp: "0.7",
      stepBp: "1.02",
      modelVersion: 3,
      unavailable: null,
      shockBp: 15,
      cutTakerBp: "4",
      cutSlippageBp: null,
      cutCostBp: "4",
      cuts: 2,
      cutNotional: null,
      // Chưa đủ lệnh cắt thật: cỡ cắt = vị thế tối đa trung bình $20 ÷ $698 volume một bot-hour.
      botHourVolume: "698",
      maxPosition: "20",
      cutShare: "0.0287",
      cutShareSource: "position",
      calibration: "1.42",
      calibrationHours: 18,
    },
    ...over,
  };
}

const show = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MarketHoursPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  calls.length = 0;
  setRespond(() => Promise.resolve(view()));
});
afterEach(cleanup);

describe("Market hours page", () => {
  it("shows hours in the viewer's time zone and switches to UTC on demand", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    expect(
      await screen.findByText(/Times in your time zone: Asia\/Kolkata \(UTC\+5:30\)/),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.some((c) => c.includes("tz=Asia%2FKolkata"))).toBe(true);
    });
    await user.click(screen.getByRole("button", { name: "Show in UTC" }));
    expect(screen.getByText(/^Times in UTC/)).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.at(-1)).toContain("tz=UTC");
    });
    expect(screen.getByRole("button", { name: "Show my time zone" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("falls back to UTC when the API rejects the browser's time zone, without an error", async () => {
    setRespond((path) =>
      path.includes("tz=Asia%2FKolkata")
        ? Promise.reject(new FakeApiError("VALIDATION_FAILED"))
        : Promise.resolve(view({ tz: "UTC" })),
    );
    show();
    expect(await screen.findByText("1 · Market volatility on SoDEX")).toBeInTheDocument();
    expect(calls.some((c) => c.includes("tz=Asia%2FKolkata"))).toBe(true);
    expect(calls.at(-1)).toContain("tz=UTC");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("marks US stock open in the local column and says missing numbers are n/a, never 0", async () => {
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    // Kolkata: mốc 00:00 UTC là 05:30 địa phương.
    expect(screen.getAllByText(/05:30 · 00:00 UTC/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^US stock open \d\d:\d\d · 1\d:30 UTC$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("n/a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Thin").length).toBeGreaterThan(0);
    // Bản desktop và bản 390 px đều có chip (CSS chọn một), câu chữ theo từng artboard.
    expect(screen.getByText("Collecting since Nov 12, 2026 · 4 of 30 days")).toBeInTheDocument();
    expect(
      screen.getByText("Cost to make markets: collecting since Nov 12, 2026"),
    ).toBeInTheDocument();
    // Bản 390 px: thẻ mốc theo giờ UTC như thiết kế ("00 UTC" ở cột 05 Kolkata).
    expect(screen.getByText("00 UTC")).toBeInTheDocument();
    // Múi giờ lệch nửa giờ: khối 2 ghi rõ là xấp xỉ.
    expect(
      screen.getByText("Approximate in half-hour time zones: this block is collected by UTC hour."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Available since Oct 2, 2026\./)).toBeInTheDocument();
    expect(screen.getByText(/Kept for 90 days\./)).toBeInTheDocument();
  });

  it("hides leading days with no candles, says since when, and uses taller rows at 7 days", async () => {
    const day = (date: string, empty: boolean) => ({
      date,
      cells: Array.from({ length: 24 }, (_, h) => ({
        ratio: empty || h < 20 ? null : "1.2",
        medianBp: empty || h < 20 ? null : "4.2",
      })),
    });
    const heatmap = [
      day("2026-11-08", true),
      day("2026-11-09", true),
      day("2026-11-10", false),
      day("2026-11-11", false),
    ];
    setRespond((path) =>
      Promise.resolve(view({ days: path.includes("days=7") ? 7 : 30, heatmap })),
    );
    const user = userEvent.setup({ delay: null });
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    // 30 ngày: dòng gọn, nhãn ngắn; hai ngày đầu không có nến bị ẩn; ngày đầu có nến (thiếu vài giờ) vẫn hiện.
    expect(screen.getByText("Data since Nov 10, 2026")).toBeInTheDocument();
    expect(screen.queryByText("Nov 8")).not.toBeInTheDocument();
    expect(screen.queryByText("Nov 9")).not.toBeInTheDocument();
    expect(screen.getByText("Nov 10")).toBeInTheDocument();
    expect(screen.getAllByTitle("Nov 10, 2026 · 05:00 · Not available")[0]).toHaveClass("h-3.5");
    expect(screen.getByTitle(/^Nov 11, 2026 · 21:00 · median 1-min range 4\.2 bp/)).toHaveClass(
      "h-3.5",
    );
    // 7 ngày: dòng cao, nhãn có thứ.
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    expect(await screen.findByText("Tue, Nov 10")).toBeInTheDocument();
    expect(screen.getByTitle(/^Nov 11, 2026 · 21:00 · median 1-min range 4\.2 bp/)).toHaveClass(
      "h-7",
    );
    // Mốc ở tiêu đề giờ là chip nhỏ (US open), không còn khung cam quanh cột.
    expect(screen.getAllByText("US open")[0]).toHaveClass("rounded-full");
  });

  it("puts the time zone switch inside the filter card", async () => {
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    const filters = screen.getByRole("region", { name: "Filters" });
    expect(within(filters).getByRole("button", { name: "Show in UTC" })).toBeInTheDocument();
    expect(within(filters).getByText(/Times in your time zone/)).toBeInTheDocument();
  });

  it("shows the model's estimated cost per $1M for every hour, with a tooltip, under block 1", async () => {
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    // Hai dòng thay cho dòng "(model, floor)" cũ; chú giải chỉ "CPM"; CPM được giải nghĩa trong How to read this.
    expect(screen.getByText("Est. CPM · typical day (model)")).toBeInTheDocument();
    expect(screen.getByText("Est. CPM · incl. shock days (model)")).toBeInTheDocument();
    expect(screen.queryByText(/floor/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated cost per \$1M \(model/)).not.toBeInTheDocument();
    expect(screen.getAllByText("CPM").length).toBeGreaterThanOrEqual(3);
    expect(
      screen.getAllByText("CPM = cost per $1M of volume (fees plus price loss).").length,
    ).toBeGreaterThanOrEqual(1);
    const cell = screen.getByTitle(
      "21:00 · est. $214 per $1M · median 1-min swing 12.4 bp · fees 0.7 bp",
    );
    expect(cell).toHaveTextContent("$214");
    expect(cell).toHaveClass("bg-mh-cost-2");
    expect(screen.getByTitle(/^00:00 · est\. \$89 per \$1M/)).toHaveClass("bg-mh-cost-0");
    // Giờ không có nến: n/a, không bao giờ 0.
    expect(screen.getAllByTitle("03:00 · Not available").length).toBeGreaterThan(0);
    // "incl. shock days": số ngày sốc, chi phí cắt và giả định trong tooltip (chưa đủ lệnh cắt thật → chỉ phí taker).
    const shock = screen.getByTitle(
      "21:00 · avg $336 per $1M · 9 of 30 days had a 15-min move of 15 bp or more · cut cost 4.0 bp · assumes taker fee only · cut size = bots' max open position",
    );
    expect(shock).toHaveTextContent("$336");
    expect(shock).toHaveClass("bg-mh-cost-3");
    expect(screen.getByTitle(/^00:00 · avg \$95 per \$1M · 1 of 30 days/)).toHaveClass(
      "bg-mh-cost-0",
    );
    // Cách tính, giả định và hiệu chỉnh nằm trong "How these numbers are calculated".
    expect(
      screen.getByText(/Est\. CPM uses the same model as the Market Making cost card/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /cut cost in bp × 100 × \(one cut's size ÷ one Market Making bot's average volume per hour\)/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Cut cost: taker fee 4\.0 bp only\. There are 2 real position cuts/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /With fewer than 5 real cuts, one cut's size is taken as the bots' max open position: \$20 on average \(Max inventory, or order size × max orders\), against \$698 average volume per bot-hour of Market Making bots in this period \(2\.9%\)\. Real cuts are usually smaller, so this is an upper bound\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Over the hours with enough bot data, real bot cost was 1.4× this estimate.",
      ),
    ).toBeInTheDocument();
  });

  it("uses measured cut slippage when there are enough real cuts, and says when calibration is not available", async () => {
    setRespond(() =>
      Promise.resolve(
        view({
          estimate: {
            ...view().estimate,
            cutSlippageBp: "2.5",
            cutCostBp: "6.5",
            cuts: 12,
            cutNotional: "2400",
            botHourVolume: "48000",
            cutShare: "0.05",
            cutShareSource: "cuts",
            calibration: null,
            calibrationHours: 1,
          },
        }),
      ),
    );
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    // Đủ lệnh cắt: không ghi "taker fee only", cỡ cắt đo từ lệnh cắt thật nên không có đuôi giả định.
    expect(
      screen.getByTitle(
        "21:00 · avg $336 per $1M · 9 of 30 days had a 15-min move of 15 bp or more · cut cost 6.5 bp",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTitle(/^00:00 · avg \$95 .* cut cost 6\.5 bp$/)).toBeInTheDocument();
    expect(screen.queryByTitle(/assumes taker fee only/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/max open position/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Cut cost: taker fee 4\.0 bp plus 2\.5 bp average slippage, measured from 12 real position cuts.*One cut's size is \$2400, the average of those cuts, against \$48000 average volume per bot-hour of Market Making bots in this period \(5%\)\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Over the hours with enough bot data, real bot cost compared with this estimate: Not available (fewer than 3 hours with 3 or more bot-hours).",
      ),
    ).toBeInTheDocument();
  });

  it("leaves position cuts out and says so when there are too few real cuts and nothing to size one", async () => {
    setRespond(() =>
      Promise.resolve(
        view({
          estimate: {
            ...view().estimate,
            botHourVolume: null,
            maxPosition: null,
            cutShare: null,
            cutShareSource: null,
          },
        }),
      ),
    );
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    expect(
      screen.getByTitle(
        "21:00 · avg $336 per $1M · 9 of 30 days had a 15-min move of 15 bp or more · cut cost 4.0 bp · position cuts not included (too few real cuts)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Position cuts not included \(too few real cuts\): fewer than 5 real cuts, and no Market Making bot volume in this period to size one\./,
      ),
    ).toBeInTheDocument();
  });

  it("shows the whole estimate row as n/a with the reason when the model can't run for the market", async () => {
    setRespond(() =>
      Promise.resolve(
        view({
          hours: view().hours.map((h) => ({
            ...h,
            volatility: { ...h.volatility, estCostPerMillion: null, estShockCostPerMillion: null },
          })),
          estimate: {
            ...view().estimate,
            feesBp: "1.5",
            stepBp: null,
            modelVersion: 0,
            unavailable: "no_market_info",
          },
        }),
      ),
    );
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    // Cả hai dòng Est. CPM đều n/a kèm lý do.
    const na = screen.getAllByTitle(
      "12:00 · Not available · SoDEX market info (tick size) is not available for this market.",
    );
    expect(na).toHaveLength(2);
    for (const c of na) expect(c).toHaveTextContent("n/a");
    expect(screen.queryByTitle(/avg \$/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/est\. \$/)).not.toBeInTheDocument();
  });

  it("shows each hour's largest 1-minute range and 15-minute move, with colour bins and ▲ for shocks", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    expect(screen.getByText("Largest 1-min range (bp)")).toBeInTheDocument();
    expect(screen.getByText("Largest 15-min move (bp)")).toBeInTheDocument();
    // 03:31 UTC = 09:01 Kolkata; 03:27 UTC = 08:57 Kolkata.
    const range = screen.getByTitle("133.2 bp · Nov 15, 2026, 09:01 (your time zone)");
    expect(range).toHaveTextContent("133▲");
    expect(range).toHaveClass("bg-mh-shock-3");
    const move = screen.getByTitle("276.4 bp · starts Nov 15, 2026, 08:57");
    expect(move).toHaveTextContent("276▲");
    expect(move).toHaveClass("bg-mh-shock-3");
    // Dưới ngưỡng: bậc thấp, không có ▲.
    const calm = screen.getAllByTitle("30.2 bp · starts Nov 14, 2026, 05:30");
    expect(calm[0]).toHaveTextContent(/^30$/);
    expect(calm[0]).toHaveClass("bg-mh-shock-1");
    expect(screen.getAllByTitle(/^8\.5 bp · /)[0]).toHaveClass("bg-mh-shock-0");
    // Chú giải ghi rõ ngưỡng.
    expect(screen.getByText("Largest moves (bp)")).toBeInTheDocument();
    expect(screen.getByText("100 or more ▲")).toBeInTheDocument();
    // 390 px: chi tiết giờ 08 có cả hai số.
    const row = screen
      .getAllByRole("button", { expanded: false })
      .find((b) => within(b).queryByText("08") !== null);
    expect(row).toBeDefined();
    if (row === undefined) return;
    await user.click(row);
    expect(
      screen.getByText("133.2 bp · Nov 15, 2026, 09:01 (your time zone) ▲", { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("276.4 bp · starts Nov 15, 2026, 08:57 ▲", { exact: false }),
    ).toBeInTheDocument();
  });

  it("shows cents for money under $10 so small fees are never $0", async () => {
    expect(usd("0.3125")).toBe("$0.31");
    expect(usd("0.004")).toBe("$0.00");
    expect(usd("9.995")).toBe("$10.00");
    expect(usd("10.2")).toBe("$10");
    expect(usd("249.99")).toBe("$250");
    expect(usd("-3.5")).toBe("$-3.50");
    expect(usd(null)).toBeNull();
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    expect(screen.getByText("$0.31")).toBeInTheDocument();
  });

  it("opens an hour's details on the phone layout", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    const row = screen
      .getAllByRole("button", { expanded: false })
      .find((b) => within(b).queryByText("07") !== null);
    expect(row).toBeDefined();
    if (row === undefined) return;
    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(
        /Median 4\.3 bp · p90 9\.1 bp · spread 1\.5 ticks · volume \$73K · 8 bot-hours/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("$89 (model) · median 1-min swing 4.1 bp · fees 0.7 bp"),
    ).toBeInTheDocument();
    expect(screen.getByText("Est. CPM · typical day")).toBeInTheDocument();
    expect(screen.getByText("Est. CPM · incl. shock days")).toBeInTheDocument();
    // Giờ 07: 1 / 30 ngày sốc; chưa đủ lệnh cắt thật → chỉ phí taker.
    expect(
      screen.getByText(
        "$95 (model) · 1 of 30 days had a 15-min move of 15 bp or more · assumes taker fee only · cut size = bots' max open position",
      ),
    ).toBeInTheDocument();
  });

  it("explains every row label with an info button that opens on click, hover or focus and closes on Escape", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    const median =
      "Typical size of one minute's price swing in this hour: (high − low) of each 1-minute candle as a share of price, middle value across the period. 1 bp = 0.01%.";
    const ratio =
      "How this hour compares with the rest of its day. 2.0× means minutes in this hour swung twice as much as a normal minute that day.";
    const hot =
      "Share of days in the period where this hour's typical swing was more than 2× that day's normal.";
    const markout =
      "How far the price moved against the resting (maker) side 30 seconds after public trades on SoDEX. Higher means makers got picked off more.";
    const maxRange =
      "The single wildest minute in this hour during the period: biggest (high − low) of a 1-minute candle, as a share of price.";
    const maxMove15 =
      "The furthest the price ran within any 15 minutes starting in this hour during the period. Shocks like this cause most position cuts.";
    const cost =
      "CPM (cost per $1M of volume): what DeskLabs bots really paid per $1M traded in this hour, fees plus the price move one minute after each fill. Counts only fills with a price one minute later.";
    // [nhãn, câu giải thích, số nút (desktop + tiêu đề cột 390 px)]
    const rows: [string, string, number][] = [
      ["Median 1-min range (bp)", median, 1],
      [
        "p90 1-min range (bp)",
        "A rough minute in this hour: 9 out of 10 minutes swung less than this.",
        1,
      ],
      ["× day median", ratio, 2],
      ["Hot days (> 2× day median)", hot, 1],
      ["Largest 1-min range (bp)", maxRange, 1],
      ["Largest 15-min move (bp)", maxMove15, 1],
      // Chi tiết giờ 390 px (mặc định mở giờ US open).
      ["Largest 1-min range", maxRange, 1],
      ["Largest 15-min move", maxMove15, 1],
      [
        "Est. CPM · typical day (model)",
        "CPM (cost per $1M of volume): model cost on a normal day for this hour, fees plus the price loss expected from the typical 1-minute swing.",
        1,
      ],
      [
        "Est. CPM · incl. shock days (model)",
        "CPM (cost per $1M of volume): model cost averaged over every day, including days with sharp moves. On days when the price ran 15 bp or more within 15 minutes, it adds the cost of a position cut (taker fee plus slippage), scaled by one cut's size against one bot's volume per hour.",
        1,
      ],
      ["Price move against makers, 30 s later (bp)", markout, 1],
      ["Spread (ticks)", "Typical gap between the best bid and best ask, in price steps.", 1],
      // Block 3 và tiêu đề cột 390 px đều là "CPM".
      ["CPM", cost, 2],
      ["Volume", "Value of all fills by DeskLabs bots in this hour, both buy and sell.", 1],
      ["Fees", "SoDEX trading fees plus builder fees paid on those fills.", 1],
      [
        "Bot-hours (bots × hours)",
        "One bot active for one hour. An hour counts for a bot when it placed at least one order in it. Fewer than 3 is a thin sample.",
        1,
      ],
      ["Hot days", hot, 1],
      ["Move vs makers 30 s", markout, 1],
    ];
    for (const [label, copy, n] of rows) {
      const buttons = screen.getAllByRole("button", { name: `About ${label}` });
      expect(buttons, label).toHaveLength(n);
      for (const b of buttons) {
        expect(b.tagName).toBe("BUTTON");
        await user.click(b);
        const tip = screen.getByRole("tooltip");
        expect(tip.textContent).toBe(copy);
        expect(b).toHaveAttribute("aria-describedby", tip.id);
        expect(b).toHaveAttribute("aria-expanded", "true");
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
        expect(b).toHaveAttribute("aria-expanded", "false");
      }
    }
    // Rê chuột: mở khi vào, đóng khi rời (chưa ghim).
    const spread = screen.getByRole("button", { name: "About Spread (ticks)" });
    await user.hover(spread);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Typical gap between the best bid and best ask, in price steps.",
    );
    // Rê từ nút sang popup: vẫn mở (WCAG 1.4.13); rời popup thì đóng.
    await user.unhover(spread);
    await user.hover(screen.getByRole("tooltip"));
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.unhover(screen.getByRole("tooltip"));
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
    // Focus bằng bàn phím: mở; tab sang nút kế (Bot-hours) thì popup Fees đóng, popup của nút kế mở.
    const fees = screen.getByRole("button", { name: "About Fees" });
    fees.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "SoDEX trading fees plus builder fees paid on those fills.",
    );
    await user.tab();
    expect(fees).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("tooltip")).toHaveTextContent(/^One bot active for one hour\./);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  }, 30_000);

  it("has no accessibility violations", async () => {
    show();
    await screen.findByText("1 · Market volatility on SoDEX");
    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    // Có popup đang mở cũng không vi phạm.
    await userEvent
      .setup({ delay: null })
      .click(screen.getByRole("button", { name: "About Median 1-min range (bp)" }));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    const open = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(open.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 30_000);

  it("says when there is no data, when loading failed, and when the viewer is not on the team", async () => {
    const user = userEvent.setup({ delay: null });
    setRespond(() =>
      Promise.resolve(
        view({
          heatmap: [],
          markoutDays: 0,
          hours: view().hours.map((h) => ({
            ...h,
            bots: { costPerMillion: null, volume: null, fees: null, botHours: 0, thin: false },
          })),
        }),
      ),
    );
    show();
    expect(await screen.findByText("No data for BTC-USD in the last 30 days.")).toBeInTheDocument();
    cleanup();

    let fail = true;
    setRespond(() => (fail ? Promise.reject(new Error("down")) : Promise.resolve(view())));
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load market hours.");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1 · Market volatility on SoDEX")).toBeInTheDocument();
    cleanup();

    setRespond(() => Promise.reject(new FakeApiError("FORBIDDEN")));
    show();
    expect(
      await screen.findByText("Market hours is for the DeskLabs team only."),
    ).toBeInTheDocument();
  });
});
