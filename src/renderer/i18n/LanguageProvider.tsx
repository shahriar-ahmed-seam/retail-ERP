/*
 * Language context. Holds the active language (bn | en), persists the
 * choice to localStorage, exposes `t(key)` for translation and money /
 * date formatting helpers used across the renderer.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { MESSAGES, type MessageKey } from './messages';

export type Lang = 'bn' | 'en';

const STORAGE_KEY = 'somokolon.lang';
const DEFAULT_LANG: Lang = 'bn';

interface LanguageContextValue {
  readonly lang: Lang;
  readonly setLang: (lang: Lang) => void;
  readonly toggle: () => void;
  readonly t: (key: MessageKey) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function readStoredLang(): Lang {
  if (typeof window === 'undefined') return DEFAULT_LANG;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'bn' || stored === 'en' ? stored : DEFAULT_LANG;
}

export interface LanguageProviderProps {
  readonly children: ReactNode;
  readonly initialLang?: Lang;
}

export function LanguageProvider({
  children,
  initialLang,
}: LanguageProviderProps): ReactElement {
  const [lang, setLangState] = useState<Lang>(initialLang ?? readStoredLang());

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const setLang = useCallback((next: Lang): void => {
    setLangState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const toggle = useCallback((): void => {
    setLang(lang === 'bn' ? 'en' : 'bn');
  }, [lang, setLang]);

  const t = useCallback(
    (key: MessageKey): string => MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key,
    [lang],
  );

  const value = useMemo<LanguageContextValue>(
    () => ({ lang, setLang, toggle, t }),
    [lang, setLang, toggle, t],
  );

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

// Fallback used when a component is mounted without a provider (chiefly
// in unit tests that render a page in isolation). Resolves to the English
// source strings and treats language controls as no-ops.
const FALLBACK: LanguageContextValue = {
  lang: 'en',
  setLang: () => undefined,
  toggle: () => undefined,
  t: (key) => MESSAGES.en[key] ?? key,
};

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext) ?? FALLBACK;
}

/** Translation-only hook for components that do not need the language controls. */
export function useT(): (key: MessageKey) => string {
  return useLanguage().t;
}
