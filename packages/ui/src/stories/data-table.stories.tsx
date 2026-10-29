import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "../components/button";
import { DataTable, type DataTableProps } from "../components/data-table";

import { at, noop } from "./fixtures";

interface Row {
  id: string;
  market: string;
  side: string;
  price: string;
  size: string;
  status: string;
}

const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
  id: String(i),
  market: i % 2 ? "ETH-PERP" : "BTC-PERP",
  side: i % 2 ? "Sell" : "Buy",
  price: i % 2 ? "3,412.50" : "64,120.00",
  size: i % 2 ? "0.500" : "0.010",
  status: "Open",
}));

const args: DataTableProps<Row> = {
  label: "Orders",
  caption: "Open orders",
  status: "ready",
  rows,
  getRowKey: (r) => r.id,
  empty: { title: "No open orders", action: <Button variant="secondary">Create bot</Button> },
  error: { title: "Could not load orders", retryLabel: "Retry", onRetry: noop },
  columns: [
    { key: "market", header: "Market", cell: (r) => r.market },
    { key: "side", header: "Side", cell: (r) => r.side },
    { key: "price", header: "Price", cell: (r) => r.price, numeric: true },
    { key: "size", header: "Size", cell: (r) => r.size, numeric: true },
    { key: "status", header: "Status", cell: (r) => r.status },
  ],
};

const meta: Meta<typeof DataTable<Row>> = {
  title: "Data/DataTable",
  component: DataTable<Row>,
  args,
};
export default meta;
type Story = StoryObj<typeof DataTable<Row>>;

export const Loading: Story = { args: { status: "loading" } };
export const Empty: Story = { args: { status: "empty" } };
export const Error: Story = { args: { status: "error" } };
export const Stale: Story = { args: { stale: { label: "Stale", updatedAt: at } } };
export const Mobile: Story = { globals: { viewport: { value: "mobile" } } };
