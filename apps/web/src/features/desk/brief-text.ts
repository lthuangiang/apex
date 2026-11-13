// Báo cáo sáng do LLM viết lúc tạo (từ 08:00 giờ địa phương) và được lưu lại, nên câu chào trong đó ("Good morning")
// và số câu hỏi còn lại sẽ sai khi người dùng mở lúc khác. Bỏ hai phần đó khỏi chữ đã lưu; câu chào do web thêm theo
// giờ trên trình duyệt (`greetingAt`), số câu còn lại đã hiện dưới ô hỏi. Hàm thuần.

// Chỉ bỏ câu chào ở đầu (kèm tên nếu có), không bỏ phần nội dung theo sau ("Good morning, two things need you…").
const GREETING =
  /^\s*(?:[Gg]ood\s+(?:[Mm]orning|[Aa]fternoon|[Ee]vening|[Dd]ay)|[Hh]i|[Hh]ello|[Hh]ey)\b(?:\s+[A-Z][\w'-]*(?=[,.!]))?\s*[.!,:;—-]?\s*/;
const QUESTIONS_LEFT = /[^.\n]*\b\d+\s+questions?\s+left\s+today\b[^.\n]*\.?/gi;

export function briefBody(text: string): string {
  return text
    .replace(GREETING, "")
    .replace(QUESTIONS_LEFT, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}
