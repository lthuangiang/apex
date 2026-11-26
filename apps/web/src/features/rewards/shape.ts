// Trang chẩn đoán rewards (team, #547): mô tả hình dạng một response SoDEX thành bảng tên trường · kiểu · giá trị mẫu,
// để chủ sản phẩm chốt các điểm [confirm] (README bản phác). Giá trị của trường nhạy cảm (địa chỉ ví, chữ ký, nonce,
// token…) không bao giờ hiện, chỉ kiểu.

export interface FieldRow {
  path: string;
  types: string[];
  /** null khi trường bị ẩn hoặc không có giá trị mẫu (object / null). */
  sample: string | null;
  hidden: boolean;
}

const HIDDEN_KEYS = new Set([
  "accesstoken",
  "token",
  "jwt",
  "signature",
  "nonce",
  "secret",
  "message",
  "from",
  "to",
  "wallet",
  "owner",
  "account",
]);

/** Địa chỉ nằm ngoài `asset` (ví người dùng, người gửi / nhận) cũng ẩn; địa chỉ hợp đồng của asset thì hiện. */
function isHidden(path: string, key: string): boolean {
  const k = key.toLowerCase();
  if (HIDDEN_KEYS.has(k)) return true;
  return k === "address" && !path.endsWith("asset.address");
}

const MAX_ITEMS = 200;
const MAX_SAMPLE = 48;

function numberType(v: number): string {
  if (!Number.isInteger(v)) return "number";
  const a = Math.abs(v);
  if (a >= 1e12 && a < 1e14) return "number (int, ms timestamp?)";
  if (a >= 1e9 && a < 1e11) return "number (int, s timestamp?)";
  return "number (int)";
}

function stringType(v: string): string {
  if (/^-?\d+$/.test(v)) return "string (integer)";
  if (/^-?\d+\.\d+$/.test(v)) return "string (decimal)";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return "string (ISO date)";
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return "string (address)";
  if (/^https?:\/\//.test(v)) return "string (URL)";
  return "string";
}

const clip = (s: string) => (s.length > MAX_SAMPLE ? `${s.slice(0, MAX_SAMPLE)}…` : s);

export function describeShape(value: unknown, opts: { groupBy?: string } = {}): FieldRow[] {
  const rows = new Map<string, { types: Set<string>; sample: string | null; hidden: boolean }>();
  const add = (path: string, type: string, sample: string | null, hidden: boolean) => {
    const row = rows.get(path) ?? { types: new Set<string>(), sample: null, hidden };
    row.types.add(type);
    if (!hidden && row.sample === null && sample !== null) row.sample = clip(sample);
    rows.set(path, row);
  };
  const walk = (v: unknown, path: string, hidden: boolean): void => {
    if (v === null) {
      add(path, "null", null, hidden);
      return;
    }
    if (Array.isArray(v)) {
      add(path, "array", `${String(v.length)} items`, false);
      for (const item of v.slice(0, MAX_ITEMS)) {
        let child = `${path}[]`;
        if (opts.groupBy !== undefined && typeof item === "object" && item !== null) {
          const g = (item as Record<string, unknown>)[opts.groupBy];
          if (typeof g === "string") child = `${path}[${opts.groupBy}=${clip(g)}]`;
        }
        walk(item, child, hidden);
      }
      return;
    }
    if (typeof v === "object") {
      add(path, "object", null, hidden);
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        const p = path === "" ? k : `${path}.${k}`;
        walk(child, p, hidden || isHidden(p, k));
      }
    } else if (typeof v === "number") add(path, numberType(v), String(v), hidden);
    else if (typeof v === "string") add(path, stringType(v), v, hidden);
    else if (typeof v === "boolean") add(path, "boolean", String(v), hidden);
    else add(path, typeof v, null, hidden);
  };
  walk(value, "", false);
  return [...rows.entries()]
    .filter(([path]) => path !== "")
    .map(([path, r]) => ({ path, types: [...r.types], sample: r.sample, hidden: r.hidden }));
}

/** Claim thời gian của JWT được hiện giá trị (để biết hạn token); claim khác chỉ hiện kiểu. */
const TIME_CLAIMS = new Set(["exp", "iat", "nbf"]);

function base64UrlDecode(part: string): string {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Tên claim và kiểu trong payload JWT (không kiểm chữ ký; chỉ để chẩn đoán). Không bao giờ trả token hay giá trị của
 * claim khác `exp` / `iat` / `nbf`. Token không phải JWT → null.
 */
export function jwtClaimRows(token: string | null): FieldRow[] | null {
  if (token === null) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return Object.entries(payload as Record<string, unknown>).map(([k, v]) => {
    const show = TIME_CLAIMS.has(k) && typeof v === "number";
    const sample = show ? `${String(v)} (${new Date(v * 1000).toISOString()})` : null;
    const type =
      v === null
        ? "null"
        : Array.isArray(v)
          ? "array"
          : typeof v === "number"
            ? numberType(v)
            : typeof v;
    return { path: k, types: [type], sample, hidden: !show };
  });
}
