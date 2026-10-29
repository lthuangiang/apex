import type { ReactNode } from "react";

import { cx } from "../lib/cx";

import { DataRegion, type DataRegionProps } from "./data-region";
import { EmptyState } from "./empty-state";

export interface DataTableColumn<Row> {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  /** Cột số: căn phải, tabular numbers. */
  numeric?: boolean;
}

export interface DataTableProps<Row> extends Omit<DataRegionProps, "children" | "loading"> {
  /** Mô tả bảng cho trình đọc màn hình. */
  caption: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
}

/**
 * Bảng cuộn ngang trong khung riêng, không làm cả trang cuộn ngang (mục 13, Responsive).
 * Khi rỗng vẫn giữ header bảng, empty state nằm trong thân bảng (UI_REVIEW B4).
 */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  ...region
}: DataTableProps<Row>) {
  return (
    <DataRegion {...region} status={region.status === "empty" ? "ready" : region.status}>
      <div
        role="region"
        aria-label={caption}
        // Vùng cuộn phải focus được bằng bàn phím (axe: scrollable-region-focusable).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="max-w-full overflow-x-auto rounded-tile border border-border bg-surface"
      >
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-surface-2">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cx(
                    "whitespace-nowrap px-4 py-3 text-xs font-semibold text-muted",
                    column.numeric ? "text-right" : "text-left",
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {region.status === "empty" ? (
              <tr className="border-t border-border">
                <td colSpan={columns.length} className="p-0">
                  <EmptyState {...region.empty} />
                </td>
              </tr>
            ) : null}
            {region.status === "empty"
              ? null
              : rows.map((row) => (
                  <tr key={getRowKey(row)} className="border-t border-border">
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cx(
                          "whitespace-nowrap px-4 py-3 text-ink",
                          column.numeric && "text-right tabular-nums",
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </DataRegion>
  );
}
