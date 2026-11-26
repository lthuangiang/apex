/** URL và body của một lần gọi fetch giả (test rewards). */
export function urlOf(input: RequestInfo | URL | undefined): string {
  if (input === undefined) return "";
  if (input instanceof URL) return input.href;
  return typeof input === "string" ? input : input.url;
}

export function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}
