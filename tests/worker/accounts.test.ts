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
          categoryId: "account-category-uncategorized",
        }),
      ],
    });
    expect((await accounts.structure()).revision).toBe(0);
  });

  it("creates categories/accounts and resolves all three scope forms", async () => {
    const service = new AccountService(repository(), () => "generated-id");
    const category = await service.createCategory({ name: " TFSA ", now });
    const accountOne = await service.createAccount({
      categoryId: category.id,
      name: "Account 1",
      now,
      id: "tfsa-1",
    });
    const accountTwo = await service.createAccount({
      categoryId: category.id,
      name: "Account 2",
      now,
      id: "tfsa-2",
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

    expect(all.accountIds).toEqual(
      expect.arrayContaining(["account-default", accountOne.id, accountTwo.id]),
    );
    expect(categoryScope.accountIds).toEqual([accountOne.id, accountTwo.id]);
    expect(accountScope.accountIds).toEqual([accountTwo.id]);
    expect(categoryScope.categoryName).toBe("TFSA");
    expect(accountScope.accountName).toBe("Account 2");
    expect(categoryScope.fingerprint).toContain(`category:${category.id}:`);
    expect(await service.structureRevision()).toBeGreaterThan(0);
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

  it("rejects writes to archived accounts while preserving the default fallback", async () => {
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
    await expect(
      env.DB.prepare(
        `INSERT INTO import_batches
         (id, file_digest, original_filename, account_id,
          base_position_basis_revision, status, expires_at, created_at, updated_at)
         VALUES ('archived-import', 'archived-digest', 'x.csv', ?1, 0,
                 'preview', ?2, ?2, ?2)`,
      )
        .bind(account.id, now)
        .run(),
    ).rejects.toThrow(/account_required/);

    await env.DB.prepare(
      `INSERT INTO import_batches
       (id, file_digest, original_filename, base_position_basis_revision,
        status, expires_at, created_at, updated_at)
       VALUES ('default-import', 'default-digest', 'x.csv', 0,
               'preview', ?1, ?1, ?1)`,
    )
      .bind(now)
      .run();
    const defaultAccount = await env.DB.prepare(
      "SELECT account_id FROM import_batches WHERE id = 'default-import'",
    ).first<{ account_id: string }>();
    expect(defaultAccount?.account_id).toBe("account-default");
  });
});
