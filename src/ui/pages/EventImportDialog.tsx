import {
  Badge,
  Banner,
  Button,
  Dialog,
  DialogHeader,
  FileInput,
  FormLayout,
  HStack,
  Icon,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@astryxdesign/core";
import { useRef, useState } from "react";
import {
  ApiClientError,
  type EventImportsApiClient,
  eventImportsApi,
  type ImportCommitResponse,
  type ImportPreviewResponse,
  type ImportSplitReview,
} from "../api";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/I18nProvider";

export interface EventImportDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  positionBasisRevision: number;
  apiClient?: EventImportsApiClient;
  onCommitted?: (result: ImportCommitResponse) => void;
  /** Optional seed used by fixture-driven previews and SSR verification. */
  initialPreview?: ImportPreviewResponse;
}

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
  error: unknown,
):
  | "duplicateImport"
  | "invalidCsv"
  | "importExpired"
  | "importConflict"
  | "importProviderUnavailable" => {
  if (!(error instanceof ApiClientError)) return "invalidCsv";
  switch (error.code) {
    case "duplicate_import":
      return "duplicateImport";
    case "import_expired":
    case "import_not_found":
      return "importExpired";
    case "ledger_conflict":
      return "importConflict";
    case "provider_unavailable":
      return "importProviderUnavailable";
    default:
      return "invalidCsv";
  }
};

const statusVariant = (status: "valid" | "invalid") =>
  status === "valid" ? "success" : "error";

const rowErrorCopy: Record<string, MessageKey> = {
  column_count: "rowErrorColumnCount",
  invalid_symbol: "rowErrorInvalidSymbol",
  invalid_trade_date: "rowErrorInvalidTradeDate",
  invalid_side: "rowErrorInvalidSide",
  invalid_quantity: "rowErrorInvalidQuantity",
  invalid_price: "rowErrorInvalidPrice",
  invalid_category: "rowErrorInvalidCategory",
  invalid_account: "rowErrorInvalidAccount",
  unknown_account: "rowErrorUnknownAccount",
  unknown_symbol: "rowErrorUnknownSymbol",
  negative_holdings: "rowErrorNegativeHoldings",
  invalid_staged_row: "rowErrorInvalidStaged",
};

const localizeRowError = (code: string, t: (key: MessageKey) => string) =>
  t(rowErrorCopy[code] ?? "invalidRow");

/** Prevent a slower preview response from replacing a newer file selection. */
export const isCurrentPreviewRequest = (
  requestId: number,
  currentRequestId: number,
  requestFile: File,
  currentFile: File | null,
): boolean => requestId === currentRequestId && requestFile === currentFile;

const SplitReviewCard = ({ review }: { review: ImportSplitReview }) => {
  const { t } = useI18n();
  const range = review.snapshot.range;
  return (
    <Banner
      status="info"
      title={`${review.symbol} · ${t("requestedRange")}: ${review.requestedStartDate} → ${review.requestedEndDate}`}
      description={`${t("source")}: ${review.provider} · ${t("providerRevision")}: ${review.providerRevision}`}
      defaultIsExpanded={false}
    >
      <VStack gap={2}>
        <div>
          {t("retrievedAt")}: {range.observedAt}
        </div>
        <div>
          {t("coverageStart")}: {range.coverageStartDate ?? "—"} ·{" "}
          {t("coverageEnd")}: {range.coverageEndDate ?? "—"}
        </div>
        <div>
          {t("snapshotBasis")}: {range.basis}
        </div>
        {!range.isComplete && <div>{t("splitReviewIncomplete")}</div>}
        {review.snapshot.events.length === 0 ? (
          <div>{t("splitReviewNoEvents")}</div>
        ) : (
          <Table
            density="compact"
            dividers="rows"
            textOverflow="truncate"
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
              {review.snapshot.events.map((event) => (
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
      </VStack>
    </Banner>
  );
};

export const EventImportDialog = ({
  isOpen,
  onOpenChange,
  positionBasisRevision,
  apiClient = eventImportsApi,
  onCommitted,
  initialPreview,
}: EventImportDialogProps) => {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(
    initialPreview ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const previewRequestId = useRef(0);
  const fileRef = useRef<File | null>(null);

  const clearPreview = () => {
    previewRequestId.current += 1;
    setPreview(null);
  };

  const reset = () => {
    clearPreview();
    fileRef.current = null;
    setFile(null);
    setError(null);
    setIsPreviewing(false);
    setIsCommitting(false);
  };

  const close = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const handlePreview = async () => {
    if (!file) {
      setError(t("chooseCsvFile"));
      return;
    }
    const requestFile = file;
    clearPreview();
    const requestId = previewRequestId.current;
    setIsPreviewing(true);
    setError(null);
    try {
      const result = await apiClient.preview(requestFile);
      if (
        !isCurrentPreviewRequest(
          requestId,
          previewRequestId.current,
          requestFile,
          fileRef.current,
        )
      ) {
        return;
      }
      setPreview(result);
    } catch (caught) {
      if (
        !isCurrentPreviewRequest(
          requestId,
          previewRequestId.current,
          requestFile,
          fileRef.current,
        )
      ) {
        return;
      }
      setError(t(errorCopyKey(caught)));
    } finally {
      if (
        isCurrentPreviewRequest(
          requestId,
          previewRequestId.current,
          requestFile,
          fileRef.current,
        )
      ) {
        setIsPreviewing(false);
      }
    }
  };

  const handleCommit = async () => {
    if (!preview) {
      setError(t("noPreview"));
      return;
    }
    if (preview.rows.length === 0) {
      setError(t("noImportRows"));
      return;
    }
    if (preview.rows.some((row) => row.status === "invalid")) {
      setError(t("invalidCsv"));
      return;
    }
    setIsCommitting(true);
    setError(null);
    try {
      const result = await apiClient.commit(
        preview.batchId,
        positionBasisRevision,
      );
      onCommitted?.(result);
      close(false);
    } catch (caught) {
      if (
        caught instanceof ApiClientError &&
        (caught.code === "import_expired" ||
          caught.code === "import_not_found" ||
          caught.code === "ledger_conflict")
      ) {
        clearPreview();
      }
      setError(t(errorCopyKey(caught)));
    } finally {
      setIsCommitting(false);
    }
  };

  const canCommit =
    preview !== null &&
    preview.rows.length > 0 &&
    !preview.rows.some((row) => row.status === "invalid");

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={close}
      purpose="form"
      width="min(720px, calc(100vw - 2rem))"
      maxHeight="90vh"
      padding={4}
    >
      <DialogHeader
        title={t("csvImportTitle")}
        subtitle={t("csvImportDescription")}
        endContent={<DialogCloseButton onOpenChange={close} />}
      />
      <VStack gap={4}>
        <FormLayout>
          <FileInput
            label={t("csvFile")}
            value={file}
            onChange={(next) => {
              const nextFile = Array.isArray(next) ? (next[0] ?? null) : next;
              fileRef.current = nextFile;
              setFile(nextFile);
              clearPreview();
              setError(null);
              setIsPreviewing(false);
            }}
            accept=".csv,text/csv,application/csv,text/plain"
            mode="dropzone"
            placeholder={t("chooseFile")}
            description={t("csvTemplateDescription")}
            isDisabled={isPreviewing || isCommitting}
            isRequired
          />
          <HStack gap={2} wrap="wrap" align="center">
            <Button
              variant="primary"
              label={isPreviewing ? t("previewingImport") : t("previewImport")}
              isLoading={isPreviewing}
              isDisabled={!file || isPreviewing || isCommitting}
              onClick={handlePreview}
            />
            <Button
              variant="ghost"
              label={t("csvTemplate")}
              href="/templates/portfolio-events.csv"
              target="_blank"
              rel="noreferrer"
            />
          </HStack>
        </FormLayout>

        {error && <Banner status="error" title={error} />}

        {preview && (
          <VStack gap={4}>
            <div>
              {t("importRows")}: {preview.rows.length} · {t("previewExpiresAt")}
              : {preview.expiresAt}
            </div>
            <Table
              density="compact"
              dividers="rows"
              hasHover
              textOverflow="truncate"
              aria-label={t("csvImportTitle")}
            >
              <TableHeader>
                <TableRow isHeaderRow>
                  <TableHeaderCell>#</TableHeaderCell>
                  <TableHeaderCell>{t("category")}</TableHeaderCell>
                  <TableHeaderCell>{t("account")}</TableHeaderCell>
                  <TableHeaderCell>{t("date")}</TableHeaderCell>
                  <TableHeaderCell>{t("instrument")}</TableHeaderCell>
                  <TableHeaderCell>{t("side")}</TableHeaderCell>
                  <TableHeaderCell>{t("quantity")}</TableHeaderCell>
                  <TableHeaderCell>{t("price")}</TableHeaderCell>
                  <TableHeaderCell>{t("status")}</TableHeaderCell>
                  <TableHeaderCell>{t("errors")}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.map((row) => (
                  <TableRow key={row.rowNumber}>
                    <TableCell>{row.rowNumber}</TableCell>
                    <TableCell>{row.categoryName || "—"}</TableCell>
                    <TableCell>{row.accountName || "—"}</TableCell>
                    <TableCell>{row.tradeDate ?? "—"}</TableCell>
                    <TableCell>{row.symbol || "—"}</TableCell>
                    <TableCell>{row.side ? t(row.side) : "—"}</TableCell>
                    <TableCell>{row.quantityDecimal ?? "—"}</TableCell>
                    <TableCell>{row.priceDecimal ?? "—"}</TableCell>
                    <TableCell>
                      <Badge
                        variant={statusVariant(row.status)}
                        label={t(row.status)}
                      />
                    </TableCell>
                    <TableCell>
                      {row.errors.length > 0
                        ? row.errors
                            .map((code) => localizeRowError(code, t))
                            .join(", ")
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <VStack gap={2}>
              <strong>{t("projectedHoldings")}</strong>
              <Table
                density="compact"
                dividers="rows"
                textOverflow="truncate"
                aria-label={t("projectedHoldings")}
              >
                <TableHeader>
                  <TableRow isHeaderRow>
                    <TableHeaderCell>{t("category")}</TableHeaderCell>
                    <TableHeaderCell>{t("account")}</TableHeaderCell>
                    <TableHeaderCell>{t("instrument")}</TableHeaderCell>
                    <TableHeaderCell>{t("projectedQuantity")}</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.projectedHoldings.map((holding) => (
                    <TableRow key={`${holding.accountId}-${holding.symbol}`}>
                      <TableCell>{holding.categoryName}</TableCell>
                      <TableCell>{holding.accountName}</TableCell>
                      <TableCell>{holding.symbol}</TableCell>
                      <TableCell>{holding.quantityDecimal}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </VStack>

            {preview.reviews.length > 0 && (
              <VStack gap={2}>
                <div>
                  <strong>{t("importReviewTitle")}</strong>
                  <div>{t("importReviewDescription")}</div>
                </div>
                {preview.reviews.map((review) => (
                  <SplitReviewCard
                    key={`${review.instrumentId}-${review.providerRevision}`}
                    review={review}
                  />
                ))}
              </VStack>
            )}

            <HStack gap={2} justify="end" wrap="wrap">
              <Button
                variant="ghost"
                label={t("cancel")}
                isDisabled={isCommitting}
                onClick={() => close(false)}
              />
              <Button
                variant="primary"
                label={isCommitting ? t("committingImport") : t("commitImport")}
                isLoading={isCommitting}
                isDisabled={!canCommit || isCommitting}
                onClick={handleCommit}
              />
            </HStack>
          </VStack>
        )}
      </VStack>
    </Dialog>
  );
};
