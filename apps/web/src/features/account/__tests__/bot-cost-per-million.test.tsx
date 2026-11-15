// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { BotCostPerMillion } from "../components/bot-cost-per-million";

// Cost per $1M ở Team › Users › chi tiết: chỉ bot Market Making; chưa có khối lượng thì "Not available", không phải 0.

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

afterEach(cleanup);

describe("BotCostPerMillion", () => {
  it("shows the cost per $1M of a Market Making bot as the backend returns it", () => {
    const { container } = wrap(
      <BotCostPerMillion bot={{ strategy: "volume_maker", costPerMillion: "250" }} />,
    );
    expect(container).toHaveTextContent(/^250$/);
  });

  it("shows the cost per $1M of a Volume Farm bot too", () => {
    const { container } = wrap(
      <BotCostPerMillion bot={{ strategy: "volume_farm", costPerMillion: "300" }} />,
    );
    expect(container).toHaveTextContent(/^300$/);
  });

  it("shows Not available, never 0, when the bot has no volume yet", () => {
    const { container } = wrap(
      <BotCostPerMillion bot={{ strategy: "volume_maker", costPerMillion: null }} />,
    );
    expect(container).toHaveTextContent(/^Not available$/);
  });

  it("shows nothing for other strategies", () => {
    const { container } = wrap(
      <BotCostPerMillion bot={{ strategy: "spot_grid", costPerMillion: null }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
