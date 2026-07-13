import { describe, expect, it } from "vitest";
import type { AccountCategoryDto, AccountDto } from "../../shared/contracts";
import {
  accountOwnerNames,
  accountScopeExists,
  activeAccountsForScope,
  buildAccountScopeOptions,
  parseAccountScopeSelection,
} from "./scope";

const account = (
  id: string,
  categoryId: string,
  owner: string,
  archivedAt: string | null = null,
): AccountDto => ({
  id,
  categoryId,
  name: id,
  owner,
  sortOrder: 0,
  revision: 1,
  archivedAt,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
});

const categories: AccountCategoryDto[] = [
  {
    id: "registered",
    name: "Registered",
    sortOrder: 0,
    revision: 1,
    archivedAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    accounts: [
      account("tfsa", "registered", "Kevin"),
      account("rrsp", "registered", "kevin"),
    ],
  },
  {
    id: "taxable",
    name: "Taxable",
    sortOrder: 1,
    revision: 1,
    archivedAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    accounts: [
      account("margin", "taxable", "Kevin"),
      account("closed", "taxable", "Archived", "2026-07-13T00:00:00.000Z"),
      account("unowned", "taxable", ""),
    ],
  },
];

describe("account scope helpers", () => {
  it("keeps exact owner values distinct and excludes the empty owner", () => {
    expect(accountOwnerNames(categories)).toEqual([
      "Archived",
      "kevin",
      "Kevin",
    ]);
  });

  it("returns only active accounts within an owner or category scope", () => {
    expect(
      activeAccountsForScope(categories, {
        scopeType: "owner",
        scopeId: "Kevin",
      }).map(({ id }) => id),
    ).toEqual(["tfsa", "margin"]);
    expect(
      activeAccountsForScope(categories, {
        scopeType: "category",
        scopeId: "registered",
      }).map(({ id }) => id),
    ).toEqual(["tfsa", "rrsp"]);
    expect(
      activeAccountsForScope(categories, {
        scopeType: "owner",
        scopeId: "Archived",
      }),
    ).toEqual([]);
  });

  it("parses owner URLs and detects stale owner scopes", () => {
    expect(
      parseAccountScopeSelection("?scopeType=owner&scopeId=Kevin"),
    ).toEqual({ scopeType: "owner", scopeId: "Kevin" });
    expect(
      accountScopeExists(categories, {
        scopeType: "owner",
        scopeId: "Missing",
      }),
    ).toBe(false);
  });

  it("builds grouped options with unambiguous owner labels", () => {
    const options = buildAccountScopeOptions(categories, {
      allAccounts: "All accounts",
      owners: "Owners",
      owner: "Owner",
      categories: "Categories",
      category: "Category",
      accounts: "Accounts",
      account: "Account",
      archived: "Archived",
    });
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "section",
          title: "Owners",
          options: expect.arrayContaining([
            { value: "owner:Kevin", label: "Owner / Kevin" },
          ]),
        }),
      ]),
    );
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "section",
          title: "Accounts",
          options: expect.arrayContaining([
            {
              value: "account:tfsa",
              label: "Account / Registered / tfsa",
            },
          ]),
        }),
      ]),
    );
  });
});
