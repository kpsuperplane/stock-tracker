import type {
  CorporateActionRecord,
  CoverageRecord,
} from "../db/corporate-actions";
import type { InstrumentRecord } from "../db/instruments";
import type { ActiveSplit } from "../domain/holdings";
import type { SplitEventRange } from "../providers/corporate-actions";

export interface SnapshotConfirmation {
  requestedStartDate: string;
  requestedEndDate: string;
  providerRevision: string;
}

export interface SnapshotReview extends SnapshotConfirmation {
  instrumentId: string;
  symbol: string;
  provider: string;
  snapshot: SplitEventRange;
}

export const providerErrorCode = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : "provider_unavailable";
  return message.startsWith("provider_") ? message : "provider_unavailable";
};

export const coverageMatches = (
  coverage: CoverageRecord | null,
  snapshot: SplitEventRange,
): boolean =>
  coverage?.status === "confirmed" &&
  coverage.requestedStartDate === snapshot.range.requestedStartDate &&
  coverage.requestedEndDate === snapshot.range.requestedEndDate &&
  coverage.snapshotProviderRevision === snapshot.range.providerRevision &&
  coverage.confirmedStartDate === snapshot.range.requestedStartDate &&
  coverage.confirmedEndDate === snapshot.range.requestedEndDate &&
  coverage.confirmedProviderRevision === snapshot.range.providerRevision &&
  coverage.confirmedAt !== null;

export const confirmationMatches = (
  confirmation: SnapshotConfirmation | undefined,
  snapshot: SplitEventRange,
): boolean =>
  confirmation?.requestedStartDate === snapshot.range.requestedStartDate &&
  confirmation.requestedEndDate === snapshot.range.requestedEndDate &&
  confirmation.providerRevision === snapshot.range.providerRevision;

export const reviewFor = (
  instrument: InstrumentRecord,
  snapshot: SplitEventRange,
): SnapshotReview => ({
  instrumentId: instrument.id,
  symbol: instrument.symbol,
  requestedStartDate: snapshot.range.requestedStartDate,
  requestedEndDate: snapshot.range.requestedEndDate,
  provider: snapshot.range.provider,
  providerRevision: snapshot.range.providerRevision,
  snapshot,
});

export const toActiveSplit = (action: CorporateActionRecord): ActiveSplit => ({
  id: action.id,
  effectiveDate: action.effectiveDate,
  numerator: action.splitNumerator,
  denominator: action.splitDenominator,
});

export const proposedSplits = (
  actions: CorporateActionRecord[],
  snapshot: SplitEventRange,
): ActiveSplit[] => [
  ...actions
    .filter(
      (action) =>
        action.provider !== snapshot.range.provider ||
        action.effectiveDate < snapshot.range.requestedStartDate ||
        action.effectiveDate > snapshot.range.requestedEndDate,
    )
    .map(toActiveSplit),
  ...snapshot.events.map((event) => ({
    id: `${event.providerEventId}@${event.providerRevision}`,
    effectiveDate: event.effectiveDate,
    numerator: event.numerator,
    denominator: event.denominator,
  })),
];

export const snapshotChangesActions = (
  active: readonly CorporateActionRecord[],
  snapshot: SplitEventRange,
): boolean => {
  const activeInRange = active.filter(
    (action) =>
      action.provider === snapshot.range.provider &&
      action.effectiveDate >= snapshot.range.requestedStartDate &&
      action.effectiveDate <= snapshot.range.requestedEndDate,
  );
  const activeIdentities = new Map(
    activeInRange.map((action) => [
      `${action.providerEventId}@${action.providerRevision}`,
      action,
    ]),
  );
  if (activeInRange.length !== snapshot.events.length) return true;
  return snapshot.events.some((event) => {
    const activeAction = activeIdentities.get(
      `${event.providerEventId}@${event.providerRevision}`,
    );
    return (
      !activeAction ||
      activeAction.effectiveDate !== event.effectiveDate ||
      activeAction.splitNumerator !== event.numerator ||
      activeAction.splitDenominator !== event.denominator
    );
  });
};
