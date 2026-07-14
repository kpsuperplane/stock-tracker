import { DecimalValue } from "../domain/decimal";

export interface AccountCategoryRecord {
  id: string;
  name: string;
  sortOrder: number;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountRecord {
  id: string;
  categoryId: string;
  name: string;
  nickname: string | null;
  owner: string;
  sortOrder: number;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCategoryTree extends AccountCategoryRecord {
  accounts: AccountRecord[];
}

export interface AccountStructureRecord {
  revision: number;
  updatedAt: string | null;
  lastMutationId: string | null;
}

interface AccountCategoryRow {
  id: string;
  name: string;
  sort_order: number;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountRow {
  id: string;
  category_id: string;
  name: string;
  nickname: string | null;
  owner: string;
  sort_order: number;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountStructureRow {
  revision: number;
  updated_at: string | null;
  last_mutation_id: string | null;
}

interface TransactionPositionRow {
  instrument_id: string;
  side: "buy" | "sell";
  quantity_decimal: string;
}

const mapCategory = (row: AccountCategoryRow): AccountCategoryRecord => ({
  id: row.id,
  name: row.name,
  sortOrder: row.sort_order,
  revision: row.revision,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAccount = (row: AccountRow): AccountRecord => ({
  id: row.id,
  categoryId: row.category_id,
  name: row.name,
  nickname: row.nickname,
  owner: row.owner,
  sortOrder: row.sort_order,
  revision: row.revision,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const categorySelect = `
  SELECT id, name, sort_order, revision, archived_at, created_at, updated_at
    FROM account_categories`;

const accountSelect = `
  SELECT id, category_id, name, nickname, owner, sort_order, revision, archived_at,
         created_at, updated_at
    FROM accounts`;

export interface InsertAccountCategory {
  id: string;
  name: string;
  sortOrder: number;
  now: string;
}

export interface UpdateAccountCategory {
  id: string;
  name: string;
  sortOrder: number;
  archivedAt: string | null;
  expectedRevision: number;
  now: string;
}

export interface InsertAccount {
  id: string;
  categoryId: string;
  name: string;
  nickname?: string | null;
  owner?: string;
  sortOrder: number;
  now: string;
}

export interface UpdateAccount {
  id: string;
  categoryId: string;
  name: string;
  nickname: string | null;
  owner: string;
  sortOrder: number;
  archivedAt: string | null;
  expectedRevision: number;
  now: string;
}

export class AccountRepository {
  constructor(private readonly db: D1Database) {}

  async listCategories(
    options: { includeArchived?: boolean } = {},
  ): Promise<AccountCategoryRecord[]> {
    const result = await this.db
      .prepare(
        `${categorySelect}
         WHERE (?1 = 1 OR archived_at IS NULL)
         ORDER BY sort_order, lower(name), id`,
      )
      .bind(options.includeArchived === true ? 1 : 0)
      .all<AccountCategoryRow>();
    return result.results.map(mapCategory);
  }

  async listAccounts(
    options: { categoryId?: string; includeArchived?: boolean } = {},
  ): Promise<AccountRecord[]> {
    const result = await this.db
      .prepare(
        `${accountSelect}
         WHERE (?1 = 1 OR archived_at IS NULL)
           AND (?2 IS NULL OR category_id = ?2)
         ORDER BY category_id, sort_order, lower(name), id`,
      )
      .bind(
        options.includeArchived === true ? 1 : 0,
        options.categoryId ?? null,
      )
      .all<AccountRow>();
    return result.results.map(mapAccount);
  }

  async listTree(
    options: { includeArchived?: boolean } = {},
  ): Promise<AccountCategoryTree[]> {
    const [categories, accounts] = await Promise.all([
      this.listCategories(options),
      this.listAccounts(options),
    ]);
    const accountsByCategory = new Map<string, AccountRecord[]>();
    for (const account of accounts) {
      const list = accountsByCategory.get(account.categoryId) ?? [];
      list.push(account);
      accountsByCategory.set(account.categoryId, list);
    }
    return categories.map((category) => ({
      ...category,
      accounts: accountsByCategory.get(category.id) ?? [],
    }));
  }

  async findCategory(id: string): Promise<AccountCategoryRecord | null> {
    const row = await this.db
      .prepare(`${categorySelect} WHERE id = ?1`)
      .bind(id)
      .first<AccountCategoryRow>();
    return row ? mapCategory(row) : null;
  }

  async findAccount(id: string): Promise<AccountRecord | null> {
    const row = await this.db
      .prepare(`${accountSelect} WHERE id = ?1`)
      .bind(id)
      .first<AccountRow>();
    return row ? mapAccount(row) : null;
  }

  async insertCategory(input: InsertAccountCategory): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO account_categories
         (id, name, sort_order, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
      )
      .bind(input.id, input.name, input.sortOrder, input.now)
      .run();
  }

  async insertAccount(input: InsertAccount): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO accounts
         (id, category_id, name, nickname, owner, sort_order, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`,
      )
      .bind(
        input.id,
        input.categoryId,
        input.name,
        input.nickname ?? null,
        input.owner ?? "",
        input.sortOrder,
        input.now,
      )
      .run();
  }

  async updateCategory(input: UpdateAccountCategory): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE account_categories
            SET name = ?1, sort_order = ?2, archived_at = ?3,
                revision = revision + 1, updated_at = ?4
          WHERE id = ?5 AND revision = ?6`,
      )
      .bind(
        input.name,
        input.sortOrder,
        input.archivedAt,
        input.now,
        input.id,
        input.expectedRevision,
      )
      .run();
    // D1 reports trigger side effects in some runtimes; a successful guarded
    // update therefore may have more than one changed row (the structure
    // revision trigger updates its singleton row too).
    return result.meta.changes > 0;
  }

  async updateAccount(input: UpdateAccount): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE accounts
            SET category_id = ?1, name = ?2, nickname = ?3, owner = ?4,
                sort_order = ?5, archived_at = ?6,
                revision = revision + 1, updated_at = ?7
          WHERE id = ?8 AND revision = ?9`,
      )
      .bind(
        input.categoryId,
        input.name,
        input.nickname,
        input.owner,
        input.sortOrder,
        input.archivedAt,
        input.now,
        input.id,
        input.expectedRevision,
      )
      .run();
    return result.meta.changes > 0;
  }

  async deleteCategory(id: string, expectedRevision: number): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM account_categories WHERE id = ?1 AND revision = ?2")
      .bind(id, expectedRevision)
      .run();
    return result.meta.changes === 1;
  }

  async deleteAccount(id: string, expectedRevision: number): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM accounts WHERE id = ?1 AND revision = ?2")
      .bind(id, expectedRevision)
      .run();
    return result.meta.changes === 1;
  }

  async structure(): Promise<AccountStructureRecord> {
    const row = await this.db
      .prepare(
        `SELECT revision, updated_at, last_mutation_id
           FROM account_structure_state WHERE id = 1`,
      )
      .first<AccountStructureRow>();
    return {
      revision: row?.revision ?? 0,
      updatedAt: row?.updated_at ?? null,
      lastMutationId: row?.last_mutation_id ?? null,
    };
  }

  async accountIdsForCategory(
    categoryId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT id FROM accounts
          WHERE category_id = ?1 AND (?2 = 1 OR archived_at IS NULL)
          ORDER BY sort_order, lower(name), id`,
      )
      .bind(categoryId, options.includeArchived === true ? 1 : 0)
      .all<{ id: string }>();
    return result.results.map((row) => row.id);
  }

  async accountIdsForOwner(
    owner: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT id FROM accounts
          WHERE owner = ?1 AND (?2 = 1 OR archived_at IS NULL)
          ORDER BY category_id, sort_order, lower(name), id`,
      )
      .bind(owner, options.includeArchived === true ? 1 : 0)
      .all<{ id: string }>();
    return result.results.map((row) => row.id);
  }

  async hasTransactions(accountId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS present FROM transactions WHERE account_id = ?1 LIMIT 1",
      )
      .bind(accountId)
      .first<{ present: number }>();
    return row?.present === 1;
  }

  /**
   * Returns whether an account has a positive current ledger balance.  A
   * split cannot turn a zero/non-positive transaction balance into a positive
   * one, so the exact transaction fold is sufficient for archive protection;
   * the ledger service remains responsible for full split-aware validation.
   */
  async hasPositiveTransactionBalance(accountId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `SELECT instrument_id, side, quantity_decimal
           FROM transactions
          WHERE account_id = ?1
          ORDER BY trade_date, id`,
      )
      .bind(accountId)
      .all<TransactionPositionRow>();
    const balances = new Map<string, DecimalValue>();
    for (const row of result.results) {
      let quantity: DecimalValue;
      try {
        quantity = DecimalValue.parse(row.quantity_decimal);
      } catch {
        continue;
      }
      const previous = balances.get(row.instrument_id) ?? DecimalValue.zero();
      balances.set(
        row.instrument_id,
        row.side === "buy"
          ? previous.add(quantity)
          : previous.subtract(quantity),
      );
    }
    return [...balances.values()].some((balance) => balance.isPositive());
  }
}
