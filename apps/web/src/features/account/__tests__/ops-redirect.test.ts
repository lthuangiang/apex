import { afterEach, describe, expect, it, vi } from "vitest";

import Page from "../../../app/admin/ops/page";

// Ops đổi tên thành Bot Monitor: /admin/ops chuyển hẳn (308) sang /admin/bot-monitor, giữ query của link cũ.

const nav = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock("next/navigation", () => ({
  permanentRedirect: (url: string) => {
    nav.to.push(url);
  },
}));

afterEach(() => {
  nav.to = [];
});

describe("/admin/ops", () => {
  it("redirects permanently to /admin/bot-monitor", async () => {
    await Page({ searchParams: Promise.resolve({}) });
    expect(nav.to).toEqual(["/admin/bot-monitor"]);
  });

  it("keeps the query of an old link", async () => {
    await Page({ searchParams: Promise.resolve({ show: "all", tab: "vb" }) });
    expect(nav.to).toEqual(["/admin/bot-monitor?show=all&tab=vb"]);
  });
});
