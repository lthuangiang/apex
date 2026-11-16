import { Strategy, dec, formatDecimal } from "@drift/shared";
import { botCapitalOf, volumeFarmSchema, volumeMakerSchema } from "@drift/strategies";

// Tóm tắt cấu hình một dòng cho bộ chọn bot ở Trading Agent (DEC-294, quyết định 5): server tạo từ
// config đang chạy, tất định, câu chữ tiếng Anh ghép bằng " · ". Không tạo được (config thiếu / sai, không có vốn)
// → null, UI chỉ hiện capital.
// - Market Making: order size · khoảng cách (bp, hoặc số bước giá khi báo giá theo sổ lệnh) · "Smart quoting" khi bật.
// - Volume Builder: order size (min–max) · đòn bẩy.
// - Chiến lược khác: vốn (quote). TWAP (vốn theo base) → null.

const SEP = " · ";

/** "$1,000" / "$12.5": USD, tối đa 2 chữ số thập phân, dấu phẩy nghìn (en-US). */
function usd(v: string): string {
  return `$${formatDecimal(dec(v).toDecimalPlaces(2), { locale: "en-US", maximumFractionDigits: 2 }) ?? v}`;
}

function plain(v: string): string {
  return formatDecimal(v, { locale: "en-US" }) ?? v;
}

function quotePlace(level: number): string {
  if (level === 0) return "At best price";
  return level === 1 ? "1 step back" : `${String(level)} steps back`;
}

export function botSummaryLine(strategy: string, config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  try {
    if (strategy === Strategy.volumeMaker) {
      const p = volumeMakerSchema.safeParse(config);
      if (!p.success) return null;
      const c = p.data;
      const parts = [
        usd(c.orderSize),
        c.quoteLevel === undefined ? `${plain(c.distanceBp)} bp` : quotePlace(c.quoteLevel),
      ];
      if (c.smartQuoting) parts.push("Smart quoting");
      return parts.join(SEP);
    }
    if (strategy === Strategy.volumeFarm) {
      const p = volumeFarmSchema.safeParse(config);
      if (!p.success) return null;
      const c = p.data;
      const size = dec(c.orderSizeMinUsd).eq(c.orderSizeMaxUsd)
        ? usd(c.orderSizeMinUsd)
        : `${usd(c.orderSizeMinUsd)}–${usd(c.orderSizeMaxUsd)}`;
      return [size, `${String(c.leverage)}×`].join(SEP);
    }
    const cap = botCapitalOf(strategy, config);
    return cap.capital === null || cap.capitalUnit !== "quote" ? null : usd(cap.capital);
  } catch {
    return null;
  }
}
