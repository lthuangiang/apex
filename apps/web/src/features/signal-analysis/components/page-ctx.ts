// Ngữ cảnh trang dùng chung cho các tab Signal Analysis và trang Signal Research BETA (#423): tách khỏi trang admin để
// component của Signal research không phụ thuộc layout của Signal Analysis.

export type PageMeta = { bots: number | null; computedAt: string } | null;

export interface PageCtx {
  tz: string;
  utc: boolean;
  /** Tab báo số bot (null = không hiện trên tab) và lúc tính để header hiện. */
  onMeta: (m: PageMeta) => void;
  onForbidden: () => void;
}
