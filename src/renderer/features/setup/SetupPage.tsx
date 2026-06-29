/**
 * Initial admin setup screen. Reachable only on first run when
 * `setup:isRequired` returns true. Validates: Requirements 1.6, 14.2.
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

export function SetupPage(): ReactElement {
  const t = useT();
  const { createInitialAdmin, isLoading } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<ErrorEnvelope | null>(null);

  const trimmedUsername = username.trim();
  const passwordsMatch = password === confirmPassword;
  const showMismatchHint =
    !passwordsMatch && (password.length > 0 || confirmPassword.length > 0);

  const canSubmit =
    trimmedUsername.length > 0 &&
    password.length > 0 &&
    confirmPassword.length > 0 &&
    passwordsMatch &&
    !isLoading;

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!canSubmit) return;
      setError(null);
      void (async () => {
        const result = await createInitialAdmin(trimmedUsername, password);
        if (result.ok) return;
        setError(result.error);
        setPassword('');
        setConfirmPassword('');
      })();
    },
    [canSubmit, createInitialAdmin, trimmedUsername, password],
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
        <h1 className="auth-card__title">{t('setup.welcome')}</h1>
        <p className="auth-card__subtitle">{t('setup.subtitle')}</p>

        <form onSubmit={handleSubmit}>
          <Field label={t('auth.username')} htmlFor="setup-username">
            <Input
              id="setup-username"
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

          <Field label={t('auth.password')} htmlFor="setup-password">
            <Input
              id="setup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </Field>

          <Field
            label={t('auth.confirmPassword')}
            htmlFor="setup-confirm-password"
            error={showMismatchHint ? t('setup.passwordMismatch') : null}
          >
            <Input
              id="setup-confirm-password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              invalid={showMismatchHint}
              aria-invalid={showMismatchHint}
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
              }}
            />
          </Field>

          <Button type="submit" block size="lg" disabled={!canSubmit} loading={isLoading}>
            {isLoading ? t('common.saving') : t('setup.createAdmin')}
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
