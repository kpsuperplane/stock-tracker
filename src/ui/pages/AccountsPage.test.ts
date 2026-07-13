import { describe, expect, it } from "vitest";
import type { AccountCategoryDto, AccountDto } from "../../shared/contracts";
import { ApiClientError } from "../api";
import {
  accountsMutationMessageKey,
  mergeAccountNameDrafts,
  visibleAccountsForCategory,
} from "./AccountsPage";

const account = (
  id: string,
  name: string,
  archivedAt: string | null = null,
): AccountDto => ({
  id,
  categoryId: "category-1",
  name,
  sortOrder: 0,
  revision: 1,
  archivedAt,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
});

const category = (accounts: AccountDto[]): AccountCategoryDto => ({
  id: "category-1",
  name: "Registered",
  sortOrder: 0,
  revision: 1,
  archivedAt: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  accounts,
});

describe("AccountsPage state helpers", () => {
  it("preserves the active draft while refreshing unrelated records", () => {
    const refreshed = category([
      account("account-1", "TFSA from server"),
      account("account-2", "RRSP updated"),
    ]);

    expect(
      mergeAccountNameDrafts(
        [refreshed],
        { "account-1": "TFSA draft", "account-2": "Old RRSP" },
        "account-1",
      ),
    ).toMatchObject({
      "account-1": "TFSA draft",
      "account-2": "RRSP updated",
    });
  });

  it("hides archived accounts until the user asks to see them", () => {
    const active = account("account-1", "TFSA");
    const archived = account(
      "account-2",
      "Old margin",
      "2026-07-13T00:00:00.000Z",
    );

    expect(visibleAccountsForCategory([active, archived], false)).toEqual([
      active,
    ]);
    expect(visibleAccountsForCategory([active, archived], true)).toEqual([
      active,
      archived,
    ]);
  });

  it("maps account constraints to localized UI messages", () => {
    const error = new ApiClientError(
      "raw server copy",
      409,
      "account_has_holdings",
      {},
      new Headers(),
    );

    expect(accountsMutationMessageKey(error)).toBe("accountHasHoldings");
    expect(accountsMutationMessageKey(new Error("network"))).toBe(
      "accountsMutationError",
    );
  });
});
