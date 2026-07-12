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

/**
 * Astryx's DateInput currently formats its calendar with
 * `Intl.DateTimeFormat(undefined, ...)` and does not expose a locale prop.
 * Keep the app-level locale authoritative for that small surface while
 * leaving explicit locale formatters untouched. The original constructor is
 * restored whenever the app switches back to English or unmounts.
 */
const installAstryxDateLocale = (locale: Locale): (() => void) | undefined => {
  if (locale !== "cn" || typeof Intl === "undefined") return undefined;
  const original = Intl.DateTimeFormat;
  // Keep this constructable: Astryx calls DateTimeFormat with `new`.
  // biome-ignore lint/complexity/useArrowFunction: constructor compatibility
  const localized = function (
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new original(locales ?? "zh-CN", options);
  } as unknown as typeof Intl.DateTimeFormat;
  localized.supportedLocalesOf = original.supportedLocalesOf.bind(original);
  try {
    Object.defineProperty(Intl, "DateTimeFormat", {
      value: localized,
      configurable: true,
      writable: true,
    });
  } catch {
    return undefined;
  }
  return () => {
    try {
      Object.defineProperty(Intl, "DateTimeFormat", {
        value: original,
        configurable: true,
        writable: true,
      });
    } catch {
      // A host environment may expose a non-configurable Intl object.
    }
  };
};

const calendarMonthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const calendarWeekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const calendarWeekdayShortNames = [
  "Su",
  "Mo",
  "Tu",
  "We",
  "Th",
  "Fr",
  "Sa",
] as const;

const calendarWeekdayZh = [
  "周日",
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
] as const;

const calendarControlCopy = {
  open: "Open calendar",
  previous: "Previous month",
  next: "Next month",
  close: "Close calendar",
  choose: "Choose date",
} as const;

const calendarControlCopyZh = {
  open: "打开日历",
  previous: "上个月",
  next: "下个月",
  close: "关闭日历",
  choose: "选择日期",
} as const;

const translateAstryxCalendarString = (value: string, locale: Locale) => {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const trimmed = value.trim();
  if (!trimmed) return value;
  const monthIndex = calendarMonthNames.indexOf(
    trimmed as (typeof calendarMonthNames)[number],
  );
  const weekdayIndex = calendarWeekdayNames.indexOf(
    trimmed as (typeof calendarWeekdayNames)[number],
  );
  const weekdayShortIndex = calendarWeekdayShortNames.indexOf(
    trimmed as (typeof calendarWeekdayShortNames)[number],
  );
  let translated = trimmed;
  if (locale === "cn") {
    if (monthIndex >= 0) translated = `${monthIndex + 1}月`;
    else if (weekdayIndex >= 0)
      translated = calendarWeekdayZh[weekdayIndex] ?? trimmed;
    else if (weekdayShortIndex >= 0) {
      translated = calendarWeekdayZh[weekdayShortIndex] ?? trimmed;
    } else if (trimmed === calendarControlCopy.previous) {
      translated = calendarControlCopyZh.previous;
    } else if (trimmed === calendarControlCopy.next) {
      translated = calendarControlCopyZh.next;
    } else if (trimmed === calendarControlCopy.close) {
      translated = calendarControlCopyZh.close;
    } else if (trimmed === calendarControlCopy.open) {
      translated = calendarControlCopyZh.open;
    } else if (trimmed === calendarControlCopy.choose) {
      translated = calendarControlCopyZh.choose;
    } else {
      const monthYear =
        /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/.exec(
          trimmed,
        );
      const dayLabel =
        /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})$/.exec(
          trimmed,
        );
      if (monthYear) {
        const index = calendarMonthNames.indexOf(
          monthYear[1] as (typeof calendarMonthNames)[number],
        );
        translated = `${monthYear[2]}年${index + 1}月`;
      } else if (dayLabel) {
        const weekday = calendarWeekdayNames.indexOf(
          dayLabel[1] as (typeof calendarWeekdayNames)[number],
        );
        const month = calendarMonthNames.indexOf(
          dayLabel[2] as (typeof calendarMonthNames)[number],
        );
        translated = `${dayLabel[4]}年${month + 1}月${dayLabel[3]}日 ${calendarWeekdayZh[weekday]}`;
      }
    }
  } else {
    const monthYear = /^(\d{4})年(\d{1,2})月$/.exec(trimmed);
    const dayLabel =
      /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*)(?:星期|周)(日|一|二|三|四|五|六)$/.exec(
        trimmed,
      );
    const zhMonth = /^(\d{1,2})月$/.exec(trimmed);
    const zhWeekday = calendarWeekdayZh.indexOf(
      trimmed as (typeof calendarWeekdayZh)[number],
    );
    if (monthYear) {
      translated = `${calendarMonthNames[Number(monthYear[2]) - 1]} ${monthYear[1]}`;
    } else if (dayLabel) {
      const month = Number(dayLabel[2]) - 1;
      const weekday = ["日", "一", "二", "三", "四", "五", "六"].indexOf(
        dayLabel[4] ?? "",
      );
      translated = `${calendarWeekdayNames[weekday]}, ${calendarMonthNames[month]} ${dayLabel[3]}, ${dayLabel[1]}`;
    } else if (zhMonth) {
      translated = calendarMonthNames[Number(zhMonth[1]) - 1] ?? trimmed;
    } else if (zhWeekday >= 0) {
      translated = calendarWeekdayShortNames[zhWeekday] ?? trimmed;
    } else if (trimmed === calendarControlCopyZh.previous) {
      translated = calendarControlCopy.previous;
    } else if (trimmed === calendarControlCopyZh.next) {
      translated = calendarControlCopy.next;
    } else if (trimmed === calendarControlCopyZh.close) {
      translated = calendarControlCopy.close;
    } else if (trimmed === calendarControlCopyZh.open) {
      translated = calendarControlCopy.open;
    } else if (trimmed === calendarControlCopyZh.choose) {
      translated = calendarControlCopy.choose;
    }
  }
  return `${leading}${translated}${trailing}`;
};

const observeAstryxCalendarLocale = (locale: Locale): (() => void) => {
  if (
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  ) {
    return () => undefined;
  }
  const apply = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "button[aria-label]",
    )) {
      const value = button.getAttribute("aria-label");
      if (!value) continue;
      const translated = translateAstryxCalendarString(value, locale);
      if (translated !== value) button.setAttribute("aria-label", translated);
    }
    for (const dialog of document.querySelectorAll<HTMLElement>(
      '[role="dialog"]',
    )) {
      if (!dialog.querySelector('[role="grid"]')) continue;
      const ariaLabel = dialog.getAttribute("aria-label");
      if (ariaLabel) {
        const translated = translateAstryxCalendarString(ariaLabel, locale);
        if (translated !== ariaLabel)
          dialog.setAttribute("aria-label", translated);
      }
      const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const translated = translateAstryxCalendarString(
          node.nodeValue ?? "",
          locale,
        );
        if (translated !== node.nodeValue) node.nodeValue = translated;
        node = walker.nextNode();
      }
      for (const element of dialog.querySelectorAll<HTMLElement>(
        "[aria-label]",
      )) {
        const value = element.getAttribute("aria-label");
        if (value) {
          const translated = translateAstryxCalendarString(value, locale);
          if (translated !== value)
            element.setAttribute("aria-label", translated);
        }
      }
    }
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label"],
  });
  return () => observer.disconnect();
};

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

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale === "cn" ? "zh-CN" : "en-US";
    }
    const restoreDateLocale = installAstryxDateLocale(locale);
    const stopCalendarObserver = observeAstryxCalendarLocale(locale);
    return () => {
      restoreDateLocale?.();
      stopCalendarObserver();
    };
  }, [locale]);

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
