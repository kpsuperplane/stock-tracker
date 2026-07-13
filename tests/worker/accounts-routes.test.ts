import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const headers = {
  Authorization: `Basic ${btoa("owner:password")}`,
  "Content-Type": "application/json",
  Host: "local",
  Origin: "http://local",
  "X-Stock-Tracker-Request": "1",
};

describe("account routes", () => {
  it("lists the seeded hierarchy and creates an account under a category", async () => {
    const listed = await exports.default.fetch(
      new Request("http://local/api/accounts", {
        headers: { Authorization: headers.Authorization },
      }),
    );
    expect(listed.status).toBe(200);
    const initial = await listed.json<{
      categories: Array<{ id: string; accounts: Array<{ id: string }> }>;
      structureRevision: number;
    }>();
    expect(initial.categories).toHaveLength(1);
    expect(initial.categories[0]?.accounts.map(({ id }) => id)).toEqual([
      "account-default",
    ]);
    expect(listed.headers.get("X-Account-Structure-Revision")).toBe(
      String(initial.structureRevision),
    );

    const categoryResponse = await exports.default.fetch(
      new Request("http://local/api/accounts/categories", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: " TFSA " }),
      }),
    );
    expect(categoryResponse.status).toBe(201);
    const category = await categoryResponse.json<{
      category: { id: string; name: string; revision: number };
    }>();
    expect(category.category.name).toBe("TFSA");

    const accountResponse = await exports.default.fetch(
      new Request("http://local/api/accounts/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          categoryId: category.category.id,
          name: " Account 1 ",
          owner: " Kevin ",
        }),
      }),
    );
    expect(accountResponse.status).toBe(201);
    const account = await accountResponse.json<{
      account: {
        id: string;
        name: string;
        owner: string;
        categoryId: string;
        revision: number;
      };
    }>();
    expect(account.account).toMatchObject({
      name: "Account 1",
      owner: "Kevin",
      categoryId: category.category.id,
      revision: 1,
    });

    const renamed = await exports.default.fetch(
      new Request(`http://local/api/accounts/accounts/${account.account.id}`, {
        method: "PATCH",
        headers: { ...headers, "If-Match": String(account.account.revision) },
        body: JSON.stringify({ name: "Account One", owner: "Pat" }),
      }),
    );
    expect(renamed.status).toBe(200);
    expect(
      (
        await renamed.json<{
          account: { name: string; owner: string; revision: number };
        }>()
      ).account,
    ).toEqual(
      expect.objectContaining({
        name: "Account One",
        owner: "Pat",
        revision: 2,
      }),
    );

    const cleared = await exports.default.fetch(
      new Request(`http://local/api/accounts/accounts/${account.account.id}`, {
        method: "PATCH",
        headers: { ...headers, "If-Match": "2" },
        body: JSON.stringify({ owner: "   " }),
      }),
    );
    expect(cleared.status).toBe(200);
    expect(
      (await cleared.json<{ account: { owner: string; revision: number } }>())
        .account,
    ).toEqual(expect.objectContaining({ owner: "", revision: 3 }));

    const nullable = await exports.default.fetch(
      new Request(`http://local/api/accounts/accounts/${account.account.id}`, {
        method: "PATCH",
        headers: { ...headers, "If-Match": "3" },
        body: JSON.stringify({ owner: null }),
      }),
    );
    expect(nullable.status).toBe(422);

    const stale = await exports.default.fetch(
      new Request(`http://local/api/accounts/accounts/${account.account.id}`, {
        method: "PATCH",
        headers: { ...headers, "If-Match": String(account.account.revision) },
        body: JSON.stringify({ name: "Stale" }),
      }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe(
      "account_conflict",
    );

    const finalTree = await exports.default.fetch(
      new Request("http://local/api/accounts", {
        headers: { Authorization: headers.Authorization },
      }),
    );
    const finalPayload = await finalTree.json<{
      categories: Array<{
        id: string;
        accounts: Array<{ id: string; name: string }>;
      }>;
    }>();
    const tfsa = finalPayload.categories.find(
      ({ id }) => id === category.category.id,
    );
    expect(tfsa?.accounts).toEqual([
      expect.objectContaining({ id: account.account.id, name: "Account One" }),
    ]);
  });

  it("requires same-origin application headers for account mutations", async () => {
    const response = await exports.default.fetch(
      new Request("http://local/api/accounts/categories", {
        method: "POST",
        headers: {
          Authorization: headers.Authorization,
          "Content-Type": "application/json",
          Host: "local",
          Origin: "https://attacker.example",
          "X-Stock-Tracker-Request": "1",
        },
        body: JSON.stringify({ name: "Rejected" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(
      (await response.json<{ error: { code: string } }>()).error.code,
    ).toBe("csrf_rejected");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM account_categories WHERE name = 'Rejected'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });
});
