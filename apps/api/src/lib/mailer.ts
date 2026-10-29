import nodemailer from "nodemailer";

// Gửi email qua SMTP (dev: Mailpit trong compose). Nội dung email là câu chữ người dùng thấy,
// nên lấy từ caller (đã chốt câu chữ), không viết ở đây.

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Giá trị đặc biệt của SMTP_URL: không gửi, in email ra log (DEC-75). */
export const SMTP_LOG = "log";

/**
 * Chế độ `SMTP_URL=log` (chủ động bật, DEC-75): không gửi email mà ghi nguyên nội dung ra stdout, để chủ app
 * tự chép mã đăng nhập cho người dùng khi chưa có SMTP. Nội dung có mã OTP: chỉ dùng cho app cá nhân, người
 * đọc được log là người vận hành. Không có đường tự rơi về chế độ này khi SMTP lỗi.
 */
export function logMailer(
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Mailer {
  return {
    send(mail) {
      write(
        JSON.stringify({
          level: 40,
          time: Date.now(),
          service: "api",
          msg: "email not sent (SMTP_URL=log)",
          mail: { to: mail.to, subject: mail.subject, text: mail.text },
        }),
      );
      return Promise.resolve();
    },
  };
}

export function smtpMailer(smtpUrl: string, from: string): Mailer {
  if (smtpUrl === SMTP_LOG) return logMailer();
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(mail) {
      await transport.sendMail({ from, ...mail });
    },
  };
}
