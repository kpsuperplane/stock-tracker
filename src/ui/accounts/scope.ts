import type { SelectorOptionType } from "@astryxdesign/core";
import type {
  AccountCategoryDto,
  AccountDto,
  AccountScopeSelection,
} from "../../shared/contracts";

interface AccountScopeOptionLabels {
  allAccounts: string;
  owners: string;
  owner: string;
  categories: string;
  category: string;
  accounts: string;
  account: string;
  archived: string;
}

export const parseAccountScopeSelection = (
  search: string,
): AccountScopeSelection => {
  const params = new URLSearchParams(search);
  const scopeType = params.get("scopeType");
  const scopeId = params.get("scopeId") ?? undefined;
  if (
    (scopeType === "owner" ||
      scopeType === "category" ||
      scopeType === "account") &&
    scopeId
  ) {
    return { scopeType, scopeId };
  }
  return { scopeType: "all" };
};

export const accountOwnerNames = (categories: AccountCategoryDto[]): string[] =>
  [
    ...new Set(
      categories.flatMap((category) =>
        category.accounts.map((account) => account.owner).filter(Boolean),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));

export const accountsForScope = (
  categories: AccountCategoryDto[],
  selection: AccountScopeSelection,
): AccountDto[] => {
  const accounts = categories.flatMap((category) => category.accounts);
  switch (selection.scopeType) {
    case "owner":
      return accounts.filter((account) => account.owner === selection.scopeId);
    case "category":
      return accounts.filter(
        (account) => account.categoryId === selection.scopeId,
      );
    case "account":
      return accounts.filter((account) => account.id === selection.scopeId);
    default:
      return accounts;
  }
};

export const activeAccountsForScope = (
  categories: AccountCategoryDto[],
  selection: AccountScopeSelection,
): AccountDto[] =>
  accountsForScope(categories, selection).filter(
    (account) => account.archivedAt === null,
  );

export const accountScopeExists = (
  categories: AccountCategoryDto[],
  selection: AccountScopeSelection,
): boolean => {
  switch (selection.scopeType) {
    case "owner":
      return accountOwnerNames(categories).includes(selection.scopeId ?? "");
    case "category":
      return categories.some((category) => category.id === selection.scopeId);
    case "account":
      return categories.some((category) =>
        category.accounts.some((account) => account.id === selection.scopeId),
      );
    default:
      return true;
  }
};

export const buildAccountScopeOptions = (
  categories: AccountCategoryDto[],
  labels: AccountScopeOptionLabels,
): SelectorOptionType[] => {
  const owners = accountOwnerNames(categories);
  return [
    { value: "all", label: labels.allAccounts },
    ...(owners.length > 0
      ? [
          {
            type: "section" as const,
            title: labels.owners,
            options: owners.map((owner) => ({
              value: `owner:${owner}`,
              label: `${labels.owner} / ${owner}`,
            })),
          },
        ]
      : []),
    {
      type: "section",
      title: labels.categories,
      options: categories.map((category) => ({
        value: `category:${category.id}`,
        label: `${labels.category} / ${category.name}${category.archivedAt ? ` (${labels.archived})` : ""}`,
      })),
    },
    {
      type: "section",
      title: labels.accounts,
      options: categories.flatMap((category) =>
        category.accounts.map((account) => ({
          value: `account:${account.id}`,
          label: `${labels.account} / ${category.name} / ${account.name}${account.archivedAt ? ` (${labels.archived})` : ""}`,
        })),
      ),
    },
  ];
};
