import type { ReactElement, ReactNode } from 'react';

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps): ReactElement {
  return (
    <div className="empty-state">
      {icon !== undefined ? <div className="empty-state__icon">{icon}</div> : null}
      <div className="empty-state__title">{title}</div>
      {description !== undefined ? <div>{description}</div> : null}
      {action !== undefined ? <div>{action}</div> : null}
    </div>
  );
}
