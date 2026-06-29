import type { ReactElement } from 'react';

export interface SpinnerProps {
  readonly label?: string;
}

export function Spinner({ label }: SpinnerProps): ReactElement {
  return <span className="spinner" role="status" aria-label={label ?? 'Loading'} />;
}
