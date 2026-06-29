import { useLanguage } from '@renderer/i18n';

import type { ReactElement } from 'react';

export function LanguageToggle(): ReactElement {
  const { lang, setLang } = useLanguage();
  return (
    <div className="lang-toggle" role="group" aria-label="Language">
      <button
        type="button"
        className="lang-toggle__btn"
        data-active={lang === 'bn'}
        onClick={() => {
          setLang('bn');
        }}
      >
        বাংলা
      </button>
      <button
        type="button"
        className="lang-toggle__btn"
        data-active={lang === 'en'}
        onClick={() => {
          setLang('en');
        }}
      >
        EN
      </button>
    </div>
  );
}
