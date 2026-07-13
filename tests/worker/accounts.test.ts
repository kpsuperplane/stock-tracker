import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AccountRepository } from "../../src/db/accounts";
import { AccountService } from "../../src/services/accounts";

const now = "2026-07-12T12:00:00.000Z";

const repository = () => new AccountRepository(env.DB);

describe("accounts and categories", () => {
  it("seeds the compatibility account and exposes a stable tree", async () => {
    const accounts = repository();
    const tree = await accounts.listTree();
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      id: "account-category-uncategorized",
      name: "Uncategorized",
      accounts: [
        expect.objectContaining({
          id: "account-default",
          name: "Default Account",
          owner: "",
          categoryId: "account-category-uncategorized",
        }),
      ],
    });
    expect((await accounts.structure()).revision).toBe(0);
  });

  it("creates categories/accounts and resolves account, category, and exact owner scopes", async () => {
    const service = new AccountService(repository(), () => "generated-id");
    const category = await service.createCategory({ name: " TFSA ", now });
    const secondCategory = await service.createCategory({
      name: "Taxable",
      id: "taxable-category",
      now,
    });
    const accountOne = await service.createAccount({
      categoryId: category.id,
      name: "Account 1",
      owner: " Kevin ",
      now,
      id: "tfsa-1",
    });
    const accountTwo = await service.createAccount({
      categoryId: category.id,
      name: "Account 2",
      owner: "kevin",
      now,
      id: "tfsa-2",
    });
    const accountThree = await service.createAccount({
      categoryId: secondCategory.id,
      name: "Account 3",
      owner: "Kevin",
      now,
      id: "taxable-1",
    });

    const all = await service.resolveScope({ scopeType: "all" });
    const categoryScope = await service.resolveScope({
      scopeType: "category",
      scopeId: category.id,
    });
    const accountScope = await service.resolveScope({
      scopeType: "account",
      scopeId: accountTwo.id,
    });
    const ownerScope = await service.resolveScope({
      scopeType: "owner",
      scopeId: "Kevin",
    });

    expect(all.accountIds).toEqual(
      expect.arrayContaining([
        "account-default",
        accountOne.id,
        accountTwo.id,
        accountThree.id,
      ]),
    );
    expect(categoryScope.accountIds).toEqual([accountOne.id, accountTwo.id]);
    expect(accountScope.accountIds).toEqual([accountTwo.id]);
    expect(ownerScope.accountIds).toEqual([accountOne.id, accountThree.id]);
    expect(accountOne.owner).toBe("Kevin");
    expect(accountTwo.owner).toBe("kevin");
    expect(ownerScope.ownerName).toBe("Kevin");
    expect(categoryScope.categoryName).toBe("TFSA");
    expect(accountScope.accountName).toBe("Account 2");
    expect(categoryScope.fingerprint).toContain(`category:${category.id}:`);
    expect(await service.structureRevision()).toBeGreaterThan(0);
  });

  it("stores a non-null owner and tracks direct owner changes in structure state", async () => {
    const ownerColumn = await env.DB.prepare(
      "PRAGMA table_info(accounts)",
    ).all<{ name: string; notnull: number; dflt_value: string | null }>();
    expect(
      ownerColumn.results.find(({ name }) => name === "owner"),
    ).toMatchObject({ notnull: 1, dflt_value: "''" });
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toContain(
      "accounts_owner_idx",
    );

    await expect(
      env.DB.prepare(
        "UPDATE accounts SET owner = NULL WHERE id = 'account-default'",
      ).run(),
    ).rejects.toThrow(/NOT NULL|constraint/i);
    await expect(
      env.DB.prepare(
        "UPDATE accounts SET owner = ?1 WHERE id = 'account-default'",
      )
        .bind("x".repeat(121))
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);

    await env.DB.prepare(
      "UPDATE accounts SET owner = 'Kevin' WHERE id = 'account-default'",
    ).run();
    expect((await repository().findAccount("account-default"))?.owner).toBe(
      "Kevin",
    );
    expect((await repository().structure()).revision).toBe(1);
  });

  it("keeps archived accounts in owner scopes unless active-only resolution is requested", async () => {
    const service = new AccountService(repository(), () => "generated-id");
    const category = await service.createCategory({
      name: "Archive Owner",
      now,
    });
    const account = await service.createAccount({
      categoryId: category.id,
      name: "Closed",
      owner: "Pat",
      id: "owner-archive-account",
      now,
    });
    await service.archiveAccount(account.id, account.revision, now);

    expect(
      (await service.resolveScope({ scopeType: "owner", scopeId: "Pat" }))
        .accountIds,
    ).toEqual([account.id]);
    await expect(
      service.resolveScope(
        { scopeType: "owner", scopeId: "Pat" },
        { includeArchived: false },
      ),
    ).rejects.toMatchObject({ code: "account_owner_not_found", status: 404 });
  });

  it("uses row revisions to reject stale edits", async () => {
    const service = new AccountService(repository(), () => "generated-id");
    const category = await service.createCategory({ name: "RRSP", now });
    const updated = await service.updateCategory({
      id: category.id,
      name: "RRSP Updated",
      expectedRevision: category.revision,
      now,
    });
    expect(updated.revision).toBe(category.revision + 1);
    await expect(
      service.updateCategory({
        id: category.id,
        name: "stale",
        expectedRevision: category.revision,
        now,
      }),
    ).rejects.toMatchObject({ code: "account_revision_conflict", status: 409 });
  });

  it("prevents category moves after history and archive with holdings", async () => {
    const service = new AccountService(repository(), () => "generated-id");
    const first = await service.createCategory({
      name: "History",
      id: "history-category",
      now,
    });
    const second = await service.createCategory({
      name: "Other",
      id: "other-category",
      now,
    });
    const account = await service.createAccount({
      categoryId: first.id,
      name: "Brokerage",
      id: "brokerage",
      now,
    });
    await env.DB.prepare(
      `INSERT INTO instruments
       (id, symbol, company_name, exchange, currency, instrument_type,
        provider, provider_symbol, created_at, updated_at)
       VALUES ('accounts-test-instrument', 'ACCT', 'Accounts Test', 'TSX', 'CAD',
               'stock', 'yahoo', 'ACCT', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO transactions
       (id, instrument_id, account_id, trade_date, side, quantity_decimal,
        price_decimal, revision, created_at, updated_at)
       VALUES ('accounts-test-tx', 'accounts-test-instrument', ?1,
               '2026-07-01', 'buy', '2', '100', 1, ?2, ?2)`,
    )
      .bind(account.id, now)
      .run();

    await expect(
      service.updateAccount({
        id: account.id,
        categoryId: second.id,
        expectedRevision: account.revision,
        now,
      }),
    ).rejects.toMatchObject({ code: "account_category_locked", status: 409 });
    await expect(
      service.archiveAccount(account.id, account.revision, now),
    ).rejects.toMatchObject({
      code: "account_has_current_holdings",
      status: 409,
    });
  });

  it("rejects staged import rows assigned to archived accounts", async () => {
    const service = new AccountService(repository(), () => "generated-id");
    const category = await service.createCategory({
      name: "Archive Test",
      now,
    });
    const account = await service.createAccount({
      categoryId: category.id,
      name: "Empty",
      id: "archive-test-account",
      now,
    });
    const archived = await service.archiveAccount(
      account.id,
      account.revision,
      now,
    );
    expect(archived.archivedAt).toBe(now);
    await env.DB.prepare(
      `INSERT INTO import_batches
       (id, file_digest, original_filename, base_position_basis_revision,
        status, expires_at, created_at, updated_at)
       VALUES ('archived-import', 'archived-digest', 'x.csv', 0,
               'preview', ?1, ?1, ?1)`,
    )
      .bind(now)
      .run();
    await expect(
      env.DB.prepare(
        `INSERT INTO import_rows
         (id, import_batch_id, row_number, symbol, account_id, category_name,
          account_name, status)
         VALUES ('archived-row', 'archived-import', 2, 'SHOP.TO', ?1,
                 'Archive Test', 'Empty', 'invalid')`,
      )
        .bind(account.id)
        .run(),
    ).rejects.toThrow(/account_required/);
  });
});
