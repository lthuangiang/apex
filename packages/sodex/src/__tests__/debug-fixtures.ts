import { envelopeOf, type SodexRestCapture } from "../debug/capture";
import { parseSodexJson } from "../rest/json";

// Test: dựng bản ghi REST như client (client đã parse body; ở đây parse lại để có cùng các field).
export function restCapture(
  over: Partial<SodexRestCapture> & { responseText?: string | null },
): SodexRestCapture {
  const base: SodexRestCapture = {
    kind: "rest",
    startedAt: Date.UTC(2026, 10, 17, 15, 5, 12, 481),
    latencyMs: 214,
    method: "DELETE",
    url: "https://mainnet-gw.sodex.dev/api/v1/perps/trade/orders",
    requestHeaders: { "Content-Type": "application/json" },
    requestBody: '{"accountID":20417,"cancels":[{"symbolID":2,"clOrdID":"drift-b31-v4-cx-88213"}]}',
    signed: true,
    actionType: "cancelOrder",
    failure: null,
    errorDetail: null,
    httpStatus: 200,
    responseHeaders: { "content-type": "application/json" },
    responseText: '{"code":0,"timestamp":1,"data":[]}',
    responseLength: null,
    json: true,
    envelopeCode: null,
    envelopeError: null,
    orderEndpoint: true,
    orderResults: null,
    context: undefined,
  };
  const c = { ...base, ...over };
  const text = c.responseText;
  let body: unknown;
  let json = text !== null;
  if (text !== null) {
    try {
      body = parseSodexJson(text);
    } catch {
      json = false;
    }
  }
  const env = envelopeOf(body);
  return {
    ...c,
    json: c.failure === null ? json : false,
    responseLength: over.responseLength ?? text?.length ?? null,
    envelopeCode: env.code,
    envelopeError: env.error,
    orderResults: c.orderEndpoint === true && Array.isArray(env.data) ? env.data : null,
  };
}
