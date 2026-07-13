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
  const params = new URLSearchParams(window.location.search);
  const scopeType = params.get("scopeType");
  const scopeId = params.get("scopeId") ?? undefined;
  if ((scopeType === "category" || scopeType === "account") && scopeId) {
    return { scopeType, scopeId };
  }
  return { scopeType: "all" };
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

  const setSelection = useCallback((next: AccountScopeSelection) => {
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
    window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const value = useMemo(
    () => ({ categories, selection, setSelection, loading, error, reload }),
    [categories, error, loading, reload, selection, setSelection],
  );
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
  const options = useMemo(
    () => [
      { value: "all", label: t("allAccounts") },
      ...categories.flatMap((category) => [
        {
          value: `category:${category.id}`,
          label: `${category.name}${category.archivedAt ? ` · ${t("archived")}` : ""}`,
        },
        ...category.accounts.map((account) => ({
          value: `account:${account.id}`,
          label: `↳ ${category.name} / ${account.name}${account.archivedAt ? ` · ${t("archived")}` : ""}`,
        })),
      ]),
    ],
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
          else if (next.startsWith("category:")) {
            setSelection({ scopeType: "category", scopeId: next.slice(9) });
          } else if (next.startsWith("account:")) {
            setSelection({ scopeType: "account", scopeId: next.slice(8) });
          }
        }}
        isDisabled={loading || options.length === 1}
        size="sm"
        width="100%"
      />
    </VStack>
  );
};
