import { useTranslation } from 'react-i18next';
import { Card, CardBody, Input } from '@retail/ui-kit';
import { limitationEntries } from '../lib/reports';
import type { ReportRange } from '../lib/apiTypes';

/**
 * Phase 19 — the shared window control, shown ONLY on the reports whose
 * backend actually accepts `from`/`to`.
 *
 * THE SERVER OWNS THE SEMANTICS. Two calendar dates go up; the server
 * resolves them in the BUSINESS's own timezone into a half-open
 * `[from, toExclusive)` interval, defaults to the current calendar month
 * when they are omitted, and echoes back the window it actually used —
 * which is what `RangeEcho` prints. Nothing here computes a boundary,
 * assumes UTC, or renders the exclusive end as an inclusive date.
 *
 * There is deliberately no granularity selector and no comparison period:
 * the contract offers neither, and a control the server drops is worse
 * than no control at all.
 */
export function ReportRangeControl({
  from,
  to,
  onFrom,
  onTo,
  hint,
  children,
  testId = 'report-range',
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  hint?: string;
  children?: React.ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <Card className="mb-4">
      <CardBody className="p-3">
        <div className="flex flex-wrap items-end gap-3" data-testid={testId}>
          <Input label={t('reports.from')} type="date" value={from} onChange={(e) => onFrom(e.target.value)} data-testid={`${testId}-from`} />
          <Input label={t('reports.to')} type="date" value={to} onChange={(e) => onTo(e.target.value)} data-testid={`${testId}-to`} />
          {children}
        </div>
        <p className="mt-2 text-xs leading-snug text-neutral-500">{hint ?? t('reports.rangeHint')}</p>
      </CardBody>
    </Card>
  );
}

/**
 * The window the server actually used, printed verbatim beside every
 * ranged report. Its `to` is EXCLUSIVE and is labelled as such rather
 * than quietly shown as the last day included.
 */
export function RangeEcho({ range, testId = 'range-echo' }: { range: ReportRange | undefined; testId?: string }) {
  const { t } = useTranslation();
  if (!range) return null;
  return (
    <p className="mb-3 text-xs text-neutral-500" data-testid={testId}>
      {t('reports.rangeEcho', { from: range.from, to: range.to, timezone: range.timezone })}
    </p>
  );
}

/**
 * The server's own written statement of what a figure does NOT include,
 * printed VERBATIM rather than paraphrased.
 *
 * These are not decoration. `netProfit` covers inventory-related expenses
 * only because no expense module exists; revenue is reported net of
 * returns because the GL has no contra-revenue account. Rewriting either
 * into reassuring UI copy is how a report starts lying.
 */
export function Limitations({ limitations, testId = 'limitations' }: { limitations?: Record<string, string>; testId?: string }) {
  const { t } = useTranslation();
  const entries = limitationEntries(limitations);
  if (entries.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-warning-200 bg-warning-50 p-3" data-testid={testId}>
      <p className="mb-1 text-xs font-bold text-warning-800">{t('reports.limitations')}</p>
      <ul className="space-y-1">
        {entries.map(([key, text]) => (
          <li key={key} className="text-xs leading-snug text-warning-800">
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A single figure, rendered only by a caller that already checked the
 *  payload carried it. */
export function Figure({ label, value, tone, testId }: { label: string; value: string; tone?: 'default' | 'good' | 'bad'; testId?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p
        className={`numeric mt-1 text-base font-bold ${
          tone === 'good' ? 'text-success-700' : tone === 'bad' ? 'text-danger-700' : 'text-neutral-900'
        }`}
        data-testid={testId}
      >
        {value}
      </p>
    </div>
  );
}

/** Server-paginated report tables all page the same way. */
export function ReportPager({
  page,
  totalPages,
  total,
  onPage,
  testId,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  if (totalPages <= 1) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid={testId}>
      <p className="text-xs text-neutral-500">{t('reports.pageOf', { page, totalPages, total })}</p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="rounded-lg border border-neutral-200 px-2.5 py-1 text-xs disabled:opacity-40"
        >
          {t('catalogue.previous')}
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          className="rounded-lg border border-neutral-200 px-2.5 py-1 text-xs disabled:opacity-40"
        >
          {t('catalogue.next')}
        </button>
      </div>
    </div>
  );
}
