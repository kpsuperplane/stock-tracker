import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { type Locale, type MessageKey, messageCatalog } from "./catalog";

export const LOCALE_STORAGE_KEY = "stock-tracker.locale";

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const localeFromBrowserLanguage = (language?: string): Locale =>
  language?.toLowerCase().startsWith("zh") ? "cn" : "en";

export const readPersistedLocale = (
  storage: StorageLike | null | undefined,
  browserLanguage?: string,
): Locale => {
  let persisted: string | null = null;
  try {
    persisted = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    // Private browsing and disabled storage can throw on reads.
  }
  if (persisted === "en" || persisted === "cn") return persisted;
  return localeFromBrowserLanguage(browserLanguage);
};

const browserStorage = (): StorageLike | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export const persistLocale = (
  storage: StorageLike | null | undefined,
  locale: Locale,
) => {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Quota and blocked-storage failures should not break language switching.
  }
};

const browserLanguage = () =>
  typeof navigator === "undefined" ? undefined : navigator.language;

export interface I18nProviderProps {
  children: React.ReactNode;
  initialLocale?: Locale;
  storage?: StorageLike | null;
  browserLanguage?: string;
}

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider = ({
  children,
  initialLocale,
  storage,
  browserLanguage: language,
}: I18nProviderProps) => {
  const storageRef = storage === undefined ? browserStorage() : storage;
  const languageRef = language === undefined ? browserLanguage() : language;
  const [locale, setLocale] = useState<Locale>(
    () => initialLocale ?? readPersistedLocale(storageRef, languageRef),
  );

  useEffect(() => {
    persistLocale(storageRef, locale);
  }, [locale, storageRef]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key) => messageCatalog[locale][key],
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = () => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return context;
};
