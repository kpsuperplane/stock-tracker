import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

interface PageActionsContextValue {
  actions: ReactNode;
  title: ReactNode;
  setActions: (actions: ReactNode) => void;
  setTitle: (title: ReactNode) => void;
}

const PageActionsContext = createContext<PageActionsContextValue | null>(null);

export const PageActionsProvider = ({ children }: { children: ReactNode }) => {
  const [actions, setActions] = useState<ReactNode>(null);
  const [title, setTitle] = useState<ReactNode>(null);
  const value = useMemo(
    () => ({ actions, title, setActions, setTitle }),
    [actions, title],
  );

  return (
    <PageActionsContext.Provider value={value}>
      {children}
    </PageActionsContext.Provider>
  );
};

/**
 * Register the current page's actions in the application top navigation.
 * Pages can still render their actions inline when mounted outside ProductApp.
 */
export const usePageActions = (actions: ReactNode): boolean => {
  const context = useContext(PageActionsContext);
  const setActions = context?.setActions;

  useEffect(() => {
    if (!setActions) return;
    setActions(actions);
    return () => setActions(null);
  }, [actions, setActions]);

  return context?.actions !== null && context?.actions !== undefined;
};

export const useRegisteredPageActions = (): ReactNode =>
  useContext(PageActionsContext)?.actions ?? null;

/**
 * Register the current page's title-slot content in the application top
 * navigation. Pages can still render the same content inline when mounted
 * outside ProductApp.
 */
export const usePageTitle = (title: ReactNode): boolean => {
  const context = useContext(PageActionsContext);
  const setTitle = context?.setTitle;

  useEffect(() => {
    if (!setTitle) return;
    setTitle(title);
    return () => setTitle(null);
  }, [setTitle, title]);

  return setTitle !== undefined;
};

export const useRegisteredPageTitle = (): ReactNode =>
  useContext(PageActionsContext)?.title ?? null;
