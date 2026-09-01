import { ReactNode } from 'react';

/**
 * Phase 14 (ERP catalogue) — one screen, several independently-granted
 * sections.
 *
 * WHY THIS EXISTS. Reference data is five separate things behind five
 * separate permissions — categories, brands, attributes, units, taxes —
 * that a merchant thinks of as one job. Five nav entries would be five
 * near-empty pages; one page with five hardcoded sections would show an
 * ACCOUNTANT four sections they cannot read. So the tab LIST is data, and
 * the caller passes only the tabs that caller may actually see.
 *
 * IT SELECTS; IT DOES NOT AUTHORIZE. Filtering tabs by permission is the
 * caller's job (and the backend refuses every call behind a tab
 * regardless). This component renders what it is given.
 */
export interface TabDef {
  id: string;
  label: string;
}

export function Tabs({
  tabs,
  active,
  onChange,
  children,
  'data-testid': testId,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  children?: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <div data-testid={testId}>
      {/* Scrolls rather than wrapping or disappearing on a narrow screen —
          the lesson POS loose-ends B2 taught the shell's own nav. */}
      <div
        role="tablist"
        className="scrollbar-none -mx-1 mb-3 flex items-center gap-1 overflow-x-auto border-b border-neutral-200 px-1"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === active}
            onClick={() => onChange(tab.id)}
            data-testid={testId ? `${testId}-tab-${tab.id}` : undefined}
            className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
              tab.id === active
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-neutral-500 hover:text-neutral-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
