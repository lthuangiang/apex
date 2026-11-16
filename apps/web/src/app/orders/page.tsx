import { OrdersPage } from "@/features/bots";

interface Params {
  botId?: string;
  order?: string;
  decision?: string;
  at?: string;
}

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  // BD-02: `order` (clOrdID), `decision`, `at` khi mở từ pill Result của Decisions. Chỉ nhận chuỗi đơn.
  const props = Object.fromEntries(
    (["botId", "order", "decision", "at"] as const).flatMap((k) => {
      const v = p[k];
      return typeof v === "string" && v !== "" ? [[k, v]] : [];
    }),
  ) as Params;
  return <OrdersPage {...props} />;
}
