import type {
  AccountCategoryRecord,
  AccountCategoryTree,
  AccountRecord,
  AccountRepository,
} from "../db/accounts";
import { ApiError } from "../worker/errors";

export type AccountScopeType = "all" | "owner" | "category" | "account";

export type AccountScope =
  | { scopeType: "all"; scopeId?: never }
  | { scopeType: "owner"; scopeId: string }
  | { scopeType: "category"; scopeId: string }
  | { scopeType: "account"; scopeId: string };

export interface ResolvedAccountScope {
  scopeType: AccountScopeType;
  scopeId: string | null;
  accountIds: string[];
  categoryId: string | null;
  categoryName: string | null;
  accountName: string | null;
  ownerName: string | null;
  structureRevision: number;
  fingerprint: string;
}

export interface AccountTreeDto extends AccountCategoryTree {}

export interface CreateCategoryInput {
  name: string;
  sortOrder?: number;
  id?: string;
  now?: string;
}

export interface UpdateCategoryInput {
  id: string;
  name?: string;
  sortOrder?: number;
  archived?: boolean;
  expectedRevision: number;
  now?: string;
}

export interface CreateAccountInput {
  categoryId: string;
  name: string;
  owner?: string;
  sortOrder?: number;
  id?: string;
  now?: string;
}

export interface UpdateAccountInput {
  id: string;
  categoryId?: string;
  name?: string;
  owner?: string;
  sortOrder?: number;
  archived?: boolean;
  expectedRevision: number;
  now?: string;
}

interface AccountRepositoryPort {
  listTree(options?: {
    includeArchived?: boolean;
  }): Promise<AccountCategoryTree[]>;
  listAccounts(options?: {
    categoryId?: string;
    includeArchived?: boolean;
  }): Promise<AccountRecord[]>;
  findCategory(id: string): Promise<AccountCategoryRecord | null>;
  findAccount(id: string): Promise<AccountRecord | null>;
  insertCategory(input: {
    id: string;
    name: string;
    sortOrder: number;
    now: string;
  }): Promise<void>;
  insertAccount(input: {
    id: string;
    categoryId: string;
    name: string;
    owner: string;
    sortOrder: number;
    now: string;
  }): Promise<void>;
  updateCategory(input: {
    id: string;
    name: string;
    sortOrder: number;
    archivedAt: string | null;
    expectedRevision: number;
    now: string;
  }): Promise<boolean>;
  updateAccount(input: {
    id: string;
    categoryId: string;
    name: string;
    owner: string;
    sortOrder: number;
    archivedAt: string | null;
    expectedRevision: number;
    now: string;
  }): Promise<boolean>;
  structure(): Promise<{
    revision: number;
    updatedAt: string | null;
    lastMutationId: string | null;
  }>;
  accountIdsForCategory(
    categoryId: string,
    options?: { includeArchived?: boolean },
  ): Promise<string[]>;
  accountIdsForOwner(
    owner: string,
    options?: { includeArchived?: boolean },
  ): Promise<string[]>;
  hasTransactions(accountId: string): Promise<boolean>;
  hasPositiveTransactionBalance(accountId: string): Promise<boolean>;
}

const DEFAULT_SORT_ORDER = 0;
const MAX_NAME_LENGTH = 120;

const timestamp = (now?: string): string => now ?? new Date().toISOString();

const normalizeName = (value: string, label: string): string => {
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new ApiError(
      422,
      "invalid_account_name",
      `${label} names must be between 1 and ${MAX_NAME_LENGTH} characters.`,
    );
  }
  return name;
};

const normalizeOwner = (value: string): string => {
  const owner = value.trim();
  if (owner.length > MAX_NAME_LENGTH) {
    throw new ApiError(
      422,
      "invalid_account_owner",
      `Owner names must be at most ${MAX_NAME_LENGTH} characters.`,
    );
  }
  return owner;
};

const normalizeSortOrder = (value: number | undefined): number => {
  const sortOrder = value ?? DEFAULT_SORT_ORDER;
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) {
    throw new ApiError(
      422,
      "invalid_account_sort_order",
      "Sort order must be a non-negative integer.",
    );
  }
  return sortOrder;
};

const isConstraintError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|unique|account_required|category_required/i.test(message);
};

const duplicateError = (label: string): ApiError =>
  new ApiError(
    409,
    "duplicate_account_name",
    `An active ${label} with that name already exists.`,
  );

/**
 * Account hierarchy and scope operations share one service so routes and
 * read-models cannot drift on archived-row or category membership semantics.
 */
export class AccountService {
  constructor(
    private readonly repository: AccountRepositoryPort,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async listTree(
    options: { includeArchived?: boolean } = {},
  ): Promise<AccountTreeDto[]> {
    return this.repository.listTree(options);
  }

  async structureRevision(): Promise<number> {
    return (await this.repository.structure()).revision;
  }

  async structure() {
    return this.repository.structure();
  }

  async createCategory(
    input: CreateCategoryInput,
  ): Promise<AccountCategoryRecord> {
    const name = normalizeName(input.name, "Category");
    const sortOrder = normalizeSortOrder(input.sortOrder);
    const row = {
      id: input.id ?? this.createId(),
      name,
      sortOrder,
      now: timestamp(input.now),
    };
    try {
      await this.repository.insertCategory(row);
    } catch (error) {
      if (isConstraintError(error)) throw duplicateError("category");
      throw error;
    }
    const created = await this.repository.findCategory(row.id);
    if (!created) throw new Error("account_category_create_lost");
    return created;
  }

  async updateCategory(
    input: UpdateCategoryInput,
  ): Promise<AccountCategoryRecord> {
    const existing = await this.repository.findCategory(input.id);
    if (!existing) {
      throw new ApiError(
        404,
        "account_category_not_found",
        "Category not found.",
      );
    }
    const name = normalizeName(input.name ?? existing.name, "Category");
    const sortOrder = normalizeSortOrder(input.sortOrder ?? existing.sortOrder);
    const archivedAt = input.archived
      ? timestamp(input.now)
      : input.archived === false
        ? null
        : existing.archivedAt;

    if (
      input.archived === true &&
      existing.id === "account-category-uncategorized"
    ) {
      throw new ApiError(
        409,
        "account_category_protected",
        "The compatibility category cannot be archived.",
      );
    }

    if (archivedAt !== null && input.archived === true) {
      const accounts = await this.repository.listAccounts({
        categoryId: existing.id,
        includeArchived: false,
      });
      if (accounts.length > 0) {
        throw new ApiError(
          409,
          "category_has_active_accounts",
          "Archive or move the active accounts before archiving this category.",
        );
      }
    }

    let updated: boolean;
    try {
      updated = await this.repository.updateCategory({
        id: existing.id,
        name,
        sortOrder,
        archivedAt,
        expectedRevision: input.expectedRevision,
        now: timestamp(input.now),
      });
    } catch (error) {
      if (isConstraintError(error)) throw duplicateError("category");
      throw error;
    }
    if (!updated)
      await this.assertRevision(
        existing.id,
        input.expectedRevision,
        "category",
      );
    const result = await this.repository.findCategory(existing.id);
    if (!result) throw new Error("account_category_update_lost");
    return result;
  }

  async archiveCategory(
    id: string,
    expectedRevision: number,
    now?: string,
  ): Promise<AccountCategoryRecord> {
    return this.updateCategory({
      id,
      archived: true,
      expectedRevision,
      ...(now === undefined ? {} : { now }),
    });
  }

  async createAccount(input: CreateAccountInput): Promise<AccountRecord> {
    const category = await this.repository.findCategory(input.categoryId);
    if (!category) {
      throw new ApiError(
        404,
        "account_category_not_found",
        "Category not found.",
      );
    }
    if (category.archivedAt !== null) {
      throw new ApiError(
        409,
        "category_archived",
        "Archived categories cannot receive new accounts.",
      );
    }
    const name = normalizeName(input.name, "Account");
    const owner = normalizeOwner(input.owner ?? "");
    const sortOrder = normalizeSortOrder(input.sortOrder);
    const row = {
      id: input.id ?? this.createId(),
      categoryId: input.categoryId,
      name,
      owner,
      sortOrder,
      now: timestamp(input.now),
    };
    try {
      await this.repository.insertAccount(row);
    } catch (error) {
      if (isConstraintError(error)) {
        if (
          /category/i.test(
            error instanceof Error ? error.message : String(error),
          )
        ) {
          throw new ApiError(
            409,
            "category_archived",
            "Category cannot receive this account.",
          );
        }
        throw duplicateError("account");
      }
      throw error;
    }
    const created = await this.repository.findAccount(row.id);
    if (!created) throw new Error("account_create_lost");
    return created;
  }

  async updateAccount(input: UpdateAccountInput): Promise<AccountRecord> {
    const existing = await this.repository.findAccount(input.id);
    if (!existing) {
      throw new ApiError(404, "account_not_found", "Account not found.");
    }
    const categoryId = input.categoryId ?? existing.categoryId;
    const category = await this.repository.findCategory(categoryId);
    if (!category) {
      throw new ApiError(
        404,
        "account_category_not_found",
        "Category not found.",
      );
    }
    const archivedAt = input.archived
      ? timestamp(input.now)
      : input.archived === false
        ? null
        : existing.archivedAt;
    if (input.archived === true && existing.id === "account-default") {
      throw new ApiError(
        409,
        "account_protected",
        "The compatibility account cannot be archived.",
      );
    }
    if (archivedAt === null && category.archivedAt !== null) {
      throw new ApiError(
        409,
        "category_archived",
        "An active account must belong to an active category.",
      );
    }
    if (
      categoryId !== existing.categoryId &&
      (await this.repository.hasTransactions(existing.id))
    ) {
      throw new ApiError(
        409,
        "account_category_locked",
        "An account with transaction history cannot move categories.",
      );
    }
    if (archivedAt !== null && input.archived === true) {
      if (await this.repository.hasPositiveTransactionBalance(existing.id)) {
        throw new ApiError(
          409,
          "account_has_current_holdings",
          "An account with current holdings cannot be archived.",
        );
      }
    }
    const name = normalizeName(input.name ?? existing.name, "Account");
    const owner = normalizeOwner(input.owner ?? existing.owner);
    const sortOrder = normalizeSortOrder(input.sortOrder ?? existing.sortOrder);
    let updated: boolean;
    try {
      updated = await this.repository.updateAccount({
        id: existing.id,
        categoryId,
        name,
        owner,
        sortOrder,
        archivedAt,
        expectedRevision: input.expectedRevision,
        now: timestamp(input.now),
      });
    } catch (error) {
      if (isConstraintError(error)) {
        if (
          /category/i.test(
            error instanceof Error ? error.message : String(error),
          )
        ) {
          throw new ApiError(
            409,
            "category_archived",
            "Category cannot contain this account.",
          );
        }
        throw duplicateError("account");
      }
      throw error;
    }
    if (!updated)
      await this.assertRevision(existing.id, input.expectedRevision, "account");
    const result = await this.repository.findAccount(existing.id);
    if (!result) throw new Error("account_update_lost");
    return result;
  }

  async archiveAccount(
    id: string,
    expectedRevision: number,
    now?: string,
  ): Promise<AccountRecord> {
    return this.updateAccount({
      id,
      archived: true,
      expectedRevision,
      ...(now === undefined ? {} : { now }),
    });
  }

  /** Resolve a global, owner, category, or account filter into stable IDs. */
  async resolveScope(
    scope: AccountScope,
    options: { includeArchived?: boolean } = {},
  ): Promise<ResolvedAccountScope> {
    const includeArchived = options.includeArchived !== false;
    const structureRevision = await this.structureRevision();
    if (scope.scopeType === "all") {
      const accounts = await this.repository.listAccounts({ includeArchived });
      return {
        scopeType: "all",
        scopeId: null,
        accountIds: accounts.map((account) => account.id),
        categoryId: null,
        categoryName: null,
        accountName: null,
        ownerName: null,
        structureRevision,
        fingerprint: `all:${structureRevision}`,
      };
    }

    if (scope.scopeType === "category") {
      const category = await this.repository.findCategory(scope.scopeId);
      if (!category) {
        throw new ApiError(
          404,
          "account_category_not_found",
          "Category not found.",
        );
      }
      if (!includeArchived && category.archivedAt !== null) {
        throw new ApiError(409, "category_archived", "Category is archived.");
      }
      const accountIds = await this.repository.accountIdsForCategory(
        category.id,
        {
          includeArchived,
        },
      );
      return {
        scopeType: "category",
        scopeId: category.id,
        accountIds,
        categoryId: category.id,
        categoryName: category.name,
        accountName: null,
        ownerName: null,
        structureRevision,
        fingerprint: `category:${category.id}:${structureRevision}`,
      };
    }

    if (scope.scopeType === "owner") {
      const owner = normalizeOwner(scope.scopeId);
      if (!owner) {
        throw new ApiError(422, "invalid_scope", "Choose an account owner.");
      }
      const accountIds = await this.repository.accountIdsForOwner(owner, {
        includeArchived,
      });
      if (accountIds.length === 0) {
        throw new ApiError(
          404,
          "account_owner_not_found",
          "Account owner not found.",
        );
      }
      return {
        scopeType: "owner",
        scopeId: owner,
        accountIds,
        categoryId: null,
        categoryName: null,
        accountName: null,
        ownerName: owner,
        structureRevision,
        fingerprint: `owner:${encodeURIComponent(owner)}:${structureRevision}`,
      };
    }

    const account = await this.repository.findAccount(scope.scopeId);
    if (!account) {
      throw new ApiError(404, "account_not_found", "Account not found.");
    }
    if (!includeArchived && account.archivedAt !== null) {
      throw new ApiError(409, "account_archived", "Account is archived.");
    }
    const category = await this.repository.findCategory(account.categoryId);
    return {
      scopeType: "account",
      scopeId: account.id,
      accountIds: [account.id],
      categoryId: account.categoryId,
      categoryName: category?.name ?? null,
      accountName: account.name,
      ownerName: account.owner || null,
      structureRevision,
      fingerprint: `account:${account.id}:${structureRevision}`,
    };
  }

  async resolveAccountIds(
    scope: AccountScope,
    options: { includeArchived?: boolean } = {},
  ): Promise<string[]> {
    return (await this.resolveScope(scope, options)).accountIds;
  }

  private async assertRevision(
    id: string,
    expectedRevision: number,
    label: "account" | "category",
  ): Promise<never> {
    const current =
      label === "account"
        ? await this.repository.findAccount(id)
        : await this.repository.findCategory(id);
    if (!current) {
      throw new ApiError(
        404,
        label === "account"
          ? "account_not_found"
          : "account_category_not_found",
        `${label === "account" ? "Account" : "Category"} not found.`,
      );
    }
    throw new ApiError(
      409,
      "account_revision_conflict",
      `The ${label} changed since it was loaded (expected revision ${expectedRevision}, current revision ${current.revision}).`,
    );
  }
}

export type { AccountRepository };
