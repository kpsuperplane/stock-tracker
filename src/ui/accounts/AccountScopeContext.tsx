import { Selector, VStack } from "@astryxdesign/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  AccountCategoryDto,
  AccountScopeSelection,
} from "../../shared/contracts";
import { api } from "../api";
import { useI18n } from "../i18n/I18nProvider";
import {
  accountOwnerNames,
  accountScopeExists,
  buildAccountScopeOptions,
  parseAccountScopeSelection,
} from "./scope";

interface AccountScopeContextValue {
  categories: AccountCategoryDto[];
  selection: AccountScopeSelection;
  setSelection: (selection: AccountScopeSelection) => void;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const Context = createContext<AccountScopeContextValue | null>(null);

const parseSelection = (): AccountScopeSelection => {
  if (typeof window === "undefined") return { scopeType: "all" };
  return parseAccountScopeSelection(window.location.search);
};

const selectionKey = (selection: AccountScopeSelection): string =>
  selection.scopeType === "all"
    ? "all"
    : `${selection.scopeType}:${selection.scopeId}`;

export const AccountScopeProvider = ({ children }: { children: ReactNode }) => {
  const [categories, setCategories] = useState<AccountCategoryDto[]>([]);
  const [selection, setSelectionState] =
    useState<AccountScopeSelection>(parseSelection);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCategories((await api.accounts.tree(true)).categories);
    } catch {
      setError("Unable to load accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onPopState = () => setSelectionState(parseSelection());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const applySelection = useCallback(
    (next: AccountScopeSelection, historyMode: "push" | "replace") => {
      setSelectionState(next);
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (next.scopeType === "all") {
        url.searchParams.delete("scopeType");
        url.searchParams.delete("scopeId");
      } else {
        url.searchParams.set("scopeType", next.scopeType);
        url.searchParams.set("scopeId", next.scopeId ?? "");
      }
      window.history[historyMode === "push" ? "pushState" : "replaceState"](
        {},
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    },
    [],
  );

  const setSelection = useCallback(
    (next: AccountScopeSelection) => applySelection(next, "push"),
    [applySelection],
  );

  const value = useMemo(
    () => ({ categories, selection, setSelection, loading, error, reload }),
    [categories, error, loading, reload, selection, setSelection],
  );

  useEffect(() => {
    if (
      !loading &&
      !error &&
      selection.scopeType !== "all" &&
      !accountScopeExists(categories, selection)
    ) {
      applySelection({ scopeType: "all" }, "replace");
    }
  }, [applySelection, categories, error, loading, selection]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export const useAccountScope = (): AccountScopeContextValue => {
  const value = useContext(Context);
  return (
    value ?? {
      categories: [],
      selection: { scopeType: "all" },
      setSelection: () => undefined,
      loading: false,
      error: null,
      reload: async () => undefined,
    }
  );
};

export const AccountScopeBar = () => {
  const { t } = useI18n();
  const { categories, selection, setSelection, loading } = useAccountScope();
  const owners = useMemo(() => accountOwnerNames(categories), [categories]);
  const options = useMemo(
    () =>
      buildAccountScopeOptions(categories, {
        allAccounts: t("allAccounts"),
        owners: t("owners"),
        owner: t("owner"),
        categories: t("categories"),
        category: t("category"),
        accounts: t("accounts"),
        account: t("account"),
        archived: t("archived"),
      }),
    [categories, t],
  );
  const value = selectionKey(selection);
  return (
    <VStack gap={1} className="account-scope-bar">
      <Selector
        label={t("accountScope")}
        isLabelHidden
        aria-label={t("accountScope")}
        options={options}
        value={value}
        onChange={(next) => {
          if (next === "all") setSelection({ scopeType: "all" });
          else if (next.startsWith("owner:")) {
            setSelection({ scopeType: "owner", scopeId: next.slice(6) });
          } else if (next.startsWith("category:")) {
            setSelection({ scopeType: "category", scopeId: next.slice(9) });
          } else if (next.startsWith("account:")) {
            setSelection({ scopeType: "account", scopeId: next.slice(8) });
          }
        }}
        isDisabled={loading || (owners.length === 0 && categories.length === 0)}
        size="sm"
        width="100%"
      />
    </VStack>
  );
};
