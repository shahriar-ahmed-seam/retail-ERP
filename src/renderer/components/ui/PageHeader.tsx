import type { ReactElement, ReactNode } from 'react';

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly actions?: ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: PageHeaderProps): ReactElement {
  return (
    <header className="page-header">
      <div className="page-header__titles">
        <h1 className="page-header__title">{title}</h1>
        {subtitle !== undefined ? (
          <p className="page-header__subtitle">{subtitle}</p>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className="page-header__actions">{actions}</div>
      ) : null}
    </header>
  );
}
