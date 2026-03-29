import * as React from 'react';
import { cn } from '../../lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          'h-10 rounded-lg border border-border bg-white px-3 text-sm text-foreground outline-none placeholder:text-muted focus:ring-2 focus:ring-accent/30',
          className,
        )}
        {...props}
      />
    );
  },
);

Input.displayName = 'Input';
