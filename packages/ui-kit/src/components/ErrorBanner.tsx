import { ReactNode } from 'react';

export interface ErrorBannerProps {
  title: string;
  message?: string;
  action?: ReactNode;
}

/** Renders a server/business error surfaced from the API error envelope
 * (`{ error: { code, message, details, requestId } }`) — never a raw
 * stack trace or unparsed response. */
export function ErrorBanner({ title, message, action }: ErrorBannerProps) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-danger-200 bg-danger-50 p-4 text-start">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger-100 text-danger-700" aria-hidden>
        !
      </span>
      <div className="flex-1">
        <p className="text-sm font-semibold text-danger-800">{title}</p>
        {message && <p className="mt-0.5 text-sm text-danger-700">{message}</p>}
      </div>
      {action}
    </div>
  );
}
