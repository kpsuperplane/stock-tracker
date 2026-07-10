export type LedgerMutationKind =
  | "transaction_create"
  | "transaction_update"
  | "transaction_delete"
  | "import_commit"
  | "candidate_refresh"
  | "action_confirmation"
  | "action_invalidation"
  | "action_quarantine"
  | "action_promotion";

export class PositionBasisRepository {
  constructor(private readonly db: D1Database) {}

  async revision(): Promise<number> {
    const row = await this.db
      .prepare("SELECT revision FROM position_basis_state WHERE id = 1")
      .first<{ revision: number }>();
    if (!row) throw new Error("position_basis_state_missing");
    return row.revision;
  }

  mutationTokenStatement(input: {
    id: string;
    expectedRevision: number;
    kind: LedgerMutationKind;
    createdAt: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO ledger_mutations
         (id, expected_revision, resulting_revision, mutation_kind, created_at)
         VALUES (?1, ?2, ?2 + 1, ?3, ?4)`,
      )
      .bind(input.id, input.expectedRevision, input.kind, input.createdAt);
  }
}
