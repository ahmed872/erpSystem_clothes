import { ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

/**
 * Phase 13 (ERP foundation) — the pause before something irreversible.
 *
 * The POS grew three ad-hoc confirmation modals (cancel a held basket,
 * abandon, close a shift), each rebuilding the same two buttons. The ERP
 * performs materially more one-way acts — resolving a claim, accepting a
 * variance — so the pattern is extracted ONCE here rather than a fourth
 * time.
 *
 * IT CONFIRMS; IT DOES NOT DECIDE. There is no "are you sure" logic in
 * here: whether an action is permitted is the backend's answer, and
 * whether it is offered at all is the caller's permission check. This
 * component only asks, and says what the caller told it to say.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = 'primary',
  pending,
  onConfirm,
  onClose,
  children,
  'data-testid': testId,
}: {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` for destructive or irreversible acts. */
  tone?: 'primary' | 'danger';
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  /** Extra content — a required note field, a summary of what changes. */
  children?: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="flex flex-col gap-3" data-testid={testId}>
        {message && <div className="text-sm leading-snug text-neutral-700">{message}</div>}
        {children}
        <div className="flex gap-2">
          <Button variant="secondary" fullWidth onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            fullWidth
            loading={pending}
            disabled={pending}
            onClick={onConfirm}
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
