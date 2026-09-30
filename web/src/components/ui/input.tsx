import * as React from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-[var(--radius)] border border-border bg-bg px-3 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-10 rounded-[var(--radius)] border border-border bg-bg px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-muted', className)}
      {...props}
    />
  );
}
