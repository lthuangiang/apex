import { dec } from "../../money";

import type { DeskAiFact } from "./facts";
import { KNOWLEDGE_NUMBERS } from "./prompt";

// Kiểm tra số (AI_DESK_BPLUS_PROMPT mục 5.3): mọi con số trong câu trả lời phải khớp một fact (hoặc số user vừa gõ
// trong câu hỏi). Một số viết với d chữ số lẻ khớp fact f khi |f| làm tròn d chữ số bằng đúng số đó; số nằm trong tên
// bot được nhắc nguyên cụm thì bỏ qua. Không khớp → dùng câu mẫu.

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** Các số trong văn bản (bỏ dấu, bỏ dấu phẩy ngăn nghìn), theo thứ tự xuất hiện. */
export function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/,/g, ""));
}

function matches(written: string, value: string): boolean {
  let v;
  try {
    v = dec(value).abs();
  } catch {
    return false;
  }
  const places = written.includes(".") ? (written.split(".")[1]?.length ?? 0) : 0;
  return v.toDecimalPlaces(places).eq(dec(written));
}

export interface NumberCheck {
  ok: boolean;
  /** Số trong câu trả lời không khớp fact nào. */
  unknown: string[];
}

export function checkNumbers(
  answer: string,
  facts: readonly DeskAiFact[],
  question = "",
): NumberCheck {
  const allowed = [
    ...facts.filter((f) => f.unit !== "text").map((f) => f.value),
    ...numbersIn(question),
    ...KNOWLEDGE_NUMBERS,
  ];
  // Tên bot (ví dụ "BTC 3x Farm") được nhắc nguyên cụm thì số trong tên không phải số liệu: bỏ cụm tên trước khi đếm.
  // Tên market (ví dụ "1000PEPE-USD") cũng vậy.
  const names = [
    ...new Set(
      facts.flatMap((f) => [
        ...(f.bot === null ? [] : [f.bot]),
        ...(f.market == null ? [] : [f.market]),
      ]),
    ),
  ].sort((a, b) => b.length - a.length);
  // Số thứ tự đầu dòng ("1. ", "2) ") không phải số liệu.
  const text = names
    .reduce((t, n) => t.split(n).join(" "), answer)
    .replace(/^\s*\d{1,2}[.)]\s/gm, " ");
  const unknown = numbersIn(text).filter((n) => !allowed.some((a) => matches(n, a)));
  return { ok: unknown.length === 0, unknown };
}
