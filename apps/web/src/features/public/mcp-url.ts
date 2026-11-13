// Địa chỉ server MCP cho trang `/claude` (W7): `MCP_PUBLIC_URL` (cùng biến với api / mcp) + `/mcp`. Thiếu hoặc sai thì
// dùng mặc định production, đúng như mặc định của `MCP_PUBLIC_URL` ở api và mcp.
export const DEFAULT_MCP_PUBLIC_URL = "https://mcp.desklabs.xyz";

export function mcpServerUrl(raw: string | undefined): string {
  let base = DEFAULT_MCP_PUBLIC_URL;
  if (raw !== undefined && raw.trim() !== "") {
    try {
      const u = new URL(raw.trim());
      if (u.protocol === "https:" || u.protocol === "http:") base = u.origin + u.pathname;
    } catch {
      // giữ mặc định
    }
  }
  return `${base.replace(/\/+$/, "")}/mcp`;
}
