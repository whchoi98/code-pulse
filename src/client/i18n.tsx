import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Category, Channel, Language } from '../shared/types';

const LANGUAGE_KEY = 'code-pulse-language';

export function translate(language: Language, ko: string, en: string): string {
  return language === 'en' ? en : ko;
}

export function languageFromLocation(search: string, saved: string | null = null): Language {
  const explicit = new URLSearchParams(search).get('lang');
  if (explicit === 'ko' || explicit === 'en') return explicit;
  return saved === 'en' ? 'en' : 'ko';
}

export function getInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'ko';
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(LANGUAGE_KEY); } catch { /* URL selection works without storage. */ }
  return languageFromLocation(window.location.search, saved);
}

type Locale = {
  language: Language;
  locale: string;
  setLanguage: (language: Language) => void;
  t: (ko: string, en: string) => string;
};

const LocaleContext = createContext<Locale>({
  language: 'ko', locale: 'ko-KR', setLanguage: () => {}, t: (ko: string) => ko,
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState(getInitialLanguage);
  const setLanguage = useCallback((next: Language) => {
    const url = new URL(window.location.href);
    url.searchParams.set('lang', next);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    try { window.localStorage.setItem(LANGUAGE_KEY, next); } catch { /* Keep the selection for the current tab. */ }
    setLanguageState(next);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.head.querySelector('link[rel="alternate"][type="application/rss+xml"]')
      ?.setAttribute('href', `/feed.xml?lang=${language}`);
  }, [language]);

  useEffect(() => {
    const sync = () => setLanguageState(getInitialLanguage());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const value = useMemo<Locale>(() => ({
    language, locale: language === 'en' ? 'en-US' : 'ko-KR', setLanguage,
    t: (ko, en) => translate(language, ko, en),
  }), [language, setLanguage]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}

const categoryNames: Record<Language, Record<Category, string>> = {
  ko: { feature: '새 기능', improvement: '개선', fix: '오류 수정', security: '보안', breaking: '호환성 변경' },
  en: { feature: 'New feature', improvement: 'Improvement', fix: 'Fix', security: 'Security', breaking: 'Breaking change' },
};
const channelNames: Record<Language, Record<Channel, string>> = {
  ko: { cli: 'CLI', ide: 'IDE', app: '앱', web: '웹', general: '제품' },
  en: { cli: 'CLI', ide: 'IDE', app: 'App', web: 'Web', general: 'Product' },
};

export function categoryLabel(category: Category, language: Language): string {
  return categoryNames[language][category];
}

export function channelLabel(channel: Channel, language: Language): string {
  return channelNames[language][channel];
}
