import type { SodexCallDetail, SodexCallItem } from "@drift/shared";

// Định dạng của SoDEX Debugger (docs/mockups/sodex-debugger). Hàm thuần, có unit test.

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "15:05:12.481" theo UTC. */
export function utcTime(iso: string, ms = true): string {
  const d = new Date(iso);
  const base = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return ms ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base;
}

/** "2026-11-17 15:05:12.481" theo UTC. */
export function utcDateTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${utcTime(iso)}`;
}

/** "HH:00" theo UTC. */
export function utcHour(iso: string): string {
  return `${pad(new Date(iso).getUTCHours())}:00`;
}

/** "HH:MM" theo UTC. */
export function utcMinute(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Giờ của người xem ("22:05:12"); `timeZone` chỉ để test. */
export function localTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(iso));
}

/** Nhãn lệch giờ của người xem: "UTC+7", "UTC-3:30", "UTC". */
export function utcOffsetLabel(offsetMinutesEast: number): string {
  if (offsetMinutesEast === 0) return "UTC";
  const sign = offsetMinutesEast > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutesEast);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${String(h)}${m === 0 ? "" : `:${pad(m)}`}`;
}

/** `0x4E1e…29Db` */
export function maskAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const ADDRESS = /0x[0-9a-fA-F]{40}/g;

/** Che mọi địa chỉ ví trong một đoạn văn bản (URL, body) để hiển thị. */
export function maskAddressesIn(text: string): string {
  return text.replace(ADDRESS, (a) => maskAddress(a));
}

/** "1,840 ms" */
export function formatMs(ms: number): string {
  return `${new Intl.NumberFormat("en-US").format(ms)} ms`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** Tỷ lệ lỗi từ số đếm thật: "0.34%". `null` khi không có lời gọi. */
export function formatRate(errors: number, calls: number): string | null {
  if (calls === 0) return null;
  return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 }).format(
    errors / calls,
  );
}

/** Nhãn method: REST giữ nguyên, WS thêm tiền tố "WS". */
export function methodLabel(item: Pick<SodexCallItem, "kind" | "method">): string {
  return item.kind === "ws" ? `WS ${item.method}` : item.method;
}

/** Tách đường dẫn sau mỗi "/" để xuống dòng đẹp (thay <wbr> của mockup). */
export function pathParts(path: string): string[] {
  return path.split(/(?<=\/)/);
}

const ORDER_PATH = /\/trade\/orders(\/batch)?$/;

/** Chủ ngữ của dòng tiêu đề báo cáo. */
export function reportSubject(call: Pick<SodexCallItem, "kind" | "method" | "endpoint">): {
  key: "cancel" | "newOrder" | "modify" | "leverage" | "ws" | "other";
} {
  if (call.kind === "ws") return { key: "ws" };
  if (call.method === "DELETE" && ORDER_PATH.test(call.endpoint)) return { key: "cancel" };
  if (call.method === "POST" && ORDER_PATH.test(call.endpoint)) return { key: "newOrder" };
  if (call.endpoint.endsWith("/orders/modify")) return { key: "modify" };
  if (call.endpoint === "/perps/trade/leverage") return { key: "leverage" };
  return { key: "other" };
}

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface ReportOptions {
  related: boolean;
  fullAddress: boolean;
  responseHeaders: boolean;
}

/**
 * Văn bản báo cáo gửi SoDEX, đúng khuôn của mockup (reportText). Chỉ dùng dữ liệu đã lưu (đã bỏ chữ ký / key):
 * header có `redaction` khác "none" không bao giờ được chép.
 */
export function buildReport(d: SodexCallDetail, opts: ReportOptions, t: Translate): string {
  const subject = reportSubject(d);
  const lines: string[] = [];
  lines.push(
    t("heading", {
      subject: t(`subject.${subject.key}`, { endpoint: d.endpoint, method: d.method }),
      phrase: t(`phrase.${d.outcome}`),
    }),
  );
  lines.push("");
  lines.push(t("time", { value: utcDateTime(d.at) }));
  lines.push(t("endpoint", { value: `${methodLabel(d)} ${d.url ?? d.endpoint}` }));
  lines.push(t("latency", { value: formatMs(d.latencyMs) }));
  if (d.accountAddress !== null) {
    const value = opts.fullAddress ? d.accountAddress : maskAddress(d.accountAddress);
    lines.push(
      d.sodexAccountId === null
        ? t("account", { value })
        : t("accountWithId", { value, id: d.sodexAccountId }),
    );
  }
  if (d.builderId !== null) lines.push(t("builder", { id: d.builderId }));
  if (d.traceId !== null) lines.push(t("traceId", { value: d.traceId }));
  if (d.wsConn !== null) lines.push(t("wsConn", { value: d.wsConn.connId }));

  lines.push("");
  lines.push(t("request"));
  const headers = d.requestHeaders.filter((h) => h.redaction === "none" && h.value !== null);
  if (headers.length > 0)
    lines.push(
      t("headers", { value: headers.map((h) => `${h.name}: ${h.value ?? ""}`).join("; ") }),
    );
  if (d.requestBody !== null) lines.push(d.requestBody);

  lines.push("");
  if (d.httpStatus === null) {
    lines.push(t("responseNoHttp"));
    if (d.sodexSays !== null) lines.push(t("noResponse", { value: d.sodexSays }));
  } else {
    lines.push(t("response", { status: d.httpStatus }));
  }
  if (d.responseBody !== null) lines.push(d.responseBody);
  if (opts.responseHeaders && d.responseHeaders.length > 0) {
    lines.push("");
    lines.push(t("responseHeaders"));
    for (const h of d.responseHeaders) lines.push(`${h.name}: ${h.value}`);
  }

  if (d.unreadableReason === "order_result_without_cl_ord_id") {
    const cl = d.clOrdIds[0] ?? "";
    lines.push("");
    lines.push(t("expected"));
    lines.push(t(subject.key === "cancel" ? "expectedCancel" : "expectedOrder"));
    lines.push(`{"code": 0, "clOrdID": ${JSON.stringify(cl)}} ${t("expectedTail")}`);
  }

  if (opts.related && d.related.length > 0) {
    lines.push("");
    lines.push(t(d.related.length === 1 ? "relatedOne" : "relatedMany"));
    for (const r of d.related) {
      lines.push(
        t("relatedLine", { time: utcTime(r.at), method: methodLabel(r), target: r.endpoint }),
      );
      const parts: string[] = [];
      if (r.clOrdIds.length > 0) parts.push(`clOrdID ${r.clOrdIds.join(", ")}`);
      if (r.httpStatus !== null) parts.push(`HTTP ${String(r.httpStatus)}`);
      if (r.sodexCode !== null) parts.push(`code ${String(r.sodexCode)}`);
      if (r.sodexSays !== null) parts.push(r.sodexSays);
      if (parts.length > 0) lines.push(t("relatedSub", { details: parts.join(" · ") }));
    }
  }

  lines.push("");
  lines.push(t("footer"));
  const text = lines.join("\n");
  return opts.fullAddress ? text : maskAddressesIn(text);
}
