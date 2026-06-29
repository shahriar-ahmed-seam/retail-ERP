import { useT } from '@renderer/i18n';

import type { ReactElement } from 'react';

export interface BrandProps {
  readonly showTagline?: boolean;
  readonly markOnly?: boolean;
}

export function Brand({
  showTagline = true,
  markOnly = false,
}: BrandProps): ReactElement {
  const t = useT();
  return (
    <span className="brand">
      <span className="brand__mark" aria-hidden="true">
        স
      </span>
      {markOnly ? null : (
        <span className="brand__text">
          <span className="brand__name">{t('brand.name')}</span>
          {showTagline ? (
            <span className="brand__tag">{t('brand.tagline')}</span>
          ) : null}
        </span>
      )}
    </span>
  );
}
