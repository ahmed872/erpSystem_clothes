import { ReactNode } from 'react';
import clsx from 'clsx';

/**
 * Phase 13 (ERP foundation) — the primitive the back office is made of.
 *
 * WHY IT LIVES HERE AND NOT IN THE ERP APP. POS and ERP are one product
 * with one design system; a table defined inside `apps/erp-web` would drift
 * from the ui-kit the moment either app touched spacing, tone or focus
 * rings. This is the same reason `Button` and `Modal` are shared.
 *
 * RTL COMES FREE, and only because nothing here is physical: alignment is
 * `text-start`/`text-end`, never left/right, so a column reading `end` is
 * right-aligned in English and left-aligned in Arabic without a second code
 * path. `align: 'end'` is for NUMBERS - money, counts - which line up on
 * their trailing edge in both directions.
 *
 * IT RENDERS, IT DOES NOT FETCH. No sorting, no filtering, no paging logic
 * lives in here: those are server contracts (`page`/`limit`/`search` on the
 * endpoints that support them), and a table that quietly sorted a single
 * page would be lying about the whole set. Callers pass rows they already
 * have and the states they are already in.
 */
export interface DataTableColumn<T> {
  /** Stable key, also used for the React key of the cell. */
  key: string;
  header: ReactNode;
  /** `end` for numeric columns; mirrors correctly under RTL. */
  align?: 'start' | 'end';
  /** Rendered per row. Return a string or any node. */
  cell: (row: T) => ReactNode;
  /** Optional per-cell class, e.g. `numeric` for tabular figures. */
  className?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Shown instead of rows while the first load is in flight. */
  loading?: boolean;
  /** Shown when there is nothing to show and nothing in flight. */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Marks a row as the current selection. */
  isRowActive?: (row: T) => boolean;
  'data-testid'?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  onRowClick,
  isRowActive,
  'data-testid': testId,
}: DataTableProps<T>) {
  const interactive = Boolean(onRowClick);

  return (
    // A table is the one thing on an ERP screen that legitimately exceeds
    // a narrow viewport, so it scrolls inside its own box rather than
    // pushing the page sideways.
    <div className="w-full overflow-x-auto rounded-xl border border-neutral-200 bg-white">
      <table className="w-full min-w-[32rem] border-collapse text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={clsx(
                  'px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500',
                  column.align === 'end' ? 'text-end' : 'text-start',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-neutral-400">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-brand-600" />
              </td>
            </tr>
          )}

          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-sm text-neutral-500">
                {empty}
              </td>
            </tr>
          )}

          {!loading &&
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={clsx(
                  'border-b border-neutral-100 last:border-b-0',
                  interactive && 'cursor-pointer hover:bg-neutral-50',
                  isRowActive?.(row) && 'bg-brand-50',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={clsx(
                      'px-3 py-2 align-top text-neutral-800',
                      column.align === 'end' ? 'text-end' : 'text-start',
                      column.className,
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
  );
}
