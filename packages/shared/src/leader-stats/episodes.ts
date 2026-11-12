import { Decimal, dec } from "../money";

// Episode (DEC-163 mục 3): một vị thế của một market đi từ 0 về 0. Đảo chiều = đóng episode cũ + mở episode mới,
// tách fill tại điểm qua 0 (phí và PnL chia theo phần khối lượng). Hàm thuần, không I/O.

/** Fill perp đã chuẩn hoá (từ `userFillsByTime` của Hyperliquid, docs/COPY_TRADING_DATA.md). */
export interface LeaderFill {
  coin: string;
  /** Giá khớp. */
  px: string;
  /** Khối lượng, luôn dương. */
  sz: string;
  side: "B" | "A";
  /** ms UTC. */
  time: number;
  /** Vị thế có dấu ngay trước fill (Hyperliquid trả sẵn). */
  startPosition: string;
  /** PnL đã chốt của fill, chưa trừ phí. */
  closedPnl: string;
  /** Phí USDC của fill (số dương; âm = rebate). */
  fee: string;
  /** Fill này là lúc chính ví bị thanh lý (`liquidation.liquidatedUser` = ví), không phải ví nhận vị thế bị thanh lý. */
  liquidatedSelf: boolean;
}

export interface Episode {
  coin: string;
  side: "long" | "short";
  /** Thời điểm mở; null khi vị thế đã có trước đầu cửa sổ dữ liệu (`partial`). */
  openedAt: number | null;
  /** Thời điểm về 0; null khi còn mở. */
  closedAt: number | null;
  /** Σ closedPnl − Σ phí trong episode (USD). Funding cộng sau ở `stats`. */
  net: Decimal;
  /** Notional các fill mở trong 60 giây đầu của episode (USD), dùng cho "cỡ vào lệnh trung vị". */
  entryNotional: Decimal;
  /** Episode kết thúc vì chính ví bị thanh lý. */
  liquidated: boolean;
}

const ENTRY_WINDOW_MS = 60_000;

const signOf = (d: Decimal): -1 | 0 | 1 => (d.isZero() ? 0 : d.isNegative() ? -1 : 1);

/** Gom fill theo coin rồi cắt thành episode. Fill phải cùng một ví; thứ tự vào không quan trọng. */
export function episodesOf(fills: readonly LeaderFill[]): Episode[] {
  const byCoin = new Map<string, LeaderFill[]>();
  for (const f of fills) {
    const list = byCoin.get(f.coin) ?? [];
    list.push(f);
    byCoin.set(f.coin, list);
  }
  const out: Episode[] = [];
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time);
    let cur: Episode | null = null;
    for (const f of list) {
      const start = dec(f.startPosition);
      const qty = dec(f.sz);
      if (qty.isZero()) continue;
      const delta = f.side === "B" ? qty : qty.neg();
      const after = start.add(delta);
      const pnl = dec(f.closedPnl);
      const fee = dec(f.fee);
      const notional = dec(f.px).mul(qty);

      if (cur === null && !start.isZero()) {
        // Vị thế mở trước cửa sổ dữ liệu: biết PnL phần đóng, không biết lúc mở.
        cur = {
          coin,
          side: start.isNegative() ? "short" : "long",
          openedAt: null,
          closedAt: null,
          net: new Decimal(0),
          entryNotional: new Decimal(0),
          liquidated: false,
        };
      }

      const flips = signOf(start) !== 0 && signOf(after) !== 0 && signOf(start) !== signOf(after);
      if (flips && cur !== null) {
        // Phần đóng = |start|, phần mở mới = |after|; PnL đã chốt thuộc phần đóng.
        const closeShare = start.abs().div(qty);
        cur.net = cur.net.add(pnl).sub(fee.mul(closeShare));
        cur.closedAt = f.time;
        cur.liquidated = f.liquidatedSelf;
        out.push(cur);
        const openShare = after.abs().div(qty);
        cur = {
          coin,
          side: after.isNegative() ? "short" : "long",
          openedAt: f.time,
          closedAt: null,
          net: fee.mul(openShare).neg(),
          entryNotional: dec(f.px).mul(after.abs()),
          liquidated: false,
        };
        continue;
      }

      cur ??= {
        coin,
        side: delta.isNegative() ? "short" : "long",
        openedAt: f.time,
        closedAt: null,
        net: new Decimal(0),
        entryNotional: new Decimal(0),
        liquidated: false,
      };
      cur.net = cur.net.add(pnl).sub(fee);
      const opening = after.abs().gt(start.abs());
      if (opening && cur.openedAt !== null && f.time - cur.openedAt <= ENTRY_WINDOW_MS) {
        cur.entryNotional = cur.entryNotional.add(notional);
      }
      if (after.isZero()) {
        cur.closedAt = f.time;
        cur.liquidated = f.liquidatedSelf;
        out.push(cur);
        cur = null;
      }
    }
    if (cur !== null) out.push(cur);
  }
  return out;
}
