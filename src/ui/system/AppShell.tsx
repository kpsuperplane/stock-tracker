import { AppShell as AstryxAppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { ButtonGroup } from "@astryxdesign/core/ButtonGroup";
import { Icon } from "@astryxdesign/core/Icon";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import type { ReactNode } from "react";
import type { Locale } from "../i18n/catalog";
import { I18nProvider, useI18n } from "../i18n/I18nProvider";
import {
  APP_ROUTES,
  type AppRoute,
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
    <ButtonGroup label={t("language")} size="sm">
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
    <SideNav
      data-testid="product-sidebar"
      header={
        <SideNavHeading
          heading={t("appName")}
          headingHref={pathForRoute("portfolio")}
          icon={<Icon icon="arrowsUpDown" size="sm" />}
        />
      }
      footer={<LocaleSwitcher />}
      collapsible={{ buttonLabel: t("collapseSidebar") }}
    >
      <SideNavSection title={t("navigation")} isHeaderHidden>
        {APP_ROUTES.map(({ id }) => (
          <SideNavItem
            key={id}
            label={t(routeCopy[id].title)}
            icon={routeIcons[id]}
            href={pathForRoute(id)}
            isSelected={activeRoute === id}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(id);
            }}
          />
        ))}
      </SideNavSection>
    </SideNav>
  );
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
      <AstryxAppShell
        data-testid="product-app-shell"
        sideNav={
          <ProductNavigation activeRoute={router.route} onNavigate={navigate} />
        }
        mobileNav={{ breakpoint: "md" }}
        variant="section"
        height="auto"
        contentPadding={4}
      >
        {children ?? <ProductPage route={router.route} />}
      </AstryxAppShell>
    </I18nProvider>
  );
};
