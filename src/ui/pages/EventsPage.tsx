import type { ISODateString } from "@astryxdesign/core";
import {
  Badge,
  Banner,
  Button,
  DateInput,
  Dialog,
  DialogHeader,
  FormLayout,
  Heading,
  HStack,
  Icon,
  Selector,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TextInput,
  useToast,
  VStack,
} from "@astryxdesign/core";
import { useCallback, useEffect, useState } from "react";
import type {
  EventsTimelineDto,
  SplitEventDto,
  TransactionEventDto,
} from "../../shared/contracts";
import {
  ApiClientError,
  type EventFilters,
  type EventImportsApiClient,
  type EventMutationResponse,
  type EventsApiClient,
  eventImportsApi,
  eventsApi,
  type ImportCommitResponse,
  type SplitSnapshotLike,
  type TransactionMutationInput,
} from "../api";
import { useI18n } from "../i18n/I18nProvider";
import { EventImportDialog } from "./EventImportDialog";

type TransactionInput = Required<Pick<TransactionMutationInput, "symbol">> &
  Omit<TransactionMutationInput, "symbol">;
type EditableTransactionInput = Omit<TransactionMutationInput, "symbol">;

type PendingMutation =
  | { kind: "create"; input: TransactionInput }
  | {
      kind: "update";
      id: string;
      eventRevision: number;
      input: EditableTransactionInput;
    }
  | {
      kind: "delete";
      id: string;
      eventRevision: number;
      confirmation?: TransactionMutationInput["confirmation"];
    };

type SplitReviewState = {
  symbol: string;
  snapshot: SplitSnapshotLike;
  pending: PendingMutation;
};

/**
 * A split confirmation can advance the position-basis revision before the
 * original mutation is retried. Keep that response revision explicit instead
 * of relying on a state update racing the follow-up request.
 */
export const resolveMutationBasisRevision = (
  currentRevision: number,
  confirmedRevision?: number,
): number => confirmedRevision ?? currentRevision;

export interface EventsPageProps {
  apiClient?: EventsApiClient;
  importApiClient?: EventImportsApiClient;
  initialTimeline?: EventsTimelineDto;
}

const asIsoDate = (value: string): ISODateString => value as ISODateString;

const DialogCloseButton = ({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => unknown;
}) => {
  const { t } = useI18n();
  return (
    <Button
      variant="ghost"
      label={t("close")}
      tooltip={t("close")}
      icon={<Icon icon="close" color="inherit" />}
      isIconOnly
      onClick={() => onOpenChange(false)}
    />
  );
};

const splitStatusVariant = (
  status: SplitEventDto["status"],
): "neutral" | "success" | "warning" | "error" => {
  switch (status) {
    case "active":
      return "success";
    case "candidate":
      return "warning";
    case "quarantined":
      return "error";
    default:
      return "neutral";
  }
};

const isSplitSnapshot = (value: unknown): value is SplitSnapshotLike => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SplitSnapshotLike>;
  return (
    typeof candidate.symbol === "string" &&
    typeof candidate.range === "object" &&
    candidate.range !== null &&
    typeof candidate.range.requestedStartDate === "string" &&
    typeof candidate.range.requestedEndDate === "string" &&
    typeof candidate.range.providerRevision === "string" &&
    Array.isArray(candidate.events)
  );
};

const errorCopyKey = (
  caught: unknown,
):
  | "providerUnavailable"
  | "negativeHoldings"
  | "instrumentNotFound"
  | "ledgerConflict"
  | "eventConflict"
  | "genericMutationError" => {
  if (!(caught instanceof ApiClientError)) return "genericMutationError";
  switch (caught.code) {
    case "provider_unavailable":
      return "providerUnavailable";
    case "negative_holdings":
      return "negativeHoldings";
    case "instrument_not_found":
      return "instrumentNotFound";
    case "ledger_conflict":
      return "ledgerConflict";
    case "event_conflict":
      return "eventConflict";
    default:
      return "genericMutationError";
  }
};

const eventLoadErrorMessage = (copy: string, caught: unknown): string => {
  if (caught instanceof ApiClientError) {
    return `${copy} (${caught.status}${caught.code ? `: ${caught.code}` : ""})`;
  }
  if (caught instanceof TypeError) return `${copy} (network error)`;
  return copy;
};

const TransactionDialog = ({
  isOpen,
  onOpenChange,
  transaction,
  onSave,
  isSaving,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  transaction: TransactionEventDto | null;
  onSave: (input: TransactionInput | EditableTransactionInput) => Promise<void>;
  isSaving: boolean;
}) => {
  const { t } = useI18n();
  const [symbol, setSymbol] = useState(transaction?.symbol ?? "");
  const [tradeDate, setTradeDate] = useState(transaction?.tradeDate ?? "");
  const [side, setSide] = useState<"buy" | "sell">(transaction?.side ?? "buy");
  const [quantityDecimal, setQuantityDecimal] = useState(
    transaction?.quantityDecimal ?? "",
  );
  const [priceDecimal, setPriceDecimal] = useState(
    transaction?.priceDecimal ?? "",
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = async () => {
    if ((!transaction && symbol.trim() === "") || tradeDate === "") {
      setValidationError(t("genericMutationError"));
      return;
    }
    if (quantityDecimal.trim() === "" || priceDecimal.trim() === "") {
      setValidationError(t("genericMutationError"));
      return;
    }
    setValidationError(null);
    const common = {
      tradeDate,
      side,
      quantityDecimal,
      priceDecimal,
    } as const;
    if (transaction) {
      await onSave(common);
    } else {
      await onSave({ ...common, symbol: symbol.trim() });
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      width="min(520px, calc(100vw - 2rem))"
      padding={4}
    >
      <DialogHeader
        title={transaction ? t("editTransaction") : t("addTransaction")}
        endContent={<DialogCloseButton onOpenChange={onOpenChange} />}
      />
      <VStack gap={4}>
        <FormLayout>
          {!transaction && (
            <TextInput
              label={t("transactionSymbol")}
              value={symbol}
              onChange={setSymbol}
              isRequired
              hasAutoFocus
            />
          )}
          <DateInput
            label={t("tradeDate")}
            placeholder={t("datePlaceholder")}
            {...(tradeDate ? { value: asIsoDate(tradeDate) } : {})}
            onChange={(next) => setTradeDate(next ?? "")}
            isRequired
          />
          <Selector
            label={t("transactionSide")}
            aria-label={t("transactionSide")}
            placeholder={t("selectPlaceholder")}
            options={[
              { value: "buy", label: t("buy") },
              { value: "sell", label: t("sell") },
            ]}
            value={side}
            onChange={(next) => setSide(next as "buy" | "sell")}
          />
          <TextInput
            label={t("quantityDecimal")}
            value={quantityDecimal}
            onChange={setQuantityDecimal}
            type="text"
            isRequired
          />
          <TextInput
            label={t("priceDecimal")}
            value={priceDecimal}
            onChange={setPriceDecimal}
            type="text"
            isRequired
          />
        </FormLayout>
        {validationError && <Banner status="error" title={validationError} />}
        <HStack gap={2} justify="end" wrap="wrap">
          <Button
            variant="ghost"
            label={t("cancel")}
            isDisabled={isSaving}
            onClick={() => onOpenChange(false)}
          />
          <Button
            variant="primary"
            label={isSaving ? t("save") : t("save")}
            isLoading={isSaving}
            isDisabled={isSaving}
            onClick={() => void submit()}
          />
        </HStack>
      </VStack>
    </Dialog>
  );
};

const SplitReviewDialog = ({
  state,
  isOpen,
  onOpenChange,
  onConfirm,
  isConfirming,
}: {
  state: SplitReviewState | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => unknown;
  onConfirm: () => void;
  isConfirming: boolean;
}) => {
  const { t } = useI18n();
  if (!state) return null;
  const { snapshot } = state;
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      width="min(680px, calc(100vw - 2rem))"
      maxHeight="90vh"
      padding={4}
    >
      <DialogHeader
        title={t("splitReviewTitle")}
        subtitle={t("splitReviewDescription")}
        endContent={<DialogCloseButton onOpenChange={onOpenChange} />}
      />
      <VStack gap={3}>
        <Banner
          status={snapshot.range.isComplete ? "info" : "warning"}
          title={`${snapshot.symbol} · ${t("requestedRange")}: ${snapshot.range.requestedStartDate} → ${snapshot.range.requestedEndDate}`}
          description={`${t("source")}: ${snapshot.range.provider} · ${t("providerRevision")}: ${snapshot.range.providerRevision}`}
        />
        {!snapshot.range.isComplete && (
          <Banner status="warning" title={t("splitReviewIncomplete")} />
        )}
        {snapshot.events.length === 0 ? (
          <div>{t("splitReviewNoEvents")}</div>
        ) : (
          <Table
            tableProps={{ className: "product-split-table" }}
            density="compact"
            dividers="rows"
            aria-label={t("splitReviewTitle")}
          >
            <TableHeader>
              <TableRow isHeaderRow>
                <TableHeaderCell>{t("date")}</TableHeaderCell>
                <TableHeaderCell>{t("splitRatio")}</TableHeaderCell>
                <TableHeaderCell>{t("source")}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.events.map((event) => (
                <TableRow
                  key={`${event.providerEventId}-${event.providerRevision}`}
                >
                  <TableCell>{event.effectiveDate}</TableCell>
                  <TableCell>
                    {event.numerator}:{event.denominator}
                  </TableCell>
                  <TableCell>{event.provider}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <HStack gap={2} justify="end" wrap="wrap">
          <Button
            variant="ghost"
            label={t("cancel")}
            isDisabled={isConfirming}
            onClick={() => onOpenChange(false)}
          />
          <Button
            variant="primary"
            label={isConfirming ? t("save") : t("confirmSplit")}
            isLoading={isConfirming}
            isDisabled={isConfirming}
            onClick={onConfirm}
          />
        </HStack>
      </VStack>
    </Dialog>
  );
};

export const EventsPage = ({
  apiClient = eventsApi,
  importApiClient = eventImportsApi,
  initialTimeline,
}: EventsPageProps) => {
  const { t } = useI18n();
  const toast = useToast();
  const [symbolFilter, setSymbolFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [filters, setFilters] = useState<EventFilters>({});
  const [events, setEvents] = useState(initialTimeline?.events ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(
    initialTimeline?.nextCursor ?? null,
  );
  const [positionBasisRevision, setPositionBasisRevision] = useState(
    initialTimeline?.positionBasisRevision ?? 0,
  );
  const [isLoading, setIsLoading] = useState(initialTimeline === undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editing, setEditing] = useState<TransactionEventDto | null>(null);
  const [deleting, setDeleting] = useState<TransactionEventDto | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const [review, setReview] = useState<SplitReviewState | null>(null);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);

  const load = useCallback(
    async (replace: boolean, cursor?: string | null) => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const timeline = await apiClient.list({
          ...filters,
          ...(cursor ? { cursor } : {}),
        });
        setEvents((previous) =>
          replace ? timeline.events : [...previous, ...timeline.events],
        );
        setNextCursor(timeline.nextCursor);
        setPositionBasisRevision(timeline.positionBasisRevision);
      } catch (caught) {
        setLoadError(eventLoadErrorMessage(t("eventsLoadError"), caught));
      } finally {
        setIsLoading(false);
      }
    },
    [apiClient, filters, t],
  );

  useEffect(() => {
    if (!initialTimeline) void load(true);
  }, [initialTimeline, load]);

  const handleApplyFilters = () => {
    const nextFilters: EventFilters = {};
    if (symbolFilter.trim()) nextFilters.symbol = symbolFilter.trim();
    if (typeFilter) nextFilters.type = typeFilter as "transaction" | "split";
    setFilters(nextFilters);
    // Fetch immediately so the table does not wait for an interaction cycle.
    void (async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const timeline = await apiClient.list(nextFilters);
        setEvents(timeline.events);
        setNextCursor(timeline.nextCursor);
        setPositionBasisRevision(timeline.positionBasisRevision);
      } catch (caught) {
        setLoadError(eventLoadErrorMessage(t("eventsLoadError"), caught));
      } finally {
        setIsLoading(false);
      }
    })();
  };

  const mutationSucceeded = async (result: EventMutationResponse) => {
    setPositionBasisRevision(result.positionBasisRevision);
    setPendingJobId(result.pipelineJobId);
    setMutationError(null);
    setIsAddOpen(false);
    setEditing(null);
    setDeleting(null);
    setReview(null);
    toast({
      body: `${t("pendingPipeline")}: ${result.pipelineJobId}`,
      type: "info",
    });
    await load(true);
  };

  const mutationFailure = (caught: unknown, pending: PendingMutation) => {
    if (caught instanceof ApiClientError) {
      const details = caught.details;
      const basis = details.positionBasisRevision;
      if (typeof basis === "number" && Number.isSafeInteger(basis)) {
        setPositionBasisRevision(basis);
      }
      if (
        (caught.code === "split_review_required" ||
          caught.code === "split_correction_conflict") &&
        isSplitSnapshot(
          caught.code === "split_review_required"
            ? details.review
            : details.correction,
        )
      ) {
        const snapshot = (
          caught.code === "split_review_required"
            ? details.review
            : details.correction
        ) as SplitSnapshotLike;
        const symbol =
          pending.kind === "create"
            ? pending.input.symbol
            : pending.kind === "update"
              ? events.find((event) => event.id === pending.id)?.symbol
              : events.find((event) => event.id === pending.id)?.symbol;
        if (symbol) {
          setReview({ symbol, snapshot, pending });
          setMutationError(
            caught.code === "split_correction_conflict"
              ? t("splitCorrection")
              : t("splitReviewDescription"),
          );
          return;
        }
      }
    }
    setMutationError(t(errorCopyKey(caught)));
    if (
      caught instanceof ApiClientError &&
      (caught.code === "ledger_conflict" || caught.code === "event_conflict")
    ) {
      void load(true);
    }
  };

  const execute = async (
    pending: PendingMutation,
    basisRevision = positionBasisRevision,
  ) => {
    setIsMutating(true);
    setMutationError(null);
    try {
      const result =
        pending.kind === "create"
          ? await apiClient.create(pending.input, basisRevision)
          : pending.kind === "update"
            ? await apiClient.update(
                pending.id,
                pending.input,
                basisRevision,
                pending.eventRevision,
              )
            : await apiClient.remove(
                pending.id,
                basisRevision,
                pending.eventRevision,
                pending.confirmation,
              );
      await mutationSucceeded(result);
    } catch (caught) {
      mutationFailure(caught, pending);
    } finally {
      setIsMutating(false);
    }
  };

  const handleCreateOrUpdate = async (
    input: TransactionInput | EditableTransactionInput,
  ) => {
    if (editing) {
      await execute({
        kind: "update",
        id: editing.id,
        eventRevision: editing.revision,
        input: input as EditableTransactionInput,
      });
      return;
    }
    await execute({ kind: "create", input: input as TransactionInput });
  };

  const handleDelete = async () => {
    if (!deleting) return;
    await execute({
      kind: "delete",
      id: deleting.id,
      eventRevision: deleting.revision,
    });
  };

  const handleConfirmReview = async () => {
    if (!review) return;
    setIsConfirmingReview(true);
    try {
      const confirmation = {
        requestedStartDate: review.snapshot.range.requestedStartDate,
        requestedEndDate: review.snapshot.range.requestedEndDate,
        providerRevision: review.snapshot.range.providerRevision,
      };
      const result = await apiClient.confirmSplit(
        review.symbol,
        confirmation,
        positionBasisRevision,
      );
      setPositionBasisRevision(result.positionBasisRevision);
      const pending = review.pending;
      setReview(null);
      const withConfirmation =
        pending.kind === "create"
          ? { ...pending, input: { ...pending.input, confirmation } }
          : pending.kind === "update"
            ? { ...pending, input: { ...pending.input, confirmation } }
            : { ...pending, confirmation };
      await execute(
        withConfirmation,
        resolveMutationBasisRevision(
          positionBasisRevision,
          result.positionBasisRevision,
        ),
      );
    } catch (caught) {
      mutationFailure(caught, review.pending);
    } finally {
      setIsConfirmingReview(false);
    }
  };

  const onImportCommitted = (result: ImportCommitResponse) => {
    setPositionBasisRevision(result.positionBasisRevision);
    setPendingJobId(result.pipelineJobId);
    toast({
      body: `${t("importCommitted")}: ${result.pipelineJobId}`,
      type: "info",
    });
    void load(true);
  };

  const statusLabel = (event: SplitEventDto["status"]) => {
    switch (event) {
      case "active":
        return t("active");
      case "candidate":
        return t("candidate");
      case "superseded":
        return t("superseded");
      default:
        return t("quarantined");
    }
  };

  return (
    <VStack gap={4} data-testid="events-page">
      <HStack gap={3} justify="between" align="start" wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>{t("eventsHeading")}</Heading>
          <div>{t("eventsIntro")}</div>
        </VStack>
        <HStack gap={2} wrap="wrap">
          <Button
            variant="secondary"
            label={t("refresh")}
            isLoading={isLoading}
            onClick={() => void load(true)}
          />
          <Button
            variant="secondary"
            label={t("importCsv")}
            onClick={() => setIsImportOpen(true)}
          />
          <Button
            variant="primary"
            label={t("addEvent")}
            onClick={() => setIsAddOpen(true)}
          />
        </HStack>
      </HStack>

      {pendingJobId && (
        <Banner
          status="info"
          title={`${t("pendingPipeline")}: ${pendingJobId}`}
          description={t("pendingPipelineDescription")}
          isDismissable
          onDismiss={() => setPendingJobId(null)}
        />
      )}
      {loadError && (
        <Banner
          status="error"
          title={loadError}
          endContent={
            <Button
              variant="ghost"
              label={t("retry")}
              onClick={() => void load(true)}
            />
          }
        />
      )}
      {mutationError && <Banner status="error" title={mutationError} />}

      <HStack gap={2} wrap="wrap" align="end">
        <TextInput
          label={t("filterSymbol")}
          value={symbolFilter}
          onChange={setSymbolFilter}
          hasClear
          size="sm"
        />
        <Selector
          label={t("filterType")}
          aria-label={t("filterType")}
          placeholder={t("selectPlaceholder")}
          options={[
            { value: "transaction", label: t("transactionEvents") },
            { value: "split", label: t("splitEvents") },
          ]}
          value={typeFilter}
          hasClear
          onChange={setTypeFilter}
          size="sm"
        />
        <Button
          variant="secondary"
          label={t("applyFilters")}
          onClick={handleApplyFilters}
        />
      </HStack>

      {isLoading && events.length === 0 ? (
        <Banner status="info" title={t("loadingEvents")} />
      ) : events.length === 0 ? (
        <Banner status="info" title={t("noEvents")} />
      ) : (
        <>
          <div className="horizontal-scroll-hint" role="note">
            {t("horizontalScrollHint")}
          </div>
          <Table
            tableProps={{ className: "product-events-table" }}
            density="compact"
            dividers="rows"
            hasHover
            textOverflow="wrap"
            aria-label={t("eventsHeading")}
          >
            <TableHeader>
              <TableRow isHeaderRow>
                <TableHeaderCell>{t("date")}</TableHeaderCell>
                <TableHeaderCell>{t("instrument")}</TableHeaderCell>
                <TableHeaderCell>{t("side")}</TableHeaderCell>
                <TableHeaderCell>{t("quantity")}</TableHeaderCell>
                <TableHeaderCell>{t("price")}</TableHeaderCell>
                <TableHeaderCell>{t("status")}</TableHeaderCell>
                <TableHeaderCell>{t("revision")}</TableHeaderCell>
                <TableHeaderCell>{t("actions")}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) =>
                event.type === "transaction" ? (
                  <TableRow key={`${event.type}-${event.id}`}>
                    <TableCell>{event.tradeDate}</TableCell>
                    <TableCell>
                      <strong>{event.symbol}</strong>
                      <div>{event.companyName}</div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={event.side === "buy" ? "success" : "error"}
                        label={event.side === "buy" ? t("buy") : t("sell")}
                      />
                    </TableCell>
                    <TableCell>{event.quantityDecimal}</TableCell>
                    <TableCell>
                      {event.priceDecimal} {event.currency}
                    </TableCell>
                    <TableCell>{t("transactionEvents")}</TableCell>
                    <TableCell>{event.revision}</TableCell>
                    <TableCell>
                      <HStack gap={1} wrap="wrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          label={t("edit")}
                          onClick={() => setEditing(event)}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          label={t("delete")}
                          onClick={() => setDeleting(event)}
                        />
                      </HStack>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={`${event.type}-${event.id}`}>
                    <TableCell>{event.effectiveDate}</TableCell>
                    <TableCell>
                      <strong>{event.symbol}</strong>
                      <div>{event.companyName}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="neutral" label={t("split")} />
                    </TableCell>
                    <TableCell>
                      {event.numerator}:{event.denominator}
                    </TableCell>
                    <TableCell>{event.provider}</TableCell>
                    <TableCell>
                      <Badge
                        variant={splitStatusVariant(event.status)}
                        label={statusLabel(event.status)}
                      />
                      {event.conflictMessage && (
                        <div>{event.conflictMessage}</div>
                      )}
                    </TableCell>
                    <TableCell>{event.revision}</TableCell>
                    <TableCell>—</TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        </>
      )}

      {nextCursor && (
        <Button
          variant="secondary"
          label={isLoading ? t("loadingEvents") : t("loadMore")}
          isLoading={isLoading}
          isDisabled={isLoading}
          onClick={() => void load(false, nextCursor)}
        />
      )}

      <TransactionDialog
        key={editing?.id ?? (isAddOpen ? "new" : "closed")}
        isOpen={isAddOpen || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setIsAddOpen(false);
            setEditing(null);
          }
        }}
        transaction={editing}
        onSave={handleCreateOrUpdate}
        isSaving={isMutating}
      />

      <Dialog
        isOpen={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        purpose="required"
        width="min(440px, calc(100vw - 2rem))"
        padding={4}
      >
        <DialogHeader title={t("deleteEvent")} />
        <VStack gap={3}>
          <div>{t("deleteEventDescription")}</div>
          <HStack gap={2} justify="end" wrap="wrap">
            <Button
              variant="ghost"
              label={t("cancel")}
              isDisabled={isMutating}
              onClick={() => setDeleting(null)}
            />
            <Button
              variant="destructive"
              label={t("delete")}
              isLoading={isMutating}
              isDisabled={isMutating}
              onClick={() => void handleDelete()}
            />
          </HStack>
        </VStack>
      </Dialog>

      <SplitReviewDialog
        state={review}
        isOpen={review !== null}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        onConfirm={() => void handleConfirmReview()}
        isConfirming={isConfirmingReview}
      />

      <EventImportDialog
        isOpen={isImportOpen}
        onOpenChange={setIsImportOpen}
        positionBasisRevision={positionBasisRevision}
        apiClient={importApiClient}
        onCommitted={onImportCommitted}
      />
    </VStack>
  );
};
