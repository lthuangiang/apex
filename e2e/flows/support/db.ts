import { spawnSync } from "node:child_process";

// SQL trực tiếp vào Postgres của E2E (container Testcontainers) để seed dữ liệu khó tạo qua UI (Review this run, kết
// quả so sánh, lượt hỏi đã dùng). Chỉ cho E2E; global-setup đặt `E2E_PG` = { id, user, db }.

export function sql(query: string): string {
  const pg = JSON.parse(process.env.E2E_PG ?? "{}") as { id: string; user: string; db: string };
  const res = spawnSync(
    "docker",
    [
      "exec",
      pg.id,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      pg.user,
      "-d",
      pg.db,
      "-At",
      "-c",
      query,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`sql failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** Chờ tới khi truy vấn trả giá trị khác rỗng (ví dụ job đã chạy xong). */
export async function sqlUntil(query: string, timeoutMs = 30_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = sql(query);
    if (v !== "") return v;
    if (Date.now() > until) throw new Error(`timed out waiting for: ${query}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
