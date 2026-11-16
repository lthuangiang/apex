import { dec } from "@drift/shared";

import { formatAmount } from "@/lib/format";

import type { FieldSpec, FormValues } from "./fields";

// Câu chữ field theo chiến lược (DEC-TBD-mm-form-copy): `createBot.fieldsByStrategy.<strategy>.<field key>.<leaf>`
// thắng khi có, không thì dùng câu chữ chung `createBot.fields.<label>.<leaf>`. Hiện chỉ Market Making
// (`volume_maker`) có câu chữ riêng; chiến lược khác hiện y như trước. Mọi key trả về tương đối với `createBot`.

/** `t.has` của namespace `createBot`. */
export type HasKey = (key: string) => boolean;
type Spec = Pick<FieldSpec, "key" | "label">;

const overBase = (strategy: string, f: Spec) => `fieldsByStrategy.${strategy}.${f.key}`;
const sharedBase = (f: Spec) => `fields.${f.label ?? f.key}`;

/** Key của một mục câu chữ (`label`, `unit`, `placeholder`…): bản riêng của chiến lược nếu có, không thì bản chung. */
export function copyKey(strategy: string, f: Spec, leaf: string, has: HasKey): string {
  const over = `${overBase(strategy, f)}.${leaf}`;
  return has(over) ? over : `${sharedBase(f)}.${leaf}`;
}

export const labelKeyOf = (strategy: string, f: Spec, has: HasKey) =>
  copyKey(strategy, f, "label", has);

/** Gốc của "How it works" (`<gốc>.intro`, `.steps`, `.note`); null khi field không có. */
export function howBaseOf(strategy: string, f: Spec, has: HasKey): string | null {
  const over = `${overBase(strategy, f)}.how`;
  if (has(`${over}.intro`)) return over;
  const shared = `${sharedBase(f)}.how`;
  return has(`${shared}.intro`) ? shared : null;
}

/** Key nhãn của một lựa chọn enum. */
export function optionKeyOf(
  strategy: string,
  f: Spec,
  optionsKey: string,
  value: string,
  has: HasKey,
): string {
  const over = `${overBase(strategy, f)}.options.${value}`;
  return has(over) ? over : `options.${optionsKey}.${value}`;
}

/** Key tuỳ chọn (đơn vị, placeholder): null khi không có bản nào. */
export function optionalKeyOf(
  strategy: string,
  f: Spec,
  leaf: "unit" | "placeholder",
  has: HasKey,
): string | null {
  const over = `${overBase(strategy, f)}.${leaf}`;
  return has(over) ? over : null;
}

const POSITIVE = /^\d+(\.\d+)?$/;

/** Số dương hợp lệ của ô form (bỏ dấu phẩy như `toConfig`); null khi trống, sai hoặc ≤ 0. */
export function positiveOf(v: FormValues[string] | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/,/g, "");
  if (!POSITIVE.test(s) || dec(s).lte(0)) return null;
  return dec(s).toString();
}

const fmt = (v: string) => formatAmount(v)?.text ?? v;

/**
 * Số trong câu chữ Market Making lấy từ giá trị đang có trên form (thiết kế "MM form explained"). Ô trống hoặc sai
 * thì số đó là null, và câu chữ dùng bản không có số (không bao giờ hiện 0 hay NaN, CLAUDE.md 1.8).
 */
export function mmNumbers(values: FormValues): {
  size: string | null;
  size3: string | null;
  budget: string | null;
  warn: string | null;
  /** Giá trị vị thế tối đa = order size × max orders. */
  max: string | null;
  /** Mức cắt vị thế của Smart quoting: 15 bp trên một order size. */
  cut: string | null;
  /** Ví dụ Position loss limit 0.5 USDC ứng với bao nhiêu % giá trên một order size. */
  lossPct: string | null;
} {
  const size = positiveOf(values.orderSize);
  const budget = positiveOf(values.costBudget);
  const orders = positiveOf(values.maxOrders);
  return {
    size: size === null ? null : fmt(size),
    size3: size === null ? null : fmt(dec(size).mul(3).toString()),
    budget: budget === null ? null : fmt(budget),
    warn: budget === null ? null : fmt(dec(budget).mul("0.8").toString()),
    max: size === null || orders === null ? null : fmt(dec(size).mul(orders).toString()),
    cut: size === null ? null : fmt(dec(size).mul("0.0015").toSignificantDigits(2).toString()),
    lossPct:
      size === null
        ? null
        : dec("0.5").div(size).mul(100).toDecimalPlaces(2).toSignificantDigits(3).toString(),
  };
}

type Params = Record<string, string>;

/** Tham số ICU của hint theo field; null khi thiếu số (dùng `hintShort`). Field không cần số thì không có ở đây. */
const HINT_PARAMS: Partial<
  Record<string, Record<string, (values: FormValues, base: string | null) => Params | null>>
> = {
  volume_maker: {
    orderSize: (v) => {
      const n = mmNumbers(v);
      return n.size === null ? null : { size: n.size };
    },
    costBudget: (v) => {
      const n = mmNumbers(v);
      return n.budget === null || n.warn === null ? null : { budget: n.budget, warn: n.warn };
    },
    maxOrders: (v) => {
      const n = mmNumbers(v);
      return n.size === null || n.size3 === null ? null : { size: n.size, size3: n.size3 };
    },
    inventoryLossStop: (v, base) => {
      const n = mmNumbers(v);
      // Ví dụ chỉ có nghĩa khi giá giảm dưới 100%.
      return n.size === null ||
        n.lossPct === null ||
        dec(n.lossPct).gte(100) ||
        base === null ||
        base === ""
        ? null
        : { size: n.size, pct: n.lossPct, base };
    },
  },
};

/**
 * Hint của field: key + tham số. Bản riêng của chiến lược có thể có `hintOff` (công tắc đang tắt) và `hintShort`
 * (bản không có số, khi ô liên quan trống / sai). `base`: tên tài sản base của market đang chọn.
 */
export function hintOf(
  strategy: string,
  f: Spec & Pick<FieldSpec, "type">,
  values: FormValues,
  has: HasKey,
  base: string | null = null,
): { key: string; params: Params } {
  const over = overBase(strategy, f);
  if (!has(`${over}.hint`)) return { key: `${sharedBase(f)}.hint`, params: {} };
  if (f.type.kind === "bool" && values[f.key] !== true && has(`${over}.hintOff`))
    return { key: `${over}.hintOff`, params: {} };
  const paramsOf = HINT_PARAMS[strategy]?.[f.key];
  if (paramsOf === undefined) return { key: `${over}.hint`, params: {} };
  const params = paramsOf(values, base);
  return params === null
    ? { key: `${over}.hintShort`, params: {} }
    : { key: `${over}.hint`, params };
}

/** Ô có được vẽ không theo `renderIf` (giá trị vẫn gửi lên, khác `when`). */
export function rendered(f: Pick<FieldSpec, "renderIf">, values: FormValues): boolean {
  if (f.renderIf === undefined) return true;
  return (values[f.renderIf.key] === true) === f.renderIf.is;
}
