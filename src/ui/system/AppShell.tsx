import { AppShell as AstryxAppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { ButtonGroup } from "@astryxdesign/core/ButtonGroup";
import { Icon } from "@astryxdesign/core/Icon";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";
import { type ReactNode, useEffect } from "react";
import type { Locale } from "../i18n/catalog";
import { I18nProvider, useI18n } from "../i18n/I18nProvider";
import { BackfillPage } from "../pages/BackfillPage";
import { CalendarPage } from "../pages/CalendarPage";
import { EventsPage } from "../pages/EventsPage";
import { PortfolioPage } from "../pages/PortfolioPage";
import {
  APP_ROUTES,
  type AppRoute,
  isPlainLeftClick,
  pathForRoute,
  useAppRouter,
} from "../routing";

const routeCopy = {
  portfolio: { title: "portfolio", description: "portfolioDescription" },
  events: { title: "events", description: "eventsDescription" },
  calendar: { title: "calendar", description: "calendarDescription" },
  backfill: { title: "backfill", description: "backfillDescription" },
} as const;

const routeIcons = {
  portfolio: "viewColumns",
  events: "copy",
  calendar: "calendar",
  backfill: "wrench",
} as const;

interface NavigationProps {
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
}

const LocaleSwitcher = () => {
  const { locale, setLocale, t } = useI18n();
  return (
    <ButtonGroup label={t("language")} size="sm" orientation="horizontal">
      <Button
        label={t("english")}
        variant={locale === "en" ? "secondary" : "ghost"}
        aria-pressed={locale === "en"}
        onClick={() => setLocale("en")}
      />
      <Button
        label={t("chinese")}
        variant={locale === "cn" ? "secondary" : "ghost"}
        aria-pressed={locale === "cn"}
        onClick={() => setLocale("cn")}
      />
    </ButtonGroup>
  );
};

const ProductNavigation = ({ activeRoute, onNavigate }: NavigationProps) => {
  const { t } = useI18n();
  return (
    <TopNav
      className="product-top-nav"
      label={t("navigation")}
      heading={
        <TopNavHeading
          heading={t("appName")}
          headingHref={pathForRoute("portfolio")}
          logo={<Icon icon="arrowsUpDown" size="sm" />}
        />
      }
      startContent={
        <>
          {APP_ROUTES.map(({ id }) => (
            <TopNavItem
              key={id}
              label={t(routeCopy[id].title)}
              icon={<Icon icon={routeIcons[id]} size="sm" />}
              href={pathForRoute(id)}
              isSelected={activeRoute === id}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                onNavigate(id);
              }}
            />
          ))}
          <span className="mobile-locale-switcher">
            <LocaleSwitcher />
          </span>
        </>
      }
      endContent={<LocaleSwitcher />}
    />
  );
};

const ProductDocumentTitle = ({ route }: { route: AppRoute }) => {
  const { t } = useI18n();
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = `${t(routeCopy[route].title)} · ${t("appName")}`;
    }
  }, [route, t]);
  return null;
};

interface ProductPageProps {
  route: AppRoute;
}

const ProductPage = ({ route }: ProductPageProps) => {
  const { t } = useI18n();
  const copy = routeCopy[route];
  return (
    <section
      className="product-page"
      data-testid={`product-page-${route}`}
      aria-labelledby="product-page-title"
    >
      <header>
        <h1 id="product-page-title">{t(copy.title)}</h1>
        <p>{t(copy.description)}</p>
      </header>
    </section>
  );
};

export interface ProductAppProps {
  initialPath?: string;
  initialLocale?: Locale;
  children?: ReactNode;
}

/** Feature-flagged product UI shell; the legacy App remains outside it. */
export const ProductApp = ({
  initialPath,
  initialLocale,
  children,
}: ProductAppProps) => {
  const router = useAppRouter(initialPath);
  const navigate = router.navigate;
  const i18nProps = initialLocale === undefined ? {} : { initialLocale };
  return (
    <I18nProvider {...i18nProps}>
      <ProductDocumentTitle route={router.route} />
      <AstryxAppShell
        data-testid="product-app-shell"
        topNav={
          <ProductNavigation activeRoute={router.route} onNavigate={navigate} />
        }
        mobileNav={{ breakpoint: "md" }}
        variant="section"
        height="auto"
        contentPadding={3}
      >
        {children ??
          (router.route === "events" ? (
            <EventsPage />
          ) : router.route === "portfolio" ? (
            <PortfolioPage />
          ) : router.route === "calendar" ? (
            <CalendarPage />
          ) : router.route === "backfill" ? (
            <BackfillPage />
          ) : (
            <ProductPage route={router.route} />
          ))}
      </AstryxAppShell>
    </I18nProvider>
  );
};
