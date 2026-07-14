import {
  Badge,
  Button,
  HStack,
  Text,
  TextInput,
  VStack,
} from "@astryxdesign/core";
import { accountDisplayName } from "../../shared/account-display";
import type { AccountCategoryDto, AccountDto } from "../../shared/contracts";
import { api } from "../api";
import { useI18n } from "../i18n/I18nProvider";

export interface AccountDraft {
  name: string;
  nickname: string;
  owner: string;
}

export const emptyAccountDraft = (): AccountDraft => ({
  name: "",
  nickname: "",
  owner: "",
});

export const mergeAccountDrafts = (
  categories: AccountCategoryDto[],
  previous: Record<string, AccountDraft>,
  editingId: string | null,
): Record<string, AccountDraft> => {
  const next = Object.fromEntries(
    categories.flatMap((category) =>
      category.accounts.map((account) => [
        account.id,
        {
          name: account.name,
          nickname: account.nickname ?? "",
          owner: account.owner,
        },
      ]),
    ),
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

type RunMutation = (
  key: string,
  action: () => Promise<unknown>,
  relatedErrorKeys?: string[],
) => Promise<boolean>;

interface AccountRowsProps {
  category: AccountCategoryDto;
  accounts: AccountDto[];
  emptyMessage: string;
  drafts: Record<string, AccountDraft>;
  newDraft: AccountDraft;
  editingKey: string | null;
  busy: string | null;
  mutationErrors: Record<string, string>;
  onDraftChange: (accountId: string, draft: AccountDraft) => void;
  onNewDraftChange: (draft: AccountDraft) => void;
  onBeginEditing: (key: string, account: AccountDto) => void;
  onStopEditing: () => void;
  runMutation: RunMutation;
}

const InlineMutationError = ({ message }: { message: string | undefined }) =>
  message ? (
    <div className="accounts-inline-error" role="alert">
      {message}
    </div>
  ) : null;

export const AccountRows = ({
  category,
  accounts,
  emptyMessage,
  drafts,
  newDraft,
  editingKey,
  busy,
  mutationErrors,
  onDraftChange,
  onNewDraftChange,
  onBeginEditing,
  onStopEditing,
  runMutation,
}: AccountRowsProps) => {
  const { t } = useI18n();

  const createAccount = () => {
    if (!newDraft.name.trim() || busy !== null) return;
    void runMutation(`account-create-${category.id}`, async () => {
      await api.accounts.createAccount({
        categoryId: category.id,
        name: newDraft.name,
        nickname: newDraft.nickname,
        owner: newDraft.owner,
      });
      onNewDraftChange(emptyAccountDraft());
    });
  };

  return (
    <>
      {accounts.length === 0 && (
        <div className="accounts-category-empty">
          <Text as="p" type="supporting" color="secondary">
            {emptyMessage}
          </Text>
        </div>
      )}

      {accounts.length > 0 && (
        <div className="accounts-account-list">
          {accounts.map((account) => {
            const draft = drafts[account.id] ?? {
              name: account.name,
              nickname: account.nickname ?? "",
              owner: account.owner,
            };
            const displayName = accountDisplayName(account);
            const accountEditKey = `account-edit-${account.id}`;
            const isEditing = editingKey === accountEditKey;
            const hasChanges =
              draft.name.trim() !== account.name ||
              draft.nickname.trim() !== (account.nickname ?? "") ||
              draft.owner.trim() !== account.owner;

            return (
              <div
                className={`accounts-account-row${isEditing ? " is-editing" : ""}${category.archivedAt ? " is-read-only" : ""}`}
                key={account.id}
              >
                {isEditing ? (
                  <div className="accounts-account-edit-fields">
                    <TextInput
                      label={t("accountName")}
                      value={draft.name}
                      onChange={(name) =>
                        onDraftChange(account.id, { ...draft, name })
                      }
                      width="100%"
                      size="sm"
                      isDisabled={busy !== null}
                    />
                    <TextInput
                      label={t("nickname")}
                      isOptional
                      value={draft.nickname}
                      onChange={(nickname) =>
                        onDraftChange(account.id, { ...draft, nickname })
                      }
                      width="100%"
                      size="sm"
                      isDisabled={busy !== null}
                    />
                    <TextInput
                      label={t("owner")}
                      isOptional
                      value={draft.owner}
                      onChange={(owner) =>
                        onDraftChange(account.id, { ...draft, owner })
                      }
                      width="100%"
                      size="sm"
                      isDisabled={busy !== null}
                    />
                  </div>
                ) : (
                  <VStack gap={0.5} className="accounts-account-identity">
                    <Text weight="medium">{displayName}</Text>
                    <Text type="supporting" color="secondary">
                      {t("owner")}: {account.owner || t("noOwner")}
                    </Text>
                  </VStack>
                )}

                <div className="accounts-account-status">
                  <Badge
                    variant={account.archivedAt ? "neutral" : "success"}
                    label={account.archivedAt ? t("archived") : t("active")}
                  />
                </div>

                {!category.archivedAt && (
                  <HStack
                    gap={1}
                    wrap="nowrap"
                    justify="end"
                    className="accounts-account-actions"
                  >
                    {isEditing ? (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          label={`${t("save")} ${displayName}`}
                          isDisabled={
                            busy !== null || !draft.name.trim() || !hasChanges
                          }
                          isLoading={busy === `account-${account.id}`}
                          onClick={() =>
                            void runMutation(
                              `account-${account.id}`,
                              () =>
                                api.accounts.updateAccount(
                                  account.id,
                                  {
                                    name: draft.name,
                                    nickname: draft.nickname,
                                    owner: draft.owner,
                                  },
                                  account.revision,
                                ),
                              [`account-archive-${account.id}`],
                            ).then((saved) => {
                              if (saved) onStopEditing();
                            })
                          }
                        >
                          {t("save")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          label={`${t("cancel")} ${displayName}`}
                          isDisabled={busy !== null}
                          onClick={() => {
                            onDraftChange(account.id, {
                              name: account.name,
                              nickname: account.nickname ?? "",
                              owner: account.owner,
                            });
                            onStopEditing();
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
                          label={`${t("edit")} ${displayName}`}
                          isDisabled={editingKey !== null || busy !== null}
                          onClick={() =>
                            onBeginEditing(accountEditKey, account)
                          }
                        >
                          {t("edit")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          label={`${account.archivedAt ? t("restore") : t("archive")} ${displayName}`}
                          isDisabled={busy !== null}
                          onClick={() =>
                            void runMutation(
                              `account-archive-${account.id}`,
                              () =>
                                api.accounts.updateAccount(
                                  account.id,
                                  { archived: account.archivedAt === null },
                                  account.revision,
                                ),
                              [`account-${account.id}`],
                            )
                          }
                        >
                          {account.archivedAt ? t("restore") : t("archive")}
                        </Button>
                      </>
                    )}
                  </HStack>
                )}

                <InlineMutationError
                  message={
                    mutationErrors[`account-${account.id}`] ??
                    mutationErrors[`account-archive-${account.id}`]
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
              value={newDraft.name}
              onChange={(name) => onNewDraftChange({ ...newDraft, name })}
              onEnter={createAccount}
              width="100%"
              size="sm"
              isDisabled={busy !== null}
            />
            <TextInput
              label={t("nickname")}
              isOptional
              value={newDraft.nickname}
              onChange={(nickname) =>
                onNewDraftChange({ ...newDraft, nickname })
              }
              onEnter={createAccount}
              width="100%"
              size="sm"
              isDisabled={busy !== null}
            />
            <TextInput
              label={t("owner")}
              isOptional
              value={newDraft.owner}
              onChange={(owner) => onNewDraftChange({ ...newDraft, owner })}
              onEnter={createAccount}
              width="100%"
              size="sm"
              isDisabled={busy !== null}
            />
            <Button
              variant="secondary"
              size="sm"
              label={t("addAccount")}
              isDisabled={busy !== null || !newDraft.name.trim()}
              isLoading={busy === `account-create-${category.id}`}
              onClick={createAccount}
            />
          </div>
          <InlineMutationError
            message={mutationErrors[`account-create-${category.id}`]}
          />
        </VStack>
      )}
    </>
  );
};
