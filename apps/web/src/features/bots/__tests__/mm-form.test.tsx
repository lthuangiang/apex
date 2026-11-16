// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { BotForm } from "../components/bot-form";
import { emptyValues, FIELDS, type FormValues } from "../fields";

// Form Market Making theo thiết kế "MM form explained" (DEC-TBD-mm-form-copy): câu chữ riêng, số theo order size,
// khối "How your losses are capped" đổi theo Smart quoting, Position loss limit chỉ hiện khi tắt Smart quoting.

vi.mock("@/lib/markets", () => ({
  useMarketNames: () => ({ asset: (a: string) => a, market: (m: string) => m }),
  useMarkets: () => ({ data: { items: [] } }),
}));
vi.mock("../components/market-picker", () => ({
  MarketPicker: ({ value }: { value: string }) => <span>{value}</span>,
}));
vi.mock("../components/amount-lines", () => ({ AmountLines: () => null }));

afterEach(cleanup);

function Harness({ strategy, init }: { strategy: keyof typeof FIELDS; init: FormValues }) {
  const [values, setValues] = useState<FormValues>(init);
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <BotForm strategy={strategy} values={values} onChange={setValues} errors={{}} />
    </NextIntlClientProvider>
  );
}

const mmInit = (over: FormValues = {}): FormValues => ({
  ...emptyValues("volume_maker"),
  market: "BTC-USD",
  ...over,
});

describe("Market Making form copy", () => {
  it("renders the design labels, units and hints with the current order size", async () => {
    render(<Harness strategy="volume_maker" init={mmInit()} />);
    expect(screen.getByLabelText("Stop when costs reach")).toBeInTheDocument();
    expect(screen.getByLabelText("Stop after this much volume (optional)")).toHaveAttribute(
      "placeholder",
      "100,000",
    );
    expect(screen.getByText("When to stop")).toBeInTheDocument();
    expect(screen.getByText("The bot stops at whichever comes first.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "No end time" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "End of the SoPoints season" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "A date I choose" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Each quote is this size. At 20 USDC the bot keeps a 20 USDC buy order and a 20 USDC sell order in the order book.",
      ),
    ).toBeInTheDocument();
    // Advanced settings (ẩn nhưng có trong DOM).
    expect(screen.getByLabelText("Max position", { selector: "input" })).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByLabelText("Where to quote")).toBeInTheDocument();
    expect(screen.getByText("steps back")).toBeInTheDocument();
    expect(
      screen.getByText(
        "How much the bot may hold, counted in orders, 1–10. 1 = up to 20 USDC; 3 = up to 60 USDC. When it is full, the bot only posts the order that closes it.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Close the position", hidden: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Keep the position", hidden: true }),
    ).toBeInTheDocument();

    // Đổi order size → câu chữ đổi theo; xoá trống → bản không có số.
    const size = screen.getByLabelText("Order size per side");
    await userEvent.clear(size);
    await userEvent.type(size, "50");
    expect(
      screen.getByText(
        "Each quote is this size. At 50 USDC the bot keeps a 50 USDC buy order and a 50 USDC sell order in the order book.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Three checks run together. With 50 USDC orders:")).toBeInTheDocument();
    await userEvent.clear(size);
    expect(screen.getByText("Each quote is this size.")).toBeInTheDocument();
    expect(screen.getByText("Three checks run together.")).toBeInTheDocument();
    expect(screen.queryByText(/NaN|\b0 USDC/)).toBeNull();
  });

  it("“Also stop at” keeps the date picker for a season or a date", async () => {
    render(<Harness strategy="volume_maker" init={mmInit()} />);
    expect(screen.queryByLabelText("End date")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "A date I choose" }));
    expect(screen.getByLabelText("End date")).toBeInTheDocument();
  });
});

describe("How your losses are capped", () => {
  it("switches live with Smart quoting and shows Position loss limit only when off", async () => {
    render(<Harness strategy="volume_maker" init={mmInit({ maxOrders: "3" })} />);
    const block = () => screen.getByTestId("loss-caps");
    expect(block()).toHaveAttribute("data-smart", "on");
    expect(within(block()).getByRole("heading", { name: "Position cut" })).toBeInTheDocument();
    expect(
      within(block()).getByText(
        "The Binance price running 15 bp against the position you hold (about 0.03 USDC on 20 USDC)",
      ),
    ).toBeInTheDocument();
    expect(
      within(block()).getByText("How much the bot holds (set below, 60 USDC now)"),
    ).toBeInTheDocument();
    expect(
      within(block()).getByText(
        "Position cut is part of Smart quoting. Turn Smart quoting off to set a position loss limit in USDC instead.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Position loss limit/)).toBeNull();

    await userEvent.click(screen.getByRole("switch", { name: /Smart quoting/ }));
    expect(block()).toHaveAttribute("data-smart", "off");
    expect(within(block()).queryByRole("heading", { name: "Position cut" })).toBeNull();
    expect(
      within(block()).getByRole("heading", { name: "Position loss limit" }),
    ).toBeInTheDocument();
    expect(
      within(block()).getByText(
        "Without Smart quoting there is no position cut. Set a position loss limit if you want one. With 20 USDC orders:",
      ),
    ).toBeInTheDocument();
    expect(within(block()).getByText("How much the bot holds (60 USDC now)")).toBeInTheDocument();
    const input = within(block()).getByLabelText("Position loss limit (optional)");
    expect(input).toHaveAttribute("placeholder", "0.5");
    expect(
      within(block()).getByText(
        "Only the position the bot holds now, not fees or losses already taken. At 0.5 USDC: if the bot holds 20 USDC of BTC and BTC falls 2.5%, the bot stops. Leave empty to rely on Stop when costs reach.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Off: the bot quotes at the set position and replaces its quotes every refresh. More fills, higher cost per $1M.",
      ),
    ).toBeInTheDocument();
  });

  it("has no axe violations in both states", async () => {
    const { container } = render(<Harness strategy="volume_maker" init={mmInit()} />);
    const run = async () => {
      const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(r.violations.map((v) => v.id)).toEqual([]);
    };
    await run();
    await userEvent.click(screen.getByRole("switch", { name: /Smart quoting/ }));
    await run();
  });
});

describe("other strategies are unchanged", () => {
  it("Futures DCA renders the shared label and hint", () => {
    render(<Harness strategy="futures_dca" init={emptyValues("futures_dca")} />);
    const fields = messages.createBot.fields;
    expect(screen.getByLabelText(fields.fdcaTakeProfit.label)).toBeInTheDocument();
    expect(screen.getByText(fields.fdcaTakeProfit.hint)).toBeInTheDocument();
    expect(screen.queryByTestId("loss-caps")).toBeNull();
    expect(screen.queryByText("When to stop")).toBeNull();
  });
});
