import { AppShell as AstryxAppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { MobileNav, MobileNavToggle } from "@astryxdesign/core/MobileNav";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import {
  SideNav,
  SideNavItem,
  SideNavRenderContext,
  SideNavSection,
  useSideNavRenderMode,
} from "@astryxdesign/core/SideNav";
import {
  TopNav,
  TopNavHeading,
  useTopNavRenderMode,
} from "@astryxdesign/core/TopNav";
import { type ReactNode, useEffect } from "react";
import {
  AccountScopeBar,
  AccountScopeProvider,
} from "../accounts/AccountScopeContext";
import {
  AccountsIcon,
  CalendarIcon,
  EventsIcon,
  PortfolioIcon,
  StatusIcon,
} from "../components/ProductIcons";
import type { Locale } from "../i18n/catalog";
import { I18nProvider, useI18n } from "../i18n/I18nProvider";
import { AccountsPage } from "../pages/AccountsPage";
import { CalendarPage } from "../pages/CalendarPage";
import { EventsPage } from "../pages/EventsPage";
import { PortfolioPage } from "../pages/PortfolioPage";
import { StatusPage } from "../pages/StatusPage";
import { TodayPage } from "../pages/TodayPage";
import {
  APP_ROUTES,
  type AppRoute,
  isPlainLeftClick,
  pathForRoute,
  useAppRouter,
} from "../routing";
import {
  PageActionsProvider,
  useRegisteredPageActions,
  useRegisteredPageTitle,
} from "./PageActionsContext";

const routeCopy = {
  today: {
    title: "today",
    pageTitle: "todayHeading",
    description: "todayDescription",
  },
  portfolio: {
    title: "portfolio",
    pageTitle: "portfolioHeading",
    description: "portfolioDescription",
  },
  events: {
    title: "events",
    pageTitle: "eventsHeading",
    description: "eventsDescription",
  },
  calendar: {
    title: "calendar",
    pageTitle: "calendar",
    description: "calendarDescription",
  },
  status: {
    title: "statusPage",
    pageTitle: "statusHeading",
    description: "statusDescription",
  },
  accounts: {
    title: "accounts",
    pageTitle: "accountsHeading",
    description: "accountsDescription",
  },
} as const;

const routeIcons = {
  today: "clock",
  portfolio: PortfolioIcon,
  events: EventsIcon,
  calendar: CalendarIcon,
  status: StatusIcon,
  accounts: AccountsIcon,
} as const;

interface NavigationProps {
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
}

const LocaleSwitcher = () => {
  const { locale, setLocale, t } = useI18n();
  return (
    <>
      <span className="product-locale-switcher-full">
        <SegmentedControl
          value={locale}
          onChange={(value) => {
            if (value === "en" || value === "cn") setLocale(value);
          }}
          label={t("language")}
          size="sm"
        >
          <SegmentedControlItem value="en" label={t("english")} />
          <SegmentedControlItem value="cn" label={t("chinese")} />
        </SegmentedControl>
      </span>
      <span className="product-locale-switcher-compact">
        <Button
          label={locale === "en" ? t("english") : t("chinese")}
          aria-label={t("language")}
          variant="secondary"
          onClick={() => setLocale(locale === "en" ? "cn" : "en")}
        />
      </span>
    </>
  );
};

const ProductSideNavMobileControls = ({
  hasAccountScope,
}: {
  hasAccountScope: boolean;
}) => {
  return (
    <div className="product-side-nav-mobile-controls">
      {hasAccountScope && (
        <span className="product-side-nav-scope">
          <AccountScopeBar />
        </span>
      )}
      <LocaleSwitcher />
    </div>
  );
};

const ProductNavigation = ({ activeRoute }: NavigationProps) => {
  const { t } = useI18n();
  const renderMode = useTopNavRenderMode();
  const pageActions = useRegisteredPageActions();
  const pageTitle = useRegisteredPageTitle();
  const hasAccountScope =
    activeRoute === "today" ||
    activeRoute === "portfolio" ||
    activeRoute === "events" ||
    activeRoute === "calendar";
  const topNavActions = pageActions ? (
    <span className="product-top-nav-actions">{pageActions}</span>
  ) : null;
  return (
    <TopNav
      className="product-top-nav"
      label={t("navigation")}
      heading={
        <div className="product-top-nav-heading">
          <MobileNavToggle className="product-mobile-nav-toggle" />
          {activeRoute === "calendar" ? (
            pageTitle
          ) : (
            <TopNavHeading
              heading={t(routeCopy[activeRoute].pageTitle)}
              headingHref={pathForRoute(activeRoute)}
            />
          )}
        </div>
      }
      startContent={renderMode === "default" ? topNavActions : undefined}
      endContent={
        <div className="product-top-nav-end">
          {renderMode === "mobile-bar" && topNavActions}
          <span className="product-top-nav-desktop-utilities">
            {hasAccountScope && (
              <span className="product-top-nav-scope-end">
                <AccountScopeBar />
              </span>
            )}
            <LocaleSwitcher />
          </span>
        </div>
      }
    />
  );
};

const ProductSideNavigation = ({
  activeRoute,
  onNavigate,
}: NavigationProps) => {
  const { t } = useI18n();
  const renderMode = useSideNavRenderMode();
  const hasMobileControls = renderMode !== "default" && renderMode !== "topbar";

  return (
    <div className="product-side-nav-rail" data-testid="product-side-nav-rail">
      <SideNav
        className="product-side-nav"
        data-testid="product-side-nav"
        collapsible={{
          isCollapsed: renderMode === "default",
          hasButton: false,
        }}
        {...(hasMobileControls
          ? {
              topContent: (
                <ProductSideNavMobileControls
                  hasAccountScope={
                    activeRoute === "today" ||
                    activeRoute === "portfolio" ||
                    activeRoute === "events" ||
                    activeRoute === "calendar"
                  }
                />
              ),
            }
          : {})}
      >
        <SideNavSection title={t("navigation")} isHeaderHidden>
          {APP_ROUTES.map(({ id }) => (
            <SideNavItem
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
        </SideNavSection>
      </SideNav>
    </div>
  );
};

const ProductMobileNavigation = ({
  activeRoute,
  onNavigate,
}: NavigationProps) => {
  const { t } = useI18n();

  return (
    <MobileNav side="start" header={t("navigation")} label={t("navigation")}>
      <SideNavRenderContext value="drawer-content">
        <ProductSideNavigation
          activeRoute={activeRoute}
          onNavigate={onNavigate}
        />
      </SideNavRenderContext>
    </MobileNav>
  );
};

const ProductDocumentTitle = ({ route }: { route: AppRoute }) => {
  const { t } = useI18n();
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = t(routeCopy[route].title);
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
        <h1 id="product-page-title" className="product-page-title-hidden">
          {t(copy.pageTitle)}
        </h1>
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
      <PageActionsProvider>
        <AccountScopeProvider>
          <ProductDocumentTitle route={router.route} />
          <AstryxAppShell
            className="product-app-shell"
            data-testid="product-app-shell"
            topNav={
              <ProductNavigation
                activeRoute={router.route}
                onNavigate={navigate}
              />
            }
            sideNav={
              <ProductSideNavigation
                activeRoute={router.route}
                onNavigate={navigate}
              />
            }
            mobileNav={{
              breakpoint: "md",
              hasToggle: false,
              content: (
                <ProductMobileNavigation
                  activeRoute={router.route}
                  onNavigate={navigate}
                />
              ),
            }}
            variant="section"
            height="auto"
            contentPadding={3}
          >
            {children ??
              (router.route === "today" ? (
                <TodayPage />
              ) : router.route === "events" ? (
                <EventsPage
                  onImportAccepted={({ importId }) =>
                    navigate("status", { import: importId })
                  }
                />
              ) : router.route === "portfolio" ? (
                <PortfolioPage />
              ) : router.route === "calendar" ? (
                <CalendarPage />
              ) : router.route === "status" ? (
                <StatusPage
                  {...(() => {
                    const importId = new URLSearchParams(
                      router.pathname.split("?", 2)[1] ?? "",
                    ).get("import");
                    return importId ? { highlightedImportId: importId } : {};
                  })()}
                />
              ) : router.route === "accounts" ? (
                <AccountsPage />
              ) : (
                <ProductPage route={router.route} />
              ))}
          </AstryxAppShell>
        </AccountScopeProvider>
      </PageActionsProvider>
    </I18nProvider>
  );
};
