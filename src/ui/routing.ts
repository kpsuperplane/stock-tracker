import { useCallback, useEffect, useState } from "react";

export type AppRoute =
  | "today"
  | "portfolio"
  | "events"
  | "calendar"
  | "status"
  | "accounts";

export interface AppRouteDefinition {
  id: AppRoute;
  path: string;
}

export const APP_ROUTES: readonly AppRouteDefinition[] = [
  { id: "today", path: "/today" },
  { id: "portfolio", path: "/portfolio" },
  { id: "events", path: "/events" },
  { id: "calendar", path: "/calendar" },
  { id: "status", path: "/status" },
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
  APP_ROUTES.find((candidate) => candidate.id === route)?.path ?? "/today";

export const routeForPath = (pathname: string): AppRoute => {
  const normalizedPath = normalizePath(pathname);
  return (
    APP_ROUTES.find((candidate) => candidate.path === normalizedPath)?.id ??
    "today"
  );
};

export const readPathname = () =>
  typeof window === "undefined"
    ? "/today"
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

export const sharedScopeSearch = (search: string): string => {
  const shared = new URLSearchParams();
  const current = new URLSearchParams(search);
  const scopeType = current.get("scopeType");
  const scopeId = current.get("scopeId");
  if (scopeType) shared.set("scopeType", scopeType);
  if (scopeId) shared.set("scopeId", scopeId);
  const query = shared.toString();
  return query ? `?${query}` : "";
};

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
    const query =
      typeof window === "undefined"
        ? ""
        : sharedScopeSearch(window.location.search);
    const nextPath = `${pathForRoute(route)}${query}`;
    if (typeof window === "undefined") {
      setPathname(nextPath);
      return;
    }
    if (`${window.location.pathname}${window.location.search}` !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setPathname(nextPath);
  }, []);

  return { pathname, route: routeForPath(pathname), navigate };
};
