export interface AccountDisplayFields {
  name: string;
  nickname: string | null;
}

/** Returns the user-facing label without changing the bank-issued identity. */
export const accountDisplayName = (account: AccountDisplayFields): string =>
  account.nickname?.trim() || account.name;
