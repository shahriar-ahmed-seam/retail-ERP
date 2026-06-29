import type { HTMLAttributes, ReactElement, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly pad?: boolean;
  readonly children: ReactNode;
}

export function Card({
  pad = true,
  className,
  children,
  ...rest
}: CardProps): ReactElement {
  const classes = ['card', pad ? 'card--pad' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
