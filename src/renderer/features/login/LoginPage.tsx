/**
 * Login screen. Submits credentials to `auth:login` via the renderer
 * auth context; the parent `<App />` swaps away from this page once a
 * session exists. Validates: Requirements 1.1, 1.2, 1.5.
 */

import { useCallback, useState, type FormEvent, type ReactElement } from 'react';

import {
  Alert,
  Brand,
  Button,
  Field,
  Input,
  LanguageToggle,
} from '@renderer/components/ui';
import { useT } from '@renderer/i18n';
import { useAuth } from '@renderer/lib/auth-context';

import type { ErrorEnvelope } from '@shared/result';

export function LoginPage(): ReactElement {
  const t = useT();
  const { login, isLoading } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ErrorEnvelope | null>(null);

  const trimmedUsername = username.trim();
  const canSubmit =
    trimmedUsername.length > 0 && password.length > 0 && !isLoading;

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!canSubmit) return;
      setError(null);
      void (async () => {
        const result = await login(trimmedUsername, password);
        if (result.ok) return;
        setError(result.error);
        setPassword('');
      })();
    },
    [canSubmit, login, trimmedUsername, password],
  );

  return (
    <main className="auth-screen">
      <div className="auth-screen__toggle">
        <LanguageToggle />
      </div>
      <div className="auth-card card card--pad">
        <div className="auth-card__brand">
          <Brand />
        </div>
        <h1 className="auth-card__title">{t('auth.signIn')}</h1>
        <p className="auth-card__subtitle">{t('auth.signInSubtitle')}</p>

        <form onSubmit={handleSubmit}>
          <Field label={t('auth.username')} htmlFor="login-username">
            <Input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
              }}
            />
          </Field>

          <Field label={t('auth.password')} htmlFor="login-password">
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </Field>

          <Button type="submit" block size="lg" disabled={!canSubmit} loading={isLoading}>
            {isLoading ? t('auth.signingIn') : t('auth.signIn')}
          </Button>
        </form>

        {error !== null ? (
          <div className="auth-card__error">
            <Alert tone="danger" title={error.code}>
              {error.message}
            </Alert>
          </div>
        ) : null}
      </div>
    </main>
  );
}
