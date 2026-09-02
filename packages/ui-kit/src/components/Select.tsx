import { SelectHTMLAttributes, forwardRef } from 'react';
import clsx from 'clsx';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  /** Phase 20: a line of explanation under the control, for a choice whose
   *  consequence is not obvious from its label — inclusive vs exclusive tax
   *  pricing being the case that asked for it. Mirrors `Input`'s `hint`,
   *  including its precedence: an error replaces it rather than stacking. */
  hint?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, hint, className, id, children, ...rest },
  ref,
) {
  const selectId = id ?? rest.name;
  return (
    <label className="flex flex-col gap-1.5 text-start" htmlFor={selectId}>
      {label && <span className="text-sm font-medium text-neutral-700">{label}</span>}
      <select
        ref={ref}
        id={selectId}
        className={clsx(
          'h-10 rounded-lg border bg-white px-3 text-sm text-neutral-900 outline-none transition-colors',
          error ? 'border-danger-400' : 'border-neutral-300 focus:border-brand-500',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      {error ? (
        <span className="text-xs text-danger-600">{error}</span>
      ) : hint ? (
        <span className="text-xs text-neutral-500">{hint}</span>
      ) : null}
    </label>
  );
});
