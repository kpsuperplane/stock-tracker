import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Heading,
  HStack,
  Skeleton,
  Text,
  TextInput,
  VStack,
} from "@astryxdesign/core";
import { useCallback, useEffect, useState } from "react";
import type { AccountCategoryDto } from "../../shared/contracts";
import { useAccountScope } from "../accounts/AccountScopeContext";
import { api } from "../api";
import { useI18n } from "../i18n/I18nProvider";

const AccountsLoadingState = ({ label }: { label: string }) => (
  <div
    className="accounts-loading-state"
    role="status"
    aria-live="polite"
    aria-busy="true"
  >
    <span className="product-page-title-hidden">{label}</span>
    {[0, 1].map((index) => (
      <Card key={index} padding={4}>
        <VStack gap={3}>
          <Skeleton width="38%" height={22} index={index * 3} />
          <Skeleton width="100%" height={36} index={index * 3 + 1} />
          <Skeleton width="100%" height={52} index={index * 3 + 2} />
        </VStack>
      </Card>
    ))}
  </div>
);

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

  const createCategory = () => {
    if (!newCategory.trim() || busy !== null) return;
    void run("category-create", async () => {
      await api.accounts.createCategory({ name: newCategory });
      setNewCategory("");
    });
  };

  return (
    <VStack gap={5} className="accounts-page" data-testid="accounts-page">
      <header className="accounts-page-intro">
        <Heading level={1} className="product-page-title-hidden">
          {t("accountsHeading")}
        </Heading>
        <Text as="p" color="secondary">
          {t("accountsDescription")}
        </Text>
      </header>

      {error && <Banner status="error" title={error} />}

      <section aria-labelledby="accounts-create-heading">
        <Card variant="muted" padding={4} className="accounts-create-card">
          <div className="accounts-create-layout">
            <VStack gap={1}>
              <Heading level={2} id="accounts-create-heading">
                {t("addCategory")}
              </Heading>
              <Text as="p" type="supporting" color="secondary">
                {t("addCategoryDescription")}
              </Text>
            </VStack>
            <div className="accounts-create-controls">
              <TextInput
                label={t("newCategory")}
                isLabelHidden
                placeholder={t("newCategory")}
                value={newCategory}
                onChange={setNewCategory}
                onEnter={createCategory}
                width="100%"
                size="sm"
              />
              <Button
                variant="primary"
                label={t("addCategory")}
                isLoading={busy === "category-create"}
                isDisabled={!newCategory.trim() || busy !== null}
                onClick={createCategory}
              />
            </div>
          </div>
        </Card>
      </section>

      {loading && <AccountsLoadingState label={t("loadingAccounts")} />}

      {!loading && categories.length === 0 && (
        <Card padding={0}>
          <EmptyState
            headingLevel={2}
            title={t("noAccounts")}
            description={t("noAccountsDescription")}
          />
        </Card>
      )}

      {!loading && categories.length > 0 && (
        <section
          className="accounts-category-section"
          aria-labelledby="accounts-categories-heading"
        >
          <VStack gap={3}>
            <div className="accounts-section-heading">
              <Heading level={2} id="accounts-categories-heading">
                {t("accountCategories")}
              </Heading>
              <Text type="supporting" color="secondary">
                {categories.length} {t("categories")}
              </Text>
            </div>

            {categories.map((category) => {
              const categoryName = names[category.id] ?? category.name;
              const canArchiveCategory = category.accounts.every(
                (account) => account.archivedAt !== null,
              );
              const createAccount = () => {
                const name = newAccounts[category.id] ?? "";
                if (!name.trim() || busy !== null) return;
                void run(`account-create-${category.id}`, async () => {
                  await api.accounts.createAccount({
                    categoryId: category.id,
                    name,
                  });
                  setNewAccounts((previous) => ({
                    ...previous,
                    [category.id]: "",
                  }));
                });
              };

              return (
                <Card
                  key={category.id}
                  padding={0}
                  className="accounts-category"
                >
                  <div className="accounts-category-header">
                    <div className="accounts-category-title-row">
                      <VStack gap={0.5}>
                        <HStack gap={1.5} align="center" wrap="wrap">
                          <Heading level={3}>{category.name}</Heading>
                          {category.archivedAt && (
                            <Badge variant="neutral" label={t("archived")} />
                          )}
                        </HStack>
                        <Text type="supporting" color="secondary">
                          {category.accounts.length} {t("accounts")}
                        </Text>
                      </VStack>
                    </div>

                    <div className="accounts-category-controls">
                      <TextInput
                        label={t("categoryName")}
                        value={categoryName}
                        onChange={(value) =>
                          setNames((previous) => ({
                            ...previous,
                            [category.id]: value,
                          }))
                        }
                        width="100%"
                        size="sm"
                      />
                      <HStack gap={1} wrap="nowrap" align="end">
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
                          label={
                            category.archivedAt ? t("restore") : t("archive")
                          }
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
                    </div>

                    {!category.archivedAt && !canArchiveCategory && (
                      <Text
                        as="p"
                        type="supporting"
                        color="secondary"
                        className="accounts-category-archive-hint"
                      >
                        {t("archiveCategoryHint")}
                      </Text>
                    )}
                  </div>

                  <div className="accounts-category-body">
                    <div className="accounts-list-heading">
                      <Heading level={4}>{t("accounts")}</Heading>
                      <Text type="supporting" color="secondary">
                        {t("accountsInCategoryDescription")}
                      </Text>
                    </div>

                    {category.accounts.length === 0 && (
                      <div className="accounts-category-empty">
                        <Text as="p" type="supporting" color="secondary">
                          {t("noAccountsInCategory")}
                        </Text>
                      </div>
                    )}

                    {category.accounts.length > 0 && (
                      <div className="accounts-account-list">
                        {category.accounts.map((account) => {
                          const accountName = names[account.id] ?? account.name;
                          return (
                            <div
                              className="accounts-account-row"
                              key={account.id}
                            >
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
                                width="100%"
                                size="sm"
                              />
                              <div className="accounts-account-status">
                                <Badge
                                  variant={
                                    account.archivedAt ? "neutral" : "success"
                                  }
                                  label={
                                    account.archivedAt
                                      ? t("archived")
                                      : t("active")
                                  }
                                />
                              </div>
                              <HStack
                                gap={1}
                                wrap="nowrap"
                                justify="end"
                                className="accounts-account-actions"
                              >
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
                                    account.archivedAt
                                      ? t("restore")
                                      : t("archive")
                                  }
                                  isDisabled={busy !== null}
                                  onClick={() =>
                                    void run(
                                      `account-archive-${account.id}`,
                                      () =>
                                        api.accounts.updateAccount(
                                          account.id,
                                          {
                                            archived:
                                              account.archivedAt === null,
                                          },
                                          account.revision,
                                        ),
                                    )
                                  }
                                />
                              </HStack>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {!category.archivedAt && (
                      <div className="accounts-add-account-row">
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
                          onEnter={createAccount}
                          width="100%"
                          size="sm"
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          label={t("addAccount")}
                          isDisabled={
                            busy !== null ||
                            !(newAccounts[category.id] ?? "").trim()
                          }
                          isLoading={busy === `account-create-${category.id}`}
                          onClick={createAccount}
                        />
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </VStack>
        </section>
      )}
    </VStack>
  );
};
