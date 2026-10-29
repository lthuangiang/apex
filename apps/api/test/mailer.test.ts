import { describe, expect, it } from "vitest";

import { logMailer } from "../src/lib/mailer";

describe("SMTP_URL=log mailer (DEC-75)", () => {
  it("writes the whole email to one JSON log line instead of sending", async () => {
    const lines: string[] = [];
    await logMailer((l) => lines.push(l)).send({
      to: "user@example.com",
      subject: "Your DRIFT code",
      text: "Your code is 123456.",
    });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as { msg: string; mail: Record<string, string> };
    expect(entry.msg).toBe("email not sent (SMTP_URL=log)");
    expect(entry.mail).toEqual({
      to: "user@example.com",
      subject: "Your DRIFT code",
      text: "Your code is 123456.",
    });
  });
});
