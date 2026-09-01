import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './locales/ar.json';
import en from './locales/en.json';

export const RTL_LANGUAGES = new Set(['ar']);

const STORAGE_KEY = 'ros-erp-lang';

function initialLanguage(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'ar';
  } catch {
    return 'ar';
  }
}

i18n.use(initReactI18next).init({
  resources: { ar: { translation: ar }, en: { translation: en } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function applyDocumentDirection(language: string) {
  const dir = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
  document.documentElement.dir = dir;
  document.documentElement.lang = language;
}

export function setLanguage(language: string) {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    /* best-effort persistence only */
  }
  applyDocumentDirection(language);
  void i18n.changeLanguage(language);
}

applyDocumentDirection(i18n.language);

export default i18n;
