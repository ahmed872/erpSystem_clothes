import clsx from 'clsx';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-neutral-500" role="status">
      <span
        className={clsx('h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-brand-600', className)}
        aria-hidden
      />
      {label && <span className="text-sm">{label}</span>}
    </span>
  );
}

/** Fills its container, for a whole-panel loading state. */
export function SpinnerOverlay({ label }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[160px] w-full items-center justify-center">
      <Spinner label={label} />
    </div>
  );
}
