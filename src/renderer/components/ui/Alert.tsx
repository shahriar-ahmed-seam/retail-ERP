import type { ReactElement, ReactNode } from 'react';

export type AlertTone = 'danger' | 'success' | 'info' | 'warning';

export interface AlertProps {
  readonly tone?: AlertTone;
  readonly title?: string;
  readonly children?: ReactNode;
}

export function Alert({
  tone = 'info',
  title,
  children,
}: AlertProps): ReactElement {
  return (
    <div className={`alert alert--${tone}`} role="alert">
      {title !== undefined ? <span className="alert__title">{title}</span> : null}
      {children !== undefined ? <span>{children}</span> : null}
    </div>
  );
}
