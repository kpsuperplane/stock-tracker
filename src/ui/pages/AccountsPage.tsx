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
import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountCategoryDto, AccountDto } from "../../shared/contracts";
import { useAccountScope } from "../accounts/AccountScopeContext";
import { ApiClientError, api } from "../api";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/I18nProvider";

const formatCategoryCount = (count: number, locale: "en" | "cn") =>
  locale === "cn"
    ? `${count} 个类别`
    : `${count} ${count === 1 ? "category" : "categories"}`;

const formatAccountCount = (count: number, locale: "en" | "cn") =>
  locale === "cn"
    ? `${count} 个账户`
    : `${count} ${count === 1 ? "account" : "accounts"}`;

export const accountsMutationMessageKey = (error: unknown): MessageKey => {
  if (!(error instanceof ApiClientError)) return "accountsMutationError";
  switch (error.code) {
    case "duplicate_account_name":
      return "duplicateAccountName";
    case "account_protected":
      return "accountProtected";
    case "account_has_holdings":
      return "accountHasHoldings";
    case "category_required":
    case "category_archived":
      return "restoreCategoryFirst";
    case "account_conflict":
    case "category_conflict":
      return "accountStructureConflict";
    case "category_has_accounts":
    case "category_has_active_accounts":
      return "archiveCategoryHint";
    case "account_category_protected":
      return "categoryProtected";
    default:
      return "accountsMutationError";
  }
};

export const mergeAccountNameDrafts = (
  categories: AccountCategoryDto[],
  previous: Record<string, string>,
  editingId: string | null,
): Record<string, string> => {
  const next = Object.fromEntries(
    categories.flatMap((category) => [
      [category.id, category.name],
      ...category.accounts.map((account) => [account.id, account.name]),
    ]),
  );
  if (editingId && previous[editingId] !== undefined) {
    next[editingId] = previous[editingId];
  }
  return next;
};

export const visibleAccountsForCategory = (
  accounts: AccountDto[],
  showArchived: boolean,
) =>
  showArchived ? accounts : accounts.filter((account) => !account.archivedAt);

const InlineMutationError = ({ message }: { message: string | undefined }) =>
  message ? (
    <div className="accounts-inline-error" role="alert">
      {message}
    </div>
  ) : null;

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
  const { locale, t } = useI18n();
  const { reload: reloadAccountScope } = useAccountScope();
  const [categories, setCategories] = useState<AccountCategoryDto[]>([]);
  const [newCategory, setNewCategory] = useState("");
  const [newAccounts, setNewAccounts] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationErrors, setMutationErrors] = useState<Record<string, string>>(
    {},
  );
  const editingRef = useRef<{ key: string; id: string } | null>(null);

  const load = useCallback(
    async (showInitialLoading = false) => {
      if (showInitialLoading) {
        setLoading(true);
        setLoadFailed(false);
      }
      setLoadError(null);
      try {
        const next = (await api.accounts.tree(true)).categories;
        setCategories(next);
        setNames((previous) =>
          mergeAccountNameDrafts(
            next,
            previous,
            editingRef.current?.id ?? null,
          ),
        );
        setLoadFailed(false);
        return true;
      } catch {
        setLoadError(t("accountsLoadError"));
        if (showInitialLoading) setLoadFailed(true);
        return false;
      } finally {
        if (showInitialLoading) setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const run = async (
    key: string,
    action: () => Promise<unknown>,
    relatedErrorKeys: string[] = [],
  ) => {
    setBusy(key);
    setMutationErrors((previous) => {
      const next = { ...previous };
      for (const errorKey of [key, ...relatedErrorKeys]) {
        delete next[errorKey];
      }
      return next;
    });
    try {
      await action();
      await load(false);
      await reloadAccountScope();
      return true;
    } catch (caught) {
      if (
        caught instanceof ApiClientError &&
        (caught.code === "account_conflict" ||
          caught.code === "category_conflict")
      ) {
        await load(false);
      }
      setMutationErrors((previous) => ({
        ...previous,
        [key]: t(accountsMutationMessageKey(caught)),
      }));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const beginEditing = (key: string, id: string, name: string) => {
    editingRef.current = { key, id };
    setEditingKey(key);
    setNames((previous) => ({ ...previous, [id]: name }));
  };

  const stopEditing = () => {
    editingRef.current = null;
    setEditingKey(null);
  };

  const createCategory = () => {
    if (!newCategory.trim() || busy !== null) return;
    void run("category-create", async () => {
      await api.accounts.createCategory({ name: newCategory });
      setNewCategory("");
    });
  };

  const hasArchivedItems = categories.some(
    (category) =>
      category.archivedAt !== null ||
      category.accounts.some((account) => account.archivedAt !== null),
  );
  const visibleCategories = showArchived
    ? categories
    : categories.filter((category) => category.archivedAt === null);

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

      {loadError && (
        <Banner
          status="error"
          title={loadError}
          endContent={
            <Button
              variant="ghost"
              label={t("retry")}
              isLoading={loading}
              onClick={() => void load(true)}
            />
          }
        />
      )}

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
                placeholder={t("newCategory")}
                value={newCategory}
                onChange={setNewCategory}
                onEnter={createCategory}
                isDisabled={loading || loadFailed || busy !== null}
                width="100%"
                size="sm"
              />
              <Button
                variant="primary"
                label={t("addCategory")}
                isLoading={busy === "category-create"}
                isDisabled={
                  loading || loadFailed || !newCategory.trim() || busy !== null
                }
                onClick={createCategory}
              />
            </div>
          </div>
        </Card>
        <InlineMutationError message={mutationErrors["category-create"]} />
      </section>

      {loading && <AccountsLoadingState label={t("loadingAccounts")} />}

      {!loading && !loadFailed && categories.length === 0 && (
        <Card padding={0}>
          <EmptyState
            headingLevel={2}
            title={t("noAccounts")}
            description={t("noAccountsDescription")}
          />
        </Card>
      )}

      {!loading && !loadFailed && categories.length > 0 && (
        <section
          className="accounts-category-section"
          aria-labelledby="accounts-categories-heading"
        >
          <VStack gap={3}>
            <div className="accounts-section-heading">
              <Heading level={2} id="accounts-categories-heading">
                {t("accountCategories")}
              </Heading>
              <div className="accounts-section-tools">
                <Text type="supporting" color="secondary">
                  {formatCategoryCount(visibleCategories.length, locale)}
                </Text>
                {hasArchivedItems && (
                  <Button
                    variant="ghost"
                    size="sm"
                    label={showArchived ? t("hideArchived") : t("showArchived")}
                    aria-pressed={showArchived}
                    isDisabled={editingKey !== null || busy !== null}
                    onClick={() => setShowArchived((current) => !current)}
                  />
                )}
              </div>
            </div>

            {visibleCategories.map((category) => {
              const categoryName = names[category.id] ?? category.name;
              const categoryEditKey = `category-edit-${category.id}`;
              const isEditingCategory = editingKey === categoryEditKey;
              const visibleAccounts = visibleAccountsForCategory(
                category.accounts,
                showArchived,
              );
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
                          {formatAccountCount(visibleAccounts.length, locale)}
                        </Text>
                      </VStack>
                    </div>

                    {isEditingCategory ? (
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
                          isDisabled={busy !== null}
                        />
                        <HStack gap={1} wrap="nowrap" align="end">
                          <Button
                            variant="secondary"
                            size="sm"
                            label={`${t("save")} ${category.name}`}
                            isDisabled={
                              busy !== null ||
                              !categoryName.trim() ||
                              categoryName === category.name
                            }
                            isLoading={busy === `category-${category.id}`}
                            onClick={() =>
                              void run(
                                `category-${category.id}`,
                                () =>
                                  api.accounts.updateCategory(
                                    category.id,
                                    { name: categoryName },
                                    category.revision,
                                  ),
                                [`category-archive-${category.id}`],
                              ).then((saved) => {
                                if (saved) stopEditing();
                              })
                            }
                          >
                            {t("save")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            label={`${t("cancel")} ${category.name}`}
                            isDisabled={busy !== null}
                            onClick={() => {
                              setNames((previous) => ({
                                ...previous,
                                [category.id]: category.name,
                              }));
                              stopEditing();
                            }}
                          >
                            {t("cancel")}
                          </Button>
                        </HStack>
                      </div>
                    ) : (
                      <HStack
                        gap={1}
                        wrap="nowrap"
                        justify="end"
                        className="accounts-category-actions"
                      >
                        {!category.archivedAt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            label={`${t("rename")} ${category.name}`}
                            isDisabled={editingKey !== null || busy !== null}
                            onClick={() =>
                              beginEditing(
                                categoryEditKey,
                                category.id,
                                category.name,
                              )
                            }
                          >
                            {t("rename")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          label={`${
                            category.archivedAt ? t("restore") : t("archive")
                          } ${category.name}`}
                          {...(!category.archivedAt && !canArchiveCategory
                            ? { tooltip: t("archiveCategoryHint") }
                            : {})}
                          isDisabled={
                            busy !== null ||
                            (!category.archivedAt && !canArchiveCategory)
                          }
                          onClick={() =>
                            void run(
                              `category-archive-${category.id}`,
                              () =>
                                api.accounts.updateCategory(
                                  category.id,
                                  { archived: category.archivedAt === null },
                                  category.revision,
                                ),
                              [`category-${category.id}`],
                            )
                          }
                        >
                          {category.archivedAt ? t("restore") : t("archive")}
                        </Button>
                      </HStack>
                    )}

                    <InlineMutationError
                      message={
                        mutationErrors[`category-${category.id}`] ??
                        mutationErrors[`category-archive-${category.id}`]
                      }
                    />
                  </div>

                  <div className="accounts-category-body">
                    <div className="accounts-list-heading">
                      <Heading level={4}>{t("accounts")}</Heading>
                      <Text type="supporting" color="secondary">
                        {category.archivedAt
                          ? t("restoreCategoryFirst")
                          : t("accountsInCategoryDescription")}
                      </Text>
                    </div>

                    {visibleAccounts.length === 0 && (
                      <div className="accounts-category-empty">
                        <Text as="p" type="supporting" color="secondary">
                          {showArchived
                            ? t("noAccountsInCategory")
                            : t("noActiveAccountsInCategory")}
                        </Text>
                      </div>
                    )}

                    {visibleAccounts.length > 0 && (
                      <div className="accounts-account-list">
                        {visibleAccounts.map((account) => {
                          const accountName = names[account.id] ?? account.name;
                          const accountEditKey = `account-edit-${account.id}`;
                          const isEditingAccount =
                            editingKey === accountEditKey;
                          return (
                            <div
                              className={`accounts-account-row${
                                isEditingAccount ? " is-editing" : ""
                              }${category.archivedAt ? " is-read-only" : ""}`}
                              key={account.id}
                            >
                              {isEditingAccount ? (
                                <TextInput
                                  label={t("accountName")}
                                  value={accountName}
                                  onChange={(value) =>
                                    setNames((previous) => ({
                                      ...previous,
                                      [account.id]: value,
                                    }))
                                  }
                                  width="100%"
                                  size="sm"
                                  isDisabled={busy !== null}
                                />
                              ) : (
                                <Text weight="medium">{account.name}</Text>
                              )}
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
                              {!category.archivedAt && (
                                <HStack
                                  gap={1}
                                  wrap="nowrap"
                                  justify="end"
                                  className="accounts-account-actions"
                                >
                                  {isEditingAccount ? (
                                    <>
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        label={`${t("save")} ${account.name}`}
                                        isDisabled={
                                          busy !== null ||
                                          !accountName.trim() ||
                                          accountName === account.name
                                        }
                                        isLoading={
                                          busy === `account-${account.id}`
                                        }
                                        onClick={() =>
                                          void run(
                                            `account-${account.id}`,
                                            () =>
                                              api.accounts.updateAccount(
                                                account.id,
                                                { name: accountName },
                                                account.revision,
                                              ),
                                            [`account-archive-${account.id}`],
                                          ).then((saved) => {
                                            if (saved) stopEditing();
                                          })
                                        }
                                      >
                                        {t("save")}
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        label={`${t("cancel")} ${account.name}`}
                                        isDisabled={busy !== null}
                                        onClick={() => {
                                          setNames((previous) => ({
                                            ...previous,
                                            [account.id]: account.name,
                                          }));
                                          stopEditing();
                                        }}
                                      >
                                        {t("cancel")}
                                      </Button>
                                    </>
                                  ) : (
                                    <>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        label={`${t("rename")} ${account.name}`}
                                        isDisabled={
                                          editingKey !== null || busy !== null
                                        }
                                        onClick={() =>
                                          beginEditing(
                                            accountEditKey,
                                            account.id,
                                            account.name,
                                          )
                                        }
                                      >
                                        {t("rename")}
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        label={`${
                                          account.archivedAt
                                            ? t("restore")
                                            : t("archive")
                                        } ${account.name}`}
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
                                            [`account-${account.id}`],
                                          )
                                        }
                                      >
                                        {account.archivedAt
                                          ? t("restore")
                                          : t("archive")}
                                      </Button>
                                    </>
                                  )}
                                </HStack>
                              )}
                              <InlineMutationError
                                message={
                                  mutationErrors[`account-${account.id}`] ??
                                  mutationErrors[
                                    `account-archive-${account.id}`
                                  ]
                                }
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {!category.archivedAt && (
                      <VStack gap={1}>
                        <div className="accounts-add-account-row">
                          <TextInput
                            label={t("newAccount")}
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
                            isDisabled={busy !== null}
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
                        <InlineMutationError
                          message={
                            mutationErrors[`account-create-${category.id}`]
                          }
                        />
                      </VStack>
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
