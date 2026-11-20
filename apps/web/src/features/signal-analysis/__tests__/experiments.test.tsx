/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import type { ResearchVersion, ResearchVersions } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { BotsAndLabels } from "../research/bots-labels";
import { Experiments, experimentGroups } from "../research/experiments";
import { HowItWorksDrawer, HowItWorksProvider, type HowTab } from "../research/how-it-works";

import { E5, EXPERIMENT_VERSIONS, EXPERIMENT_VERSIONS_OLD } from "./experiments-fixtures";
import { CLASSIFIERS, VERSIONS } from "./versions-fixtures";

// Sổ thí nghiệm (#377; mockup docs/mockups/signal-research/catalyst-experiments-{1440,390}.png,
// catalyst-drawer-experiments-1440.png): nhóm Running / Finished, 4 kết quả và màu, "Not a clean test" kèm "Copy to new
// version", version cũ không có giả thuyết, "Claude reader not yet checked", dòng phụ của Bots & labels, tab drawer.

const state = vi.hoisted((): { versions: unknown } => ({ versions: null }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string, schema: z.ZodType) => {
      const p = new URL(path, "http://x").pathname;
      if (p.endsWith("/signal-research/versions"))
        return Promise.resolve(schema.parse(state.versions));
      if (p.endsWith("/signal-research/classifiers"))
        return Promise.resolve(schema.parse(CLASSIFIERS));
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});

vi.mock("@/lib/use-media", () => ({
  useMediaQuery: () => false,
  BELOW_LG: "(max-width: 1023px)",
}));

const intlErrors: string[] = [];
function Wrap({ children, onHow }: { children: ReactNode; onHow?: (t: HowTab) => void }) {
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
        <HowItWorksProvider value={onHow ?? null}>{children}</HowItWorksProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

function block(data: ResearchVersions, onCopy: (v: ResearchVersion) => void = () => undefined) {
  return render(
    <Wrap>
      <Experiments data={data} tz="Asia/Ho_Chi_Minh" onCopy={onCopy} />
    </Wrap>,
  );
}

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

const table = (name: string) => screen.getByRole("table", { name });
const rowOf = (t: HTMLElement, version: string) => {
  const h = within(t).getByRole("rowheader", { name: new RegExp(version) });
  const r = h.closest("tr");
  if (r === null) throw new Error("row");
  return r;
};

beforeEach(() => {
  intlErrors.length = 0;
  state.versions = EXPERIMENT_VERSIONS;
});
afterEach(() => {
  cleanup();
  expect(intlErrors).toEqual([]);
});

describe("Experiments block", { timeout: 20_000 }, () => {
  it("groups: Running (running + paused, not finished) and Finished (newest stop first)", () => {
    const g = experimentGroups(EXPERIMENT_VERSIONS.items);
    expect(g.running.map((r) => r.v.number)).toEqual([4, 5]);
    expect(g.finished.map((r) => r.v.number)).toEqual([8, 7, 6]);
    expect(g.runningCount).toBe(2);
    expect(g.unclean).toBe(1);
    // Baseline không bao giờ là thí nghiệm; version không có `experiment` (API cũ) không thuộc nhóm nào.
    expect(experimentGroups(VERSIONS.items).running).toEqual([]);
  });

  it("Running and Finished follow the mockup: header, slots, columns, Stopped only in Finished", async () => {
    block(EXPERIMENT_VERSIONS);
    expect(screen.getByRole("heading", { name: "Experiments" })).toBeInTheDocument();
    expect(screen.getByText("One hypothesis, one change, one result")).toBeInTheDocument();
    expect(
      screen.getByText(
        /^Each version tests one change against Baseline \(v3\) on the same articles\. When it has 100 paired closed trades it stops by itself and moves to Finished, so no more than 3 versions run at once \(Baseline included\)\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Running · 2 experiments + Baseline = 3 of 3 versions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No free slot: the next experiment can start when one finishes"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Finished · 3" })).toBeInTheDocument();
    expect(
      screen.getByText("Stopped at 100 paired closed trades · results don’t change after that"),
    ).toBeInTheDocument();

    const run = table("Running experiments");
    const fin = table("Finished experiments");
    const cols = (t: HTMLElement) =>
      within(t)
        .getAllByRole("columnheader")
        .map((c) => c.textContent);
    expect(cols(run)).toEqual([
      "Hypothesis",
      "Version · control",
      "Started",
      "Measured by",
      "Paired tradeshave / need",
      "Result",
    ]);
    expect(cols(fin)).toEqual([
      "Hypothesis",
      "Version · control",
      "Started",
      "Stopped",
      "Measured by",
      "Paired tradeshave / need",
      "Result",
    ]);

    const v4 = rowOf(run, "v4 · Strict subject");
    expect(v4).toHaveTextContent(
      "Trading only articles whose main subject is the asset gives a better result after fees.",
    );
    expect(v4).toHaveTextContent("vs Baseline (v3)");
    expect(v4).toHaveTextContent("Change: Skip after 30 → 20 min");
    expect(v4).toHaveTextContent("Nov 19");
    expect(v4).toHaveTextContent("Result after fees, paired with Baseline");
    expect(v4).toHaveTextContent("18 / 100");
    expect(within(v4).getByText("Collecting")).toBeInTheDocument();
    expect(v4).not.toHaveTextContent("Not a clean test");

    const v8 = rowOf(fin, "v8 · Tighter take profit");
    expect(v8).toHaveTextContent("Change: TP 1.5× → 1.2×");
    expect(v8).toHaveTextContent("Nov 22Nov 28");
    expect(v8).toHaveTextContent("100 / 100");
    expect(within(v8).getByText("Worse")).toBeInTheDocument();
    expect(within(rowOf(fin, "v7 · Skip late news")).getByText("Better")).toBeInTheDocument();
    expect(
      within(rowOf(fin, "v6 · Wider stops")).getByText("No clear difference"),
    ).toBeInTheDocument();
    // Claude reader đã qua cổng nhãn: không có ghi chú.
    expect(screen.queryByText("Claude reader not yet checked")).toBeNull();
    await noViolations();
  });

  it("result colours come from tokens: Better blue, Worse light red, No clear difference grey, Collecting amber", () => {
    block(EXPERIMENT_VERSIONS);
    const pill = (name: string) => within(table("Finished experiments")).getByText(name);
    expect(pill("Better")).toHaveClass("bg-accent-tint", "text-accent-ink");
    expect(pill("Worse")).toHaveClass("bg-neg-bg", "text-neg-ink");
    expect(pill("No clear difference")).toHaveClass("bg-bg", "text-ink-2");
    const collecting = within(table("Running experiments")).getAllByText("Collecting");
    expect(collecting).toHaveLength(2);
    for (const c of collecting) expect(c).toHaveClass("bg-warn-bg", "text-warn");
  });

  it("Not a clean test: names the things, and Copy to new version opens a copy of that version", async () => {
    const onCopy = vi.fn();
    block(EXPERIMENT_VERSIONS, onCopy);
    const v5 = rowOf(table("Running experiments"), "v5 · Majors only");
    expect(v5).toHaveClass("bg-warn-bg");
    expect(v5).toHaveTextContent(
      "Not a clean test. Changes 2 things from Baseline: Lowest level, Assets. A result can’t show which change caused it. Copy to new version and change one thing.",
    );
    expect(v5).toHaveTextContent("Changes: Lowest level Low → High · Assets All → Only these");
    await userEvent.click(within(v5).getByRole("button", { name: "Copy to new version" }));
    expect(onCopy).toHaveBeenCalledWith(E5);
    // Mockup 390: thẻ có cảnh báo, không có link.
    const cards = screen.getByRole("list", { name: "Running experiments" });
    const card = within(cards).getByText("v5 · Majors only").closest("li");
    if (card === null) throw new Error("card");
    expect(card).toHaveTextContent(
      "Not a clean test. Changes 2 things from Baseline: Lowest level, Assets. A result can’t show which change caused it.",
    );
    expect(within(card).queryByRole("button", { name: "Copy to new version" })).toBeNull();
  });

  it("mobile cards follow the 390 mockup", () => {
    block(EXPERIMENT_VERSIONS);
    const run = screen.getByRole("list", { name: "Running experiments" });
    const v4 = within(run).getByText("v4 · Strict subject").closest("li");
    expect(v4).toHaveTextContent("vs Baseline (v3) · one change: Skip after 30 → 20 min");
    expect(v4).toHaveTextContent(
      "Since Nov 19 · Result after fees, paired with Baseline · 18 / 100 paired trades",
    );
    const fin = screen.getByRole("list", { name: "Finished experiments" });
    const v8 = within(fin).getByText("v8 · Tighter take profit").closest("li");
    expect(v8).toHaveTextContent(
      "Nov 22 → stopped Nov 28 · Result after fees, paired with Baseline · 100 / 100 paired trades",
    );
    expect(v8).toHaveTextContent("Worse");
  });

  it("an old version without a hypothesis shows the backend result, no hypothesis; reader not yet checked", async () => {
    block(EXPERIMENT_VERSIONS_OLD);
    expect(
      screen.getByRole("heading", { name: "Running · 1 experiment + Baseline = 2 of 3 versions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 slot free")).toBeInTheDocument();
    const row = rowOf(table("Running experiments"), "v9 · Old rules");
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toBeEmptyDOMElement();
    expect(row).toHaveTextContent("120 / 100");
    expect(within(row).getByText("Better")).toBeInTheDocument();
    expect(within(row).getByText("Claude reader not yet checked")).toBeInTheDocument();
    // Finished trống: câu trống, không có bảng.
    expect(screen.getByText("No finished experiments yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Finished experiments" })).toBeNull();
    await noViolations();
  });

  it("missing config: the change line says Not available, never a guess", () => {
    const v = {
      ...E5,
      experiment: E5.experiment && {
        ...E5.experiment,
        changes: null,
        changedThings: null,
        clean: null,
      },
    };
    block({
      ...EXPERIMENT_VERSIONS,
      items: [v, ...EXPERIMENT_VERSIONS.items.filter((x) => x.id !== E5.id)],
    });
    const row = rowOf(table("Running experiments"), "v5 · Majors only");
    expect(row).toHaveTextContent("vs Baseline (v3)Not available");
    expect(row).not.toHaveTextContent("Not a clean test");
  });

  it("How it works › Experiments opens the drawer tab", async () => {
    const onHow = vi.fn();
    render(
      <Wrap onHow={onHow}>
        <Experiments data={EXPERIMENT_VERSIONS} tz="UTC" onCopy={() => undefined} />
      </Wrap>,
    );
    await userEvent.click(screen.getByRole("button", { name: "How it works › Experiments" }));
    expect(onHow).toHaveBeenCalledWith("experiments");
  });
});

describe("Bots & labels with experiments", { timeout: 20_000 }, () => {
  function shell(open: boolean) {
    return render(
      <Wrap>
        <BotsAndLabels
          open={open}
          onOpenChange={() => undefined}
          labelSeq={0}
          bots={[]}
          tz="Asia/Ho_Chi_Minh"
          versionId={null}
          onVersion={() => undefined}
          summaryVersion={null}
          older={{ trades: 0, versions: [] }}
          versions={EXPERIMENT_VERSIONS}
          onHow={() => undefined}
        />
      </Wrap>,
    );
  }

  it("folded line counts experiments (desktop full line, phone only the experiments part)", () => {
    shell(false);
    const summary = screen.getByText("Show").closest("summary");
    expect(summary).toHaveTextContent(
      "3 of 3 slots in use · 2 experiments running · 1 not a clean test · 3 finished · Claude reader v3: 50 of 50 labels",
    );
    expect(
      within(summary ?? document.body).getByText(
        "2 experiments running · 1 not a clean test · 3 finished",
      ),
    ).toHaveClass("md:hidden");
  });

  it("Experiments is the first block, before Bot versions; Copy to new version opens the sheet", async () => {
    shell(true);
    const exp = await screen.findByRole("heading", { name: "Experiments" });
    const versions = screen.getByRole("heading", { name: "Bot versions" });
    expect(exp.compareDocumentPosition(versions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const v5 = rowOf(table("Running experiments"), "v5 · Majors only");
    await userEvent.click(within(v5).getByRole("button", { name: "Copy to new version" }));
    expect(
      await screen.findByRole("dialog", { name: "New version · from v5" }),
    ).toBeInTheDocument();
  });
});

describe("How it works › Experiments", { timeout: 20_000 }, () => {
  it("explains the rule, Running and Finished, and how to read a result", async () => {
    render(
      <Wrap>
        <HowItWorksDrawer
          tab="experiments"
          onTab={() => undefined}
          onClose={() => undefined}
          version={null}
          rulesVersion={3}
          maxRunning={3}
          baselineNumber={3}
        />
      </Wrap>,
    );
    const dlg = await screen.findByRole("dialog", { name: "How it works" });
    expect(within(dlg).getByRole("tab", { name: "Experiments" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const panel = within(dlg).getByRole("tabpanel");
    expect(panel).toHaveTextContent(
      "One hypothesis, one experiment, one result. Each new version states one hypothesis and changes one thing from Baseline (v3). Then any difference in the result comes from that change.",
    );
    expect(panel).toHaveTextContent(
      "Paired with Baseline. Baseline and the experiment see the same articles. For every article both traded, DeskLabs compares the two results after fees. The comparison needs 100 paired closed trades.",
    );
    expect(panel).toHaveTextContent(
      "Running and Finished. An experiment stops by itself when it has 100 paired closed trades and moves to Finished with its stop date and result. So no more than 3 versions run at once (Baseline included), and a finished result doesn’t change.",
    );
    expect(panel).toHaveTextContent(
      "Results. Better or Worse: the likely range of the paired difference stays above or below 0. No clear difference: the range crosses 0 after the paired trades are in. Collecting: still running, not enough paired trades yet.",
    );
    expect(panel).toHaveTextContent(
      "Not a clean test. A version that changes more than one thing from Baseline still runs, but its result can’t show which change caused it.",
    );
    expect(panel).toHaveTextContent("A result is about the past trades only. It isn’t a forecast.");
    await noViolations();
  });

  it("missing counts say Not available, never 0", async () => {
    render(
      <Wrap>
        <HowItWorksDrawer
          tab="experiments"
          onTab={() => undefined}
          onClose={() => undefined}
          version={null}
          rulesVersion={null}
        />
      </Wrap>,
    );
    const panel = within(await screen.findByRole("tabpanel"));
    expect(panel.getByText(/changes one thing from Baseline\. Then/)).toBeInTheDocument();
    expect(panel.getByText(/no more than Not available versions/)).toBeInTheDocument();
  });
});
