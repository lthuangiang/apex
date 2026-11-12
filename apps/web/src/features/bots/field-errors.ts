/** Câu mặc định của zod ("Expected a decimal string", "Invalid input: …"): không phải câu chữ cho người dùng. */
const RAW_ZOD =
  /^(Invalid input|Invalid string|Invalid option|Expected |Required$|Too (small|big))/;

/** Đổi câu mặc định của zod thành `fallback`, giữ câu của spec chiến lược; bỏ câu trùng (C6). */
export function friendlyFieldErrors(
  fe: Record<string, string[]>,
  fallback: string,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(fe).map(([k, msgs]) => [
      k,
      [...new Set(msgs.map((msg) => (RAW_ZOD.test(msg) ? fallback : msg)))],
    ]),
  );
}
