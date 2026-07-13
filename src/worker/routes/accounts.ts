import { Hono } from "hono";
import { z } from "zod";
import { AccountRepository } from "../../db/accounts";
import type { Env } from "../env";
import { ApiError } from "../errors";

const name = z.string().trim().min(1).max(120);
const owner = z.string().trim().max(120);
const sortOrder = z.number().int().min(0).max(1_000_000).optional();

const mapConstraint = (error: unknown): never => {
  const message = String(error);
  if (message.includes("account_categories_active_name_idx")) {
    throw new ApiError(
      409,
      "category_name_exists",
      "That category already exists.",
    );
  }
  if (message.includes("accounts_active_category_name_idx")) {
    throw new ApiError(
      409,
      "account_name_exists",
      "That account already exists in this category.",
    );
  }
  if (message.includes("category_required")) {
    throw new ApiError(422, "category_required", "Choose an active category.");
  }
  throw error;
};

const revision = (value: string | undefined): number => {
  if (!value || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new ApiError(
      428,
      "precondition_required",
      "Provide the current account revision.",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(422, "revision", "The account revision is invalid.");
  }
  return parsed;
};

const now = () => new Date().toISOString();

export const accountRoutes = new Hono<{ Bindings: Env }>();

accountRoutes.get("/", async (context) => {
  const includeArchived = context.req.query("includeArchived") === "true";
  const repository = new AccountRepository(context.env.DB);
  const [categories, structure] = await Promise.all([
    repository.listTree({ includeArchived }),
    repository.structure(),
  ]);
  context.header("X-Account-Structure-Revision", String(structure.revision));
  return context.json({ categories, structureRevision: structure.revision });
});

accountRoutes.post("/categories", async (context) => {
  const body = z
    .object({ name, sortOrder })
    .strict()
    .parse(await context.req.json());
  const id = crypto.randomUUID();
  try {
    await new AccountRepository(context.env.DB).insertCategory({
      id,
      name: body.name,
      sortOrder: body.sortOrder ?? 0,
      now: now(),
    });
  } catch (error) {
    mapConstraint(error);
  }
  const category = await new AccountRepository(context.env.DB).findCategory(id);
  return context.json({ category }, 201);
});

accountRoutes.patch("/categories/:id", async (context) => {
  const body = z
    .object({
      name: name.optional(),
      sortOrder,
      archived: z.boolean().optional(),
    })
    .strict()
    .parse(await context.req.json());
  const repository = new AccountRepository(context.env.DB);
  const existing = await repository.findCategory(context.req.param("id"));
  if (!existing)
    throw new ApiError(404, "category_not_found", "Category not found.");
  if (body.archived === true) {
    if (existing.id === "account-category-uncategorized") {
      throw new ApiError(
        409,
        "account_category_protected",
        "The compatibility category cannot be archived.",
      );
    }
    const activeAccounts = await repository.listAccounts({
      categoryId: existing.id,
      includeArchived: false,
    });
    if (activeAccounts.length > 0) {
      throw new ApiError(
        409,
        "category_has_accounts",
        "Archive its accounts before archiving the category.",
      );
    }
  }
  const changed = await repository.updateCategory({
    id: existing.id,
    name: body.name ?? existing.name,
    sortOrder: body.sortOrder ?? existing.sortOrder,
    archivedAt:
      body.archived === undefined
        ? existing.archivedAt
        : body.archived
          ? now()
          : null,
    expectedRevision: revision(context.req.header("If-Match")),
    now: now(),
  });
  if (!changed)
    throw new ApiError(
      409,
      "account_conflict",
      "The category changed. Reload and try again.",
    );
  return context.json({ category: await repository.findCategory(existing.id) });
});

accountRoutes.post("/accounts", async (context) => {
  const body = z
    .object({
      categoryId: z.string().min(1).max(128),
      name,
      owner: owner.optional(),
      sortOrder,
    })
    .strict()
    .parse(await context.req.json());
  const repository = new AccountRepository(context.env.DB);
  const category = await repository.findCategory(body.categoryId);
  if (!category || category.archivedAt !== null) {
    throw new ApiError(422, "category_required", "Choose an active category.");
  }
  const id = crypto.randomUUID();
  try {
    await repository.insertAccount({
      id,
      categoryId: body.categoryId,
      name: body.name,
      owner: body.owner ?? "",
      sortOrder: body.sortOrder ?? 0,
      now: now(),
    });
  } catch (error) {
    mapConstraint(error);
  }
  return context.json({ account: await repository.findAccount(id) }, 201);
});

accountRoutes.patch("/accounts/:id", async (context) => {
  const body = z
    .object({
      categoryId: z.string().min(1).max(128).optional(),
      name: name.optional(),
      owner: owner.optional(),
      sortOrder,
      archived: z.boolean().optional(),
    })
    .strict()
    .parse(await context.req.json());
  const repository = new AccountRepository(context.env.DB);
  const existing = await repository.findAccount(context.req.param("id"));
  if (!existing)
    throw new ApiError(404, "account_not_found", "Account not found.");
  const categoryId = body.categoryId ?? existing.categoryId;
  if (body.archived === true && existing.id === "account-default") {
    throw new ApiError(
      409,
      "account_protected",
      "The compatibility account cannot be archived.",
    );
  }
  if (
    categoryId !== existing.categoryId &&
    (await repository.hasTransactions(existing.id))
  ) {
    throw new ApiError(
      409,
      "account_category_locked",
      "An account with events cannot change category.",
    );
  }
  const category = await repository.findCategory(categoryId);
  if (!category || category.archivedAt !== null) {
    throw new ApiError(422, "category_required", "Choose an active category.");
  }
  if (
    body.archived === true &&
    (await repository.hasPositiveTransactionBalance(existing.id))
  ) {
    throw new ApiError(
      409,
      "account_has_holdings",
      "An account with current holdings cannot be archived.",
    );
  }
  const changed = await repository.updateAccount({
    id: existing.id,
    categoryId,
    name: body.name ?? existing.name,
    owner: body.owner ?? existing.owner,
    sortOrder: body.sortOrder ?? existing.sortOrder,
    archivedAt:
      body.archived === undefined
        ? existing.archivedAt
        : body.archived
          ? now()
          : null,
    expectedRevision: revision(context.req.header("If-Match")),
    now: now(),
  });
  if (!changed)
    throw new ApiError(
      409,
      "account_conflict",
      "The account changed. Reload and try again.",
    );
  return context.json({ account: await repository.findAccount(existing.id) });
});

accountRoutes.all("*", (context) => {
  context.header("Allow", "GET, POST, PATCH");
  throw new ApiError(
    405,
    "method_not_allowed",
    "This account method is not supported.",
  );
});
