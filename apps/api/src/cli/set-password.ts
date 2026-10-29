import { createDb } from "@drift/db";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordContainsEmail } from "@drift/shared";

import { setPassword } from "../modules/auth/service";

// Đặt / đặt lại mật khẩu cho một account (DEC-76). Production chưa có SMTP nên không có "quên mật khẩu"
// qua email; người vận hành chạy lệnh này trên server. Mật khẩu đọc từ stdin, không nằm trên dòng lệnh:
//   docker compose exec -T api pnpm --silent --filter @drift/api set-password user@example.com
//   (gõ mật khẩu, Enter, rồi Ctrl+D)

const email = process.argv[2]?.trim().toLowerCase();
if (!email?.includes("@")) {
  console.error("usage: set-password <email>   (password on stdin)");
  process.exit(2);
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const password = Buffer.concat(chunks)
  .toString("utf8")
  .replace(/\r?\n$/, "");

if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
  console.error(
    `password must be ${String(PASSWORD_MIN_LENGTH)}–${String(PASSWORD_MAX_LENGTH)} characters`,
  );
  process.exit(2);
}
if (passwordContainsEmail(password, email)) {
  console.error("password must not contain the email name");
  process.exit(2);
}

const { db, pool } = createDb(process.env.DATABASE_URL ?? "");
try {
  const ok = await setPassword(db, email, password);
  console.log(ok ? `password set for ${email}` : `no account with email ${email}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await pool.end();
}
