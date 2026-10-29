import { z } from "zod";

// Đọc mã OTP từ Mailpit (hộp thư giả của E2E).
const listSchema = z.object({
  messages: z.array(z.object({ ID: z.string(), To: z.array(z.object({ Address: z.string() })) })),
});
const messageSchema = z.object({ Text: z.string() });

export async function latestOtp(email: string): Promise<string> {
  const base = process.env.E2E_MAILPIT ?? "";
  for (let i = 0; i < 40; i += 1) {
    const list = listSchema.parse(await (await fetch(`${base}/api/v1/messages`)).json());
    const hit = list.messages.find((m) => m.To.some((t) => t.Address === email));
    if (hit !== undefined) {
      const msg = messageSchema.parse(
        await (await fetch(`${base}/api/v1/message/${hit.ID}`)).json(),
      );
      const code = /\b(\d{6})\b/.exec(msg.Text)?.[1];
      if (code !== undefined) return code;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No OTP mail for ${email}`);
}
