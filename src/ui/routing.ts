import { useCallback, useEffect, useState } from "react";

export type AppRoute = "portfolio" | "events" | "calendar" | "accounts";

export interface AppRouteDefinition {
  id: AppRoute;
  path: string;
}

export const APP_ROUTES: readonly AppRouteDefinition[] = [
  { id: "portfolio", path: "/portfolio" },
  { id: "events", path: "/events" },
  { id: "calendar", path: "/calendar" },
  { id: "accounts", path: "/accounts" },
];

const stripQueryAndHash = (pathname: string) =>
  pathname.split(/[?#]/, 1)[0] ?? "";

const normalizePath = (pathname: string) => {
  const path = stripQueryAndHash(pathname.trim());
  if (!path || path === "/") return "/";
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return withLeadingSlash.replace(/\/+$/, "");
};

export const pathForRoute = (route: AppRoute): string =>
  APP_ROUTES.find((candidate) => candidate.id === route)?.path ?? "/portfolio";

export const routeForPath = (pathname: string): AppRoute => {
  const normalizedPath = normalizePath(pathname);
  return (
    APP_ROUTES.find((candidate) => candidate.path === normalizedPath)?.id ??
    "portfolio"
  );
};

export const readPathname = () =>
  typeof window === "undefined"
    ? "/portfolio"
    : `${window.location.pathname}${window.location.search}`;

export const isPlainLeftClick = (event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

export interface AppRouter {
  pathname: string;
  route: AppRoute;
  navigate: (route: AppRoute) => void;
}

export const useAppRouter = (initialPath?: string): AppRouter => {
  const [pathname, setPathname] = useState(() => initialPath ?? readPathname());

  useEffect(() => {
    if (initialPath !== undefined || typeof window === "undefined") return;
    const onPopState = () =>
      setPathname(`${window.location.pathname}${window.location.search}`);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [initialPath]);

  const navigate = useCallback((route: AppRoute) => {
    const nextPath = `${pathForRoute(route)}${
      typeof window === "undefined" ? "" : window.location.search
    }`;
    if (typeof window === "undefined") {
      setPathname(nextPath);
      return;
    }
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setPathname(nextPath);
  }, []);

  return { pathname, route: routeForPath(pathname), navigate };
};
