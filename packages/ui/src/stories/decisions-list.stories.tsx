import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  DecisionsList,
  type DecisionChildRow,
  type DecisionGroupRow,
  type DecisionListRow,
  type DecisionSingleRow,
} from "../components/decisions-list";

// Dữ liệu mẫu chỉ dùng trong Storybook (#227): câu chữ chép từ apps/web/messages/en.json (agent.decisionsList), app thật
// truyền chữ đã dịch qua props. Dòng gộp BD-02 ("×7") và lượt vào lệnh Volume Farm (DEC-307, "8 tries in 2 min").

const labels = {
  cols: { time: "Time", decision: "Decision", why: "Why", result: "Result" },
  list: "Decisions & actions",
  mobileList: "Recent decisions",
  emptyTitle: "No decisions yet.",
  emptyBody: "Each decision appears here with its order, once the bot starts.",
};

const order = (tail: string) => `/agent/demo/orders?order=cl-${tail}`;

const single = (
  id: string,
  time: string,
  name: string,
  why: string | null,
  result: DecisionSingleRow["result"],
): DecisionSingleRow => ({
  kind: "single",
  id,
  time: `Nov 16, ${time}`,
  shortTime: time.slice(0, 5),
  name,
  why,
  result,
});

const tries: DecisionChildRow[] = Array.from({ length: 8 }, (_, i) => {
  const n = 8 - i;
  const filled = n === 8;
  const text = filled
    ? `Try ${String(n)} · Filled at 1,800.70`
    : `Try ${String(n)} · Post-only miss`;
  return {
    id: `try-${String(n)}`,
    time: `07:4${String(Math.floor((8 - n) / 4))}:${String(10 + n * 5)}`,
    label: text,
    why: filled ? "Bid 1,800.70, spread 2 ticks" : "Would have crossed the book",
    mobileText: text,
    result: {
      pill: filled
        ? {
            label: "Filled",
            tone: "positive",
            href: order(`a${String(n)}`),
            linkLabel: `Filled. Show order …a${String(n)} in Orders`,
          }
        : {
            label: "Rejected",
            tone: "negative",
            href: order(`a${String(n)}`),
            linkLabel: `Rejected. Show order …a${String(n)} in Orders`,
          },
    },
  };
});

const entryGroup: DecisionGroupRow = {
  kind: "group",
  key: "entry-1",
  name: "Enter long",
  badge: "8 tries in 2 min",
  range: "07:41:15 – 07:43:00",
  shortTime: "07:41",
  head: "Filled at 1,800.70",
  mobileHead: "Filled at 1,800.70",
  summary: [
    { label: "7 rejected", tone: "negative" },
    { label: "1 filled", tone: "positive" },
  ],
  panelLabel: "8 Enter long decisions",
  showAllLabel: "Show all 8",
  children: tries,
};

const bidGroup: DecisionGroupRow = {
  kind: "group",
  key: "bid-1",
  name: "Bid pulled",
  badge: "×3",
  range: "07:42:10 – 07:42:20",
  shortTime: "07:42",
  head: "Bid moved",
  mobileHead: null,
  summary: [
    { label: "1 unknown", tone: "unknown" },
    { label: "2 cancelled", tone: "neutral" },
  ],
  panelLabel: "3 Bid pulled decisions",
  showAllLabel: "Show all 3",
  children: ["b1", "b2", "b3"].map((id, i) => ({
    id,
    time: `07:42:${String(20 - i * 5)}`,
    label: "Bid pulled",
    why: "Bid moved",
    mobileText: "Bid moved",
    result: {
      pill:
        i === 0
          ? { label: "Unknown", tone: "unknown" as const }
          : {
              label: "Cancelled",
              tone: "neutral" as const,
              href: order(id),
              linkLabel: `Cancelled. Show order …${id} in Orders`,
            },
    },
  })),
};

const rows: DecisionListRow[] = [
  single("s1", "07:43:30", "Position cut", "Closed the whole position at market.", {
    pill: {
      label: "Filled",
      tone: "positive",
      href: order("c1"),
      linkLabel: "Filled. Show order …c1 in Orders",
    },
  }),
  entryGroup,
  bidGroup,
  single("s2", "07:40:05", "Order sent", null, { pill: { label: "Open", tone: "accent" } }),
  single("s3", "07:39:00", "Paused", "Not enough margin on SoDEX.", null),
];

const meta: Meta<typeof DecisionsList> = {
  title: "Data/DecisionsList",
  component: DecisionsList,
  args: { labels, rows },
};
export default meta;
type Story = StoryObj<typeof DecisionsList>;

/** Nhóm nhiều dòng (thu gọn): lượt vào lệnh và dòng gộp ×3 xen giữa các dòng đơn. */
export const Grouped: Story = {};

/** Chỉ dòng đơn. */
export const SingleRows: Story = {
  args: { rows: rows.filter((r) => r.kind === "single") },
};

/** Nhóm mở: 5 dòng con đầu và nút "Show all 8". */
export const Expanded: Story = { args: { defaultOpen: ["entry-1"] } };

/** Cảnh báo: kết quả Unknown / Rejected, nhóm mở. */
export const Warnings: Story = {
  args: {
    rows: [
      bidGroup,
      single("w1", "07:41:00", "Order sent", "Checking with SoDEX", {
        pill: { label: "Unknown", tone: "unknown" },
      }),
      single("w2", "07:40:30", "Order sent", "Below min size", {
        pill: {
          label: "Rejected",
          tone: "negative",
          href: order("w2"),
          linkLabel: "Rejected. Show order …w2 in Orders",
        },
      }),
    ],
    defaultOpen: ["bid-1"],
  },
};

export const Empty: Story = { args: { rows: [] } };
