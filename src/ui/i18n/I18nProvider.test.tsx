import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  I18nProvider,
  localeFromBrowserLanguage,
  persistLocale,
  readPersistedLocale,
  type StorageLike,
  useI18n,
} from "./I18nProvider";

const Probe = () => {
  const { locale, t } = useI18n();
  return (
    <output data-locale={locale}>
      {t("portfolio")} / {t("events")}
    </output>
  );
};

describe("I18nProvider", () => {
  it("defaults Chinese browser languages to CN and others to EN", () => {
    expect(localeFromBrowserLanguage("zh-CN")).toBe("cn");
    expect(localeFromBrowserLanguage("zh-Hant-TW")).toBe("cn");
    expect(localeFromBrowserLanguage("en-US")).toBe("en");
    expect(localeFromBrowserLanguage(undefined)).toBe("en");
  });

  it("prefers a valid persisted locale over the browser default", () => {
    const storage: StorageLike = {
      getItem: (key) => (key === "stock-tracker.locale" ? "cn" : null),
      setItem: () => undefined,
    };
    expect(readPersistedLocale(storage, "en-US")).toBe("cn");
    expect(readPersistedLocale(undefined, "zh-CN")).toBe("cn");
    expect(readPersistedLocale(undefined, "en-US")).toBe("en");
  });

  it("falls back cleanly when browser storage is blocked or full", () => {
    const blockedStorage: StorageLike = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };

    expect(readPersistedLocale(blockedStorage, "zh-CN")).toBe("cn");
    expect(() => persistLocale(blockedStorage, "en")).not.toThrow();
  });

  it("renders localized copy from the selected initial locale", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="cn">
        <Probe />
      </I18nProvider>,
    );
    expect(markup).toContain('data-locale="cn"');
    expect(markup).toContain("投资组合 / 事件");
  });
});
