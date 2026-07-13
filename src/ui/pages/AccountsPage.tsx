import {
  Badge,
  Banner,
  Button,
  HStack,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TextInput,
  VStack,
} from "@astryxdesign/core";
import { useCallback, useEffect, useState } from "react";
import type { AccountCategoryDto } from "../../shared/contracts";
import { useAccountScope } from "../accounts/AccountScopeContext";
import { api } from "../api";
import { useI18n } from "../i18n/I18nProvider";

export const AccountsPage = () => {
  const { t } = useI18n();
  const { reload: reloadAccountScope } = useAccountScope();
  const [categories, setCategories] = useState<AccountCategoryDto[]>([]);
  const [newCategory, setNewCategory] = useState("");
  const [newAccounts, setNewAccounts] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = (await api.accounts.tree(true)).categories;
      setCategories(next);
      setNames(
        Object.fromEntries(
          next.flatMap((category) => [
            [category.id, category.name],
            ...category.accounts.map((account) => [account.id, account.name]),
          ]),
        ),
      );
    } catch {
      setError(t("accountsLoadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
      await reloadAccountScope();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("accountsMutationError"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <VStack gap={3} data-testid="accounts-page">
      <header>
        <h1 className="product-page-title-hidden">{t("accountsHeading")}</h1>
        <p>{t("accountsDescription")}</p>
      </header>
      {error && <Banner status="error" title={error} />}
      <HStack gap={2} align="end" wrap="wrap">
        <TextInput
          label={t("newCategory")}
          value={newCategory}
          onChange={setNewCategory}
          size="sm"
        />
        <Button
          variant="primary"
          label={t("addCategory")}
          isLoading={busy === "category-create"}
          isDisabled={!newCategory.trim() || busy !== null}
          onClick={() =>
            void run("category-create", async () => {
              await api.accounts.createCategory({ name: newCategory });
              setNewCategory("");
            })
          }
        />
      </HStack>
      {loading && <Banner status="info" title={t("loadingAccounts")} />}
      {!loading && categories.length === 0 && (
        <Banner status="info" title={t("noAccounts")} />
      )}
      {categories.map((category) => {
        const categoryName = names[category.id] ?? category.name;
        const canArchiveCategory = category.accounts.every(
          (account) => account.archivedAt !== null,
        );
        return (
          <VStack key={category.id} gap={2} className="accounts-category">
            <HStack gap={2} align="end" wrap="wrap" justify="between">
              <TextInput
                label={t("categoryName")}
                value={categoryName}
                onChange={(value) =>
                  setNames((previous) => ({
                    ...previous,
                    [category.id]: value,
                  }))
                }
                size="sm"
              />
              <HStack gap={1} wrap="nowrap">
                <Button
                  variant="secondary"
                  size="sm"
                  label={t("save")}
                  isDisabled={
                    busy !== null ||
                    !categoryName.trim() ||
                    categoryName === category.name
                  }
                  isLoading={busy === `category-${category.id}`}
                  onClick={() =>
                    void run(`category-${category.id}`, () =>
                      api.accounts.updateCategory(
                        category.id,
                        { name: categoryName },
                        category.revision,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  label={category.archivedAt ? t("restore") : t("archive")}
                  isDisabled={
                    busy !== null ||
                    (!category.archivedAt && !canArchiveCategory)
                  }
                  onClick={() =>
                    void run(`category-archive-${category.id}`, () =>
                      api.accounts.updateCategory(
                        category.id,
                        { archived: category.archivedAt === null },
                        category.revision,
                      ),
                    )
                  }
                />
              </HStack>
            </HStack>
            <Table density="compact" dividers="rows" aria-label={category.name}>
              <TableHeader>
                <TableRow isHeaderRow>
                  <TableHeaderCell>{t("accountName")}</TableHeaderCell>
                  <TableHeaderCell>{t("status")}</TableHeaderCell>
                  <TableHeaderCell>{t("actions")}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {category.accounts.map((account) => {
                  const accountName = names[account.id] ?? account.name;
                  return (
                    <TableRow key={account.id}>
                      <TableCell>
                        <TextInput
                          label={t("accountName")}
                          isLabelHidden
                          value={accountName}
                          onChange={(value) =>
                            setNames((previous) => ({
                              ...previous,
                              [account.id]: value,
                            }))
                          }
                          size="sm"
                        />
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={account.archivedAt ? "neutral" : "success"}
                          label={
                            account.archivedAt ? t("archived") : t("active")
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <HStack gap={1} wrap="nowrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            label={t("save")}
                            isDisabled={
                              busy !== null ||
                              !accountName.trim() ||
                              accountName === account.name
                            }
                            isLoading={busy === `account-${account.id}`}
                            onClick={() =>
                              void run(`account-${account.id}`, () =>
                                api.accounts.updateAccount(
                                  account.id,
                                  { name: accountName },
                                  account.revision,
                                ),
                              )
                            }
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            label={
                              account.archivedAt ? t("restore") : t("archive")
                            }
                            isDisabled={busy !== null}
                            onClick={() =>
                              void run(`account-archive-${account.id}`, () =>
                                api.accounts.updateAccount(
                                  account.id,
                                  { archived: account.archivedAt === null },
                                  account.revision,
                                ),
                              )
                            }
                          />
                        </HStack>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!category.archivedAt && (
                  <TableRow>
                    <TableCell>
                      <TextInput
                        label={t("newAccount")}
                        isLabelHidden
                        placeholder={t("newAccount")}
                        value={newAccounts[category.id] ?? ""}
                        onChange={(value) =>
                          setNewAccounts((previous) => ({
                            ...previous,
                            [category.id]: value,
                          }))
                        }
                        size="sm"
                      />
                    </TableCell>
                    <TableCell />
                    <TableCell>
                      <Button
                        variant="secondary"
                        size="sm"
                        label={t("addAccount")}
                        isDisabled={
                          busy !== null ||
                          !(newAccounts[category.id] ?? "").trim()
                        }
                        isLoading={busy === `account-create-${category.id}`}
                        onClick={() =>
                          void run(
                            `account-create-${category.id}`,
                            async () => {
                              await api.accounts.createAccount({
                                categoryId: category.id,
                                name: newAccounts[category.id] ?? "",
                              });
                              setNewAccounts((previous) => ({
                                ...previous,
                                [category.id]: "",
                              }));
                            },
                          )
                        }
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </VStack>
        );
      })}
    </VStack>
  );
};
