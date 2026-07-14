interface ResolvedImportAccount {
  id: string;
  categoryName: string;
  accountName: string;
}

export const importChunks = <T>(values: readonly T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
};

export const parseImportSource = (value: string | null): string[] | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.length === 7 &&
      parsed.every((cell) => typeof cell === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
};

export const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const accountNameKey = (categoryName: string, accountName: string): string =>
  `${categoryName.trim().toLowerCase()}\u0000${accountName.trim().toLowerCase()}`;

/** Resolve all category/account names with one D1 read. */
export const accountsByName = async (
  db: D1Database,
  references: readonly { categoryName: string; accountName: string }[],
): Promise<Map<string, ResolvedImportAccount>> => {
  const requested = [
    ...new Map(
      references
        .filter(
          (entry) =>
            entry.categoryName.length >= 1 &&
            entry.categoryName.length <= 120 &&
            entry.accountName.length >= 1 &&
            entry.accountName.length <= 120,
        )
        .map((entry) => [
          accountNameKey(entry.categoryName, entry.accountName),
          entry,
        ]),
    ).values(),
  ];
  if (requested.length === 0) return new Map();
  const rows = await db
    .prepare(
      `SELECT accounts.id, accounts.name AS account_name,
              account_categories.name AS category_name
         FROM json_each(?1) requested
         JOIN account_categories
           ON lower(account_categories.name) =
              lower(json_extract(requested.value, '$.categoryName'))
         JOIN accounts
           ON accounts.category_id = account_categories.id
          AND lower(accounts.name) =
              lower(json_extract(requested.value, '$.accountName'))
        WHERE accounts.archived_at IS NULL
          AND account_categories.archived_at IS NULL`,
    )
    .bind(JSON.stringify(requested))
    .all<{ id: string; account_name: string; category_name: string }>();
  return new Map(
    rows.results.map(
      (row) =>
        [
          accountNameKey(row.category_name, row.account_name),
          {
            id: row.id,
            categoryName: row.category_name,
            accountName: row.account_name,
          },
        ] as const,
    ),
  );
};
