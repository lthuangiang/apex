import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bot, LayoutDashboard, Settings, Wallet } from "lucide-react";

import { AppShell } from "../components/app-shell";
import { ComingSoonChip } from "../components/coming-soon-chip";
import { ConnectionStatus } from "../components/connection-status";
import { LiveBadge } from "../components/live-badge";
import { MetricCard } from "../components/metric-card";
import { PageHeader } from "../components/page-header";

const meta: Meta = { title: "Layout/AppShell", parameters: { layout: "fullscreen" } };
export default meta;
type Story = StoryObj;

const navItems = [
  {
    key: "overview",
    label: "Overview",
    href: "#",
    icon: <LayoutDashboard strokeWidth={1.8} />,
    current: true,
  },
  { key: "portfolio", label: "Portfolio", href: "#", icon: <Wallet strokeWidth={1.8} /> },
  { key: "lab", label: "Strategy Lab", href: "#", icon: <Bot strokeWidth={1.8} /> },
  {
    key: "settings",
    label: "Settings",
    href: "#",
    icon: <Settings strokeWidth={1.8} />,
    group: "secondary" as const,
  },
];

function Page() {
  return (
    <AppShell
      brand={<span className="text-lg font-extrabold">DRIFT</span>}
      navItems={navItems}
      navLabel="Main"
      skipLinkLabel="Skip to content"
      headerExtras={
        <>
          <LiveBadge label="LIVE · MAINNET" />
          <ConnectionStatus state="connected" label="SoDEX connected" />
        </>
      }
      sidebarFooter={<span className="text-sm text-ink-2">Emergency</span>}
    >
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Overview"
          description="Your bots at a glance"
          badges={<ComingSoonChip label="Paper · Coming soon" />}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <MetricCard label="Net PnL" status="loading" emptyLabel="Not available" />
          <MetricCard label="Volume" status="empty" emptyLabel="Not available" />
          <MetricCard label="Open orders" status="ready" value="12" emptyLabel="Not available" />
        </div>
      </div>
    </AppShell>
  );
}

export const Desktop: Story = {
  render: () => <Page />,
  globals: { viewport: { value: "desktop" } },
};
export const Mobile: Story = { render: () => <Page />, globals: { viewport: { value: "mobile" } } };
