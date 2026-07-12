import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  HStack,
  Link,
  VStack,
} from "@astryxdesign/core";
import { Icon } from "@astryxdesign/core/Icon";
import type {
  CalendarDividendDto,
  CalendarMoverDto,
} from "../../shared/contracts";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate } from "../system/formatters";
import {
  type CalendarEvent,
  CalendarEventChip,
  type CalendarSelection,
  safeCurrency,
  safeDecimal,
  signedDecimal,
} from "./CalendarEvent";

export interface MoverDialogProps {
  selection: CalendarSelection | null;
  onOpenChange: (isOpen: boolean) => void;
  onSelect: (selection: CalendarSelection) => void;
}

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <HStack gap={2} justify="between" align="start" wrap="wrap">
    <span>{label}</span>
    <strong>{value}</strong>
  </HStack>
);

export const freshnessBadgeVariant = (
  freshness: CalendarMoverDto["freshness"],
): "neutral" | "success" | "warning" | "error" => {
  switch (freshness) {
    case "fresh":
      return "success";
    case "stale":
    case "pending":
      return "warning";
    case "error":
      return "error";
    default:
      return "neutral";
  }
};

export const analysisBadgeVariant = (
  status: NonNullable<CalendarMoverDto["analysisStatus"]>,
): "neutral" | "success" | "warning" | "error" => {
  switch (status) {
    case "complete":
      return "success";
    case "stale":
    case "pending":
      return "warning";
    case "error":
      return "error";
    default:
      return "neutral";
  }
};

export const dividendStatusBadgeVariant = (
  status: CalendarDividendDto["status"],
): "neutral" | "success" | "warning" | "error" => {
  switch (status) {
    case "active":
      return "success";
    case "stale":
    case "superseded":
      return "warning";
    case "error":
      return "error";
  }
};

const SourceLink = ({
  sourceUrl,
  provider,
  label,
}: {
  sourceUrl: string | null;
  provider: string;
  label: string;
}) =>
  sourceUrl ? (
    <Link href={sourceUrl} hasUnderline isExternalLink weight="semibold">
      {label} · {provider}
    </Link>
  ) : (
    <span>{provider}</span>
  );

const MoverDetails = ({ event }: { event: CalendarMoverDto }) => {
  const { locale, t } = useI18n();
  const movement = event.movement;
  const sources = event.sources.flatMap((source) =>
    source.sourceUrl ? [{ ...source, sourceUrl: source.sourceUrl }] : [],
  );
  return (
    <VStack gap={3}>
      <DetailRow
        label={t("date")}
        value={formatDate(event.tradingDate, locale)}
      />
      <DetailRow
        label={t("movementPercent")}
        value={`${signedDecimal(movement?.movementPercentDecimal ?? null, locale)}%`}
      />
      <DetailRow
        label={t("movementAmount")}
        value={safeCurrency(
          movement?.movementAmountDecimal ?? null,
          event.currency,
          locale,
        )}
      />
      <DetailRow
        label={t("previousClose")}
        value={safeCurrency(
          movement?.previousRawCloseDecimal ?? null,
          event.currency,
          locale,
        )}
      />
      <DetailRow
        label={t("rawClose")}
        value={safeCurrency(
          event.currentRawCloseDecimal,
          event.currency,
          locale,
        )}
      />
      <DetailRow
        label={t("heldQuantity")}
        value={safeDecimal(event.heldQuantityDecimal, locale)}
      />
      <DetailRow
        label={t("valuation")}
        value={safeCurrency(event.valuationDecimal, event.currency, locale)}
      />
      <DetailRow
        label={t("movementBasis")}
        value={
          movement?.basis === "split_adjusted_price_return"
            ? t("splitAdjustedBasis")
            : t("legacyBasis")
        }
      />
      <VStack gap={1}>
        <strong>{t("summary")}</strong>
        <div>{event.summaryZhCn ?? t("noSummary")}</div>
        {sources.length > 0 ? (
          <VStack gap={0.5}>
            {sources.map((source) => (
              <Link
                key={source.sourceUrl}
                href={source.sourceUrl}
                hasUnderline
                isExternalLink
                weight="semibold"
              >
                {source.title}
                {source.publisher ? ` · ${source.publisher}` : ""}
              </Link>
            ))}
          </VStack>
        ) : (
          <span>{t("noSources")}</span>
        )}
      </VStack>
      <HStack gap={1} wrap="wrap">
        <Badge variant="success" label={t("qualified")} />
        <Badge
          variant={freshnessBadgeVariant(event.freshness)}
          label={t(event.freshness)}
        />
        {event.analysisStatus && event.analysisStatus !== "complete" && (
          <Badge
            variant={analysisBadgeVariant(event.analysisStatus)}
            label={t(event.analysisStatus)}
          />
        )}
      </HStack>
    </VStack>
  );
};

const DividendDetails = ({ event }: { event: CalendarDividendDto }) => {
  const { locale, t } = useI18n();
  return (
    <VStack gap={3}>
      <DetailRow
        label={t("exDividendDate")}
        value={formatDate(event.exDate, locale)}
      />
      <DetailRow
        label={t("paymentDate")}
        value={event.paymentDate ? formatDate(event.paymentDate, locale) : "—"}
      />
      <DetailRow
        label={t("amountPerShare")}
        value={safeCurrency(
          event.amountPerShareDecimal,
          event.currency,
          locale,
        )}
      />
      <DetailRow
        label={t("eligibleShares")}
        value={safeDecimal(event.heldQuantityDecimal, locale)}
      />
      <DetailRow
        label={t("expectedTotal")}
        value={safeCurrency(
          event.expectedTotalValueDecimal,
          event.currency,
          locale,
        )}
      />
      <HStack gap={1} wrap="wrap">
        <Badge
          variant={event.eligible ? "success" : "neutral"}
          label={event.eligible ? t("eligibleShares") : t("notEligible")}
        />
        <Badge
          variant={dividendStatusBadgeVariant(event.status)}
          label={t(event.status)}
        />
        <Badge variant="neutral" label={t("bestEffort")} />
      </HStack>
      <SourceLink
        sourceUrl={event.sourceUrl}
        provider={event.provider}
        label={t("openSource")}
      />
    </VStack>
  );
};

const MoreDetails = ({
  date,
  events,
  onSelect,
}: {
  date: string;
  events: CalendarEvent[];
  onSelect: (selection: CalendarSelection) => void;
}) => {
  const { locale, t } = useI18n();
  return (
    <VStack gap={2}>
      <div>{formatDate(date, locale)}</div>
      {events.map((event) => (
        <CalendarEventChip
          key={`${event.kind}-${event.id}`}
          event={event}
          locale={locale}
          onSelect={onSelect}
        />
      ))}
      {events.length === 0 && <div>{t("noCalendarEvents")}</div>}
    </VStack>
  );
};

export const MoverDialog = ({
  selection,
  onOpenChange,
  onSelect,
}: MoverDialogProps) => {
  const { t } = useI18n();
  const title =
    selection?.kind === "mover"
      ? `${selection.event.symbol} · ${t("mover")}`
      : selection?.kind === "dividend"
        ? `${selection.event.symbol} · ${t("dividend")}`
        : t("dateDetails");
  const closeButton = (
    <Button
      variant="ghost"
      label={t("close")}
      tooltip={t("close")}
      icon={<Icon icon="close" color="inherit" />}
      isIconOnly
      onClick={() => onOpenChange(false)}
    />
  );
  return (
    <Dialog
      isOpen={selection !== null}
      onOpenChange={onOpenChange}
      purpose="info"
      width="min(540px, calc(100vw - 2rem))"
      maxHeight="min(80vh, 720px)"
      padding={4}
      className="calendar-mover-dialog"
    >
      <DialogHeader title={title} endContent={closeButton} />
      <div className="calendar-mover-dialog__body">
        {selection?.kind === "mover" && (
          <MoverDetails event={selection.event} />
        )}
        {selection?.kind === "dividend" && (
          <DividendDetails event={selection.event} />
        )}
        {selection?.kind === "more" && (
          <MoreDetails
            date={selection.date}
            events={selection.events}
            onSelect={onSelect}
          />
        )}
      </div>
    </Dialog>
  );
};
