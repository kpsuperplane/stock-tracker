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
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EventsTimelineDto,
  TransactionEventDto,
} from "../../shared/contracts";
import { useAccountScope } from "../accounts/AccountScopeContext";
import { activeAccountsForScope } from "../accounts/scope";
import {
  ApiClientError,
  type EventFilters,
  type EventImportsApiClient,
  type EventMutationResponse,
  type EventsApiClient,
  eventImportsApi,
  eventsApi,
  type ImportCommitResponse,
  type TransactionMutationInput,
} from "../api";
import {
  EditIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
  UploadIcon,
} from "../components/ProductIcons";
import { useI18n } from "../i18n/I18nProvider";
import { usePageActions } from "../system/PageActionsContext";
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
    };

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
  const { selection, categories } = useAccountScope();
  const accountOptions = useMemo(() => {
    const scopedAccounts = activeAccountsForScope(categories, selection);
    const currentAccount = transaction?.accountId
      ? categories
          .flatMap((category) => category.accounts)
          .find((account) => account.id === transaction.accountId)
      : undefined;
    const availableAccounts =
      currentAccount &&
      !scopedAccounts.some((account) => account.id === currentAccount.id)
        ? [currentAccount, ...scopedAccounts]
        : scopedAccounts;
    return availableAccounts.map((account) => ({
      value: account.id,
      label: `${categories.find((category) => category.id === account.categoryId)?.name ?? t("category")} / ${account.name}${account.archivedAt ? ` (${t("archived")})` : ""}`,
    }));
  }, [categories, selection, t, transaction]);
  const [accountId, setAccountId] = useState(
    transaction?.accountId ?? accountOptions[0]?.value ?? "",
  );

  useEffect(() => {
    if (transaction) return;
    setAccountId((current) =>
      accountOptions.some((option) => option.value === current)
        ? current
        : (accountOptions[0]?.value ?? ""),
    );
  }, [accountOptions, transaction]);

  const submit = async () => {
    if (!accountId) {
      setValidationError(t("noActiveAccountsInScope"));
      return;
    }
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
      ...(accountId ? { accountId } : {}),
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
            label={t("account")}
            aria-label={t("account")}
            placeholder={t("selectPlaceholder")}
            options={accountOptions}
            value={accountId}
            onChange={setAccountId}
            isDisabled={accountOptions.length === 0}
          />
          {accountOptions.length === 0 && (
            <Banner status="warning" title={t("noActiveAccountsInScope")} />
          )}
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
            isDisabled={isSaving || !accountId}
            onClick={() => void submit()}
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
  const { selection } = useAccountScope();
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
  const [isImportOpen, setIsImportOpen] = useState(false);

  const load = useCallback(
    async (replace: boolean, cursor?: string | null) => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const timeline = await apiClient.list({
          ...filters,
          scopeType: selection.scopeType,
          ...(selection.scopeId ? { scopeId: selection.scopeId } : {}),
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
    [apiClient, filters, selection, t],
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
        const timeline = await apiClient.list({
          ...nextFilters,
          scopeType: selection.scopeType,
          ...(selection.scopeId ? { scopeId: selection.scopeId } : {}),
        });
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
    const warning =
      result.warningCode === "split_history_unavailable"
        ? t("splitHistoryUnavailableWarning")
        : result.warningCode === "split_history_conflict"
          ? t("splitHistoryConflictWarning")
          : null;
    toast({
      body: warning ?? `${t("pendingPipeline")}: ${result.pipelineJobId}`,
      type: "info",
    });
    await load(true);
  };

  const mutationFailure = (caught: unknown) => {
    if (caught instanceof ApiClientError) {
      const details = caught.details;
      const basis = details.positionBasisRevision;
      if (typeof basis === "number" && Number.isSafeInteger(basis)) {
        setPositionBasisRevision(basis);
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
              );
      await mutationSucceeded(result);
    } catch (caught) {
      mutationFailure(caught);
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

  const onImportCommitted = (result: ImportCommitResponse) => {
    setPositionBasisRevision(result.positionBasisRevision);
    setPendingJobId(result.pipelineJobId);
    toast({
      body: `${t("importCommitted")}: ${result.pipelineJobId}`,
      type: "info",
    });
    void load(true);
  };

  const refresh = useCallback(() => void load(true), [load]);
  const openImport = useCallback(() => setIsImportOpen(true), []);
  const openAdd = useCallback(() => setIsAddOpen(true), []);
  const pageActions = useMemo(
    () => (
      <HStack gap={1} wrap="nowrap">
        <Button
          variant="secondary"
          size="sm"
          label={t("refresh")}
          tooltip={t("refresh")}
          icon={<Icon icon={RefreshIcon} size="sm" />}
          isIconOnly
          isLoading={isLoading}
          onClick={refresh}
        />
        <Button
          variant="secondary"
          size="sm"
          label={t("importCsv")}
          tooltip={t("importCsv")}
          icon={<Icon icon={UploadIcon} size="sm" />}
          isIconOnly
          onClick={openImport}
        />
        <Button
          variant="primary"
          size="sm"
          label={t("addEvent")}
          tooltip={t("addEvent")}
          icon={<Icon icon={PlusIcon} size="sm" />}
          isIconOnly
          onClick={openAdd}
        />
      </HStack>
    ),
    [isLoading, openAdd, openImport, refresh, t],
  );
  const hasTopNavActions = usePageActions(pageActions);

  return (
    <VStack gap={3} data-testid="events-page">
      <HStack gap={2} justify="between" align="center" wrap="nowrap">
        <Heading level={1} className="product-page-title-hidden">
          {t("eventsHeading")}
        </Heading>
        {!hasTopNavActions && pageActions}
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

      <div className="events-filter-row">
        <TextInput
          label={t("filterSymbol")}
          placeholder={t("filterSymbol")}
          isLabelHidden
          value={symbolFilter}
          onChange={setSymbolFilter}
          hasClear
          size="sm"
          width="100%"
        />
        <Selector
          label={t("filterType")}
          isLabelHidden
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
          width="100%"
        />
        <Button
          variant="ghost"
          size="sm"
          label={t("applyFilters")}
          tooltip={t("applyFilters")}
          icon={<Icon icon="funnel" size="sm" />}
          isIconOnly
          onClick={handleApplyFilters}
        />
      </div>

      {isLoading && events.length === 0 ? (
        <Banner status="info" title={t("loadingEvents")} />
      ) : events.length === 0 ? (
        <Banner status="info" title={t("noEvents")} />
      ) : (
        <Table
          tableProps={{ className: "product-events-table" }}
          density="compact"
          dividers="rows"
          hasHover
          textOverflow="truncate"
          aria-label={t("eventsHeading")}
        >
          <TableHeader>
            <TableRow isHeaderRow>
              <TableHeaderCell>{t("date")}</TableHeaderCell>
              <TableHeaderCell>{t("instrument")}</TableHeaderCell>
              <TableHeaderCell>{t("account")}</TableHeaderCell>
              <TableHeaderCell>{t("side")}</TableHeaderCell>
              <TableHeaderCell>{t("quantity")}</TableHeaderCell>
              <TableHeaderCell>{t("price")}</TableHeaderCell>
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
                  </TableCell>
                  <TableCell>
                    {event.categoryName && event.accountName
                      ? `${event.categoryName} / ${event.accountName}`
                      : (event.accountName ?? "—")}
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
                  <TableCell>
                    <HStack gap={1} wrap="nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        label={t("edit")}
                        tooltip={t("edit")}
                        icon={<Icon icon={EditIcon} size="sm" />}
                        isIconOnly
                        onClick={() => setEditing(event)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        label={t("delete")}
                        tooltip={t("delete")}
                        icon={<Icon icon={TrashIcon} size="sm" />}
                        isIconOnly
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
                  </TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>
                    <Badge variant="neutral" label={t("split")} />
                  </TableCell>
                  <TableCell>
                    {event.numerator}:{event.denominator}
                  </TableCell>
                  <TableCell>{event.provider}</TableCell>
                  <TableCell>—</TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
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
