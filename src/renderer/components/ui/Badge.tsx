import type { ReactElement, ReactNode } from 'react';

export type BadgeTone = 'primary' | 'accent' | 'neutral' | 'danger' | 'success';

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
}

export function Badge({ tone = 'neutral', children }: BadgeProps): ReactElement {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
