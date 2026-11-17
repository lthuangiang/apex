import type { ArchitectureMap } from "@drift/shared";

// System Architecture Diagram: hàm thuần để vẽ bản đồ api trả về. Nội dung (container, cổng, mạng, luồng) KHÔNG nằm ở
// web: chỉ `GET /api/v1/admin/architecture` (role team) trả về (DevOps, PR #211).

type Flow = ArchitectureMap["flows"][number];
type Pt = readonly [number, number];

/** Các icon tham gia một luồng (còn lại vẽ mờ). */
export function nodesOf(map: ArchitectureMap, flow: Flow): ReadonlySet<string> {
  const byId = new Map(map.edges.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const s of flow.steps) {
    if (s.node !== null) out.add(s.node);
    const e = s.edge === null ? undefined : byId.get(s.edge);
    if (e !== undefined) {
      out.add(e.from);
      out.add(e.to);
    }
  }
  return out;
}

/** Số bước gắn trên mỗi đường nối, và đường nào có mũi tên ngược (bước `back`). */
export function edgesOf(flow: Flow): { edge: string; steps: number[]; back: boolean }[] {
  const map = new Map<string, { steps: number[]; back: boolean }>();
  flow.steps.forEach((s, i) => {
    if (s.edge === null) return;
    const cur = map.get(s.edge) ?? { steps: [], back: false };
    cur.steps.push(i + 1);
    if (s.back) cur.back = true;
    map.set(s.edge, cur);
  });
  return [...map].map(([edge, v]) => ({ edge, ...v }));
}

/** Điểm nằm ở tỉ lệ `t` (0–1) dọc theo đường gấp khúc. */
export function pointAt(pts: readonly Pt[], t: number): Pt {
  const segs = pts.slice(1).map((p, i) => {
    const a = pts[i] ?? p;
    return { a, b: p, len: Math.hypot(p[0] - a[0], p[1] - a[1]) };
  });
  let left = segs.reduce((s, x) => s + x.len, 0) * t;
  for (const s of segs) {
    if (left <= s.len) {
      const r = s.len === 0 ? 0 : left / s.len;
      return [s.a[0] + (s.b[0] - s.a[0]) * r, s.a[1] + (s.b[1] - s.a[1]) * r];
    }
    left -= s.len;
  }
  return pts.at(-1) ?? [0, 0];
}

/** Vị trí số bước trên một đường: một số ở giữa; nhiều số rải từ 30% tới 70%. */
export function badgeSpots(count: number): number[] {
  if (count <= 1) return [0.5];
  return Array.from({ length: count }, (_, i) => 0.3 + (0.4 * i) / (count - 1));
}

/** Tách câu có `<code>…</code>` thành đoạn chữ và đoạn code (web không chèn HTML). */
export function codeParts(s: string): { code: boolean; text: string }[] {
  return s
    .split(/(<code>[\s\S]*?<\/code>)/g)
    .filter((p) => p !== "")
    .map((p) =>
      p.startsWith("<code>") && p.endsWith("</code>")
        ? { code: true, text: p.slice(6, -7) }
        : { code: false, text: p },
    );
}
