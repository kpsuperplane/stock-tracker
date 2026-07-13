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
  setActions: (actions: ReactNode) => void;
}

const PageActionsContext = createContext<PageActionsContextValue | null>(null);

export const PageActionsProvider = ({ children }: { children: ReactNode }) => {
  const [actions, setActions] = useState<ReactNode>(null);
  const value = useMemo(() => ({ actions, setActions }), [actions]);

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

  return setActions !== undefined;
};

export const useRegisteredPageActions = (): ReactNode =>
  useContext(PageActionsContext)?.actions ?? null;
