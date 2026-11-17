import { z } from "zod";

// System Architecture Diagram (team): `GET /api/v1/admin/architecture`, chỉ role team. Nội dung (tên container, cổng,
// mạng, volume, các luồng và câu chữ của chúng) chỉ nằm ở api, không bao giờ nằm trong bundle web (DevOps, PR #211).
// Schema này chỉ có tên field. Câu chữ trong `title` / `body` có thể chứa thẻ `<code>…</code>` (web hiển thị dạng code,
// không chèn HTML).

export const ARCH_TONES = ["net", "app", "ml", "db", "int", "sec", "ext"] as const;
export const archToneSchema = z.enum(ARCH_TONES);
export type ArchTone = z.infer<typeof archToneSchema>;

export const ARCH_ICONS = [
  "user",
  "spark",
  "route",
  "window",
  "api",
  "bolt",
  "plug",
  "cpu",
  "chart",
  "clock",
  "queue",
  "rewind",
  "db",
  "pool",
  "stack",
  "stream",
  "key",
  "lock",
  "swap",
  "eye",
  "send",
] as const;
export const archIconSchema = z.enum(ARCH_ICONS);
export type ArchIcon = z.infer<typeof archIconSchema>;

/** Kiểu khung: mạng / vùng, quyết định màu viền và nền. */
export const ARCH_ZONES = ["internet", "host", "edge", "core", "secure", "outside"] as const;
export const archZoneSchema = z.enum(ARCH_ZONES);

const point = z.tuple([z.number(), z.number()]);

export const archStepSchema = z.object({
  /** Đường nối của bước, hoặc null khi bước gắn vào một icon (`node`). */
  edge: z.string().nullable(),
  /** Bước đi ngược chiều đường nối (mũi tên ở đầu đường). */
  back: z.boolean(),
  node: z.string().nullable(),
  title: z.string(),
  body: z.string(),
});
export type ArchStep = z.infer<typeof archStepSchema>;

export const architectureMapSchema = z.object({
  /** Khung vẽ, đơn vị SVG. */
  width: z.number(),
  height: z.number(),
  groups: z.array(
    z.object({
      zone: archZoneSchema,
      label: z.string(),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    }),
  ),
  notes: z.array(z.object({ x: z.number(), y: z.number(), text: z.string(), boxed: z.boolean() })),
  nodes: z.array(
    z.object({
      id: z.string(),
      x: z.number(),
      y: z.number(),
      icon: archIconSchema,
      tone: archToneSchema,
      label: z.string(),
      sub: z.string(),
      facts: z.array(z.object({ label: z.string(), value: z.string() })),
    }),
  ),
  edges: z.array(
    z.object({ id: z.string(), from: z.string(), to: z.string(), points: z.array(point).min(2) }),
  ),
  legend: z.array(z.object({ tone: archToneSchema, label: z.string() })),
  flows: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      lead: z.string(),
      steps: z.array(archStepSchema).min(1),
    }),
  ),
  /** Luồng mở mặc định. */
  defaultFlow: z.string(),
});
export type ArchitectureMap = z.infer<typeof architectureMapSchema>;
