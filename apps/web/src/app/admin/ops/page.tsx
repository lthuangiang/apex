import { permanentRedirect } from "next/navigation";

// Trang Ops đổi tên thành Bot Monitor (DEC-TBD-ops-redesign): link cũ chuyển hẳn sang /admin/bot-monitor, giữ query.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams))
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) p.append(k, x);
  const q = p.toString();
  permanentRedirect(q === "" ? "/admin/bot-monitor" : `/admin/bot-monitor?${q}`);
}
