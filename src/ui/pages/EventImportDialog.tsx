import {
  Badge,
  Banner,
  Button,
  Dialog,
  DialogHeader,
  FileInput,
  FormLayout,
  HStack,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@astryxdesign/core";
import { useState } from "react";
import {
  ApiClientError,
  type EventImportsApiClient,
  eventImportsApi,
  type ImportCommitResponse,
  type ImportConfirmation,
  type ImportPreviewResponse,
  type ImportSplitReview,
} from "../api";
import { useI18n } from "../i18n/I18nProvider";

export interface EventImportDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  positionBasisRevision: number;
  apiClient?: EventImportsApiClient;
  onCommitted?: (result: ImportCommitResponse) => void;
}

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

const SplitReviewCard = ({
  review,
  isConfirmed,
  onConfirm,
}: {
  review: ImportSplitReview;
  isConfirmed: boolean;
  onConfirm: () => void;
}) => {
  const { t } = useI18n();
  const range = review.snapshot.range;
  return (
    <Banner
      status={isConfirmed ? "success" : "warning"}
      title={`${review.symbol} · ${t("requestedRange")}: ${review.requestedStartDate} → ${review.requestedEndDate}`}
      description={`${t("source")}: ${review.provider} · ${t("providerRevision")}: ${review.providerRevision}`}
      endContent={
        <Button
          size="sm"
          variant={isConfirmed ? "secondary" : "primary"}
          label={isConfirmed ? t("confirmed") : t("confirmReview")}
          isDisabled={isConfirmed}
          onClick={onConfirm}
        />
      }
    >
      <VStack gap={2}>
        <div>
          {t("retrievedAt")}: {range.observedAt}
        </div>
        {!range.isComplete && <div>{t("splitReviewIncomplete")}</div>}
        {review.snapshot.events.length === 0 ? (
          <div>{t("splitReviewNoEvents")}</div>
        ) : (
          <Table density="compact" dividers="rows">
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
}: EventImportDialogProps) => {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [confirmedReviews, setConfirmedReviews] = useState<Set<number>>(
    new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setConfirmedReviews(new Set());
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
    setIsPreviewing(true);
    setError(null);
    try {
      const result = await apiClient.preview(file);
      setPreview(result);
      setConfirmedReviews(new Set());
    } catch (caught) {
      setError(t(errorCopyKey(caught)));
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleCommit = async () => {
    if (!preview) {
      setError(t("noPreview"));
      return;
    }
    if (preview.rows.some((row) => row.status === "invalid")) {
      setError(t("invalidCsv"));
      return;
    }
    if (confirmedReviews.size !== preview.reviews.length) {
      setError(t("importReviewDescription"));
      return;
    }
    const confirmations: ImportConfirmation[] = preview.reviews.map(
      (review) => ({
        instrumentId: review.instrumentId,
        requestedStartDate: review.requestedStartDate,
        requestedEndDate: review.requestedEndDate,
        providerRevision: review.providerRevision,
      }),
    );
    setIsCommitting(true);
    setError(null);
    try {
      const result = await apiClient.commit(
        preview.batchId,
        positionBasisRevision,
        confirmations,
      );
      onCommitted?.(result);
      close(false);
    } catch (caught) {
      if (
        caught instanceof ApiClientError &&
        caught.code === "split_review_required" &&
        Array.isArray(caught.details.reviews)
      ) {
        setPreview((previous) =>
          previous
            ? {
                ...previous,
                reviews: caught.details.reviews as ImportSplitReview[],
              }
            : previous,
        );
        setConfirmedReviews(new Set());
        setError(t("importReviewDescription"));
        return;
      }
      setError(t(errorCopyKey(caught)));
    } finally {
      setIsCommitting(false);
    }
  };

  const allReviewsConfirmed =
    preview !== null &&
    !preview.rows.some((row) => row.status === "invalid") &&
    confirmedReviews.size === preview.reviews.length;

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
        onOpenChange={close}
      />
      <VStack gap={4}>
        <FormLayout>
          <FileInput
            label={t("csvFile")}
            value={file}
            onChange={(next) =>
              setFile(Array.isArray(next) ? (next[0] ?? null) : next)
            }
            accept=".csv,text/csv,application/csv,text/plain"
            mode="dropzone"
            description={t("csvTemplateDescription")}
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
              {t("importRows")}: {preview.rows.length} · {t("requestedRange")}:{" "}
              {preview.expiresAt}
            </div>
            <Table
              density="compact"
              dividers="rows"
              hasHover
              textOverflow="wrap"
            >
              <TableHeader>
                <TableRow isHeaderRow>
                  <TableHeaderCell>#</TableHeaderCell>
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
                    <TableCell>{row.errors.join(", ") || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <VStack gap={2}>
              <strong>{t("projectedHoldings")}</strong>
              <Table density="compact" dividers="rows">
                <TableHeader>
                  <TableRow isHeaderRow>
                    <TableHeaderCell>{t("instrument")}</TableHeaderCell>
                    <TableHeaderCell>{t("projectedQuantity")}</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(preview.projectedHoldings).map(
                    ([symbol, quantity]) => (
                      <TableRow key={symbol}>
                        <TableCell>{symbol}</TableCell>
                        <TableCell>{quantity}</TableCell>
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            </VStack>

            {preview.reviews.length > 0 && (
              <VStack gap={2}>
                <div>
                  <strong>{t("importReviewTitle")}</strong>
                  <div>{t("importReviewDescription")}</div>
                </div>
                {preview.reviews.map((review, index) => (
                  <SplitReviewCard
                    key={`${review.instrumentId}-${review.providerRevision}`}
                    review={review}
                    isConfirmed={confirmedReviews.has(index)}
                    onConfirm={() =>
                      setConfirmedReviews((previous) => {
                        const next = new Set(previous);
                        next.add(index);
                        return next;
                      })
                    }
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
                isDisabled={!allReviewsConfirmed || isCommitting}
                onClick={handleCommit}
              />
            </HStack>
          </VStack>
        )}
      </VStack>
    </Dialog>
  );
};
