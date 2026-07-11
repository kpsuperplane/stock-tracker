import {
  Badge,
  Dialog,
  DialogHeader,
  HStack,
  VStack,
} from "@astryxdesign/core";
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
    <a href={sourceUrl} target="_blank" rel="noreferrer">
      {label} · {provider}
    </a>
  ) : (
    <span>{provider}</span>
  );

const MoverDetails = ({ event }: { event: CalendarMoverDto }) => {
  const { locale, t } = useI18n();
  const movement = event.movement;
  const sources = event.sources.filter((source) => source.sourceUrl !== null);
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
              <a
                key={source.sourceUrl}
                href={source.sourceUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
              >
                {source.title}
                {source.publisher ? ` · ${source.publisher}` : ""}
              </a>
            ))}
          </VStack>
        ) : (
          <span>{t("noSources")}</span>
        )}
      </VStack>
      <HStack gap={1} wrap="wrap">
        <Badge variant="success" label={t("qualified")} />
        <Badge
          variant={event.freshness === "fresh" ? "success" : "warning"}
          label={t(event.freshness)}
        />
        {event.analysisStatus && event.analysisStatus !== "complete" && (
          <Badge
            variant={event.analysisStatus === "error" ? "error" : "warning"}
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
          variant={event.status === "active" ? "success" : "warning"}
          label={event.status}
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
  return (
    <Dialog
      isOpen={selection !== null}
      onOpenChange={onOpenChange}
      purpose="info"
      width="min(540px, calc(100vw - 2rem))"
      maxHeight="min(80vh, 720px)"
      padding={4}
    >
      <DialogHeader title={title} onOpenChange={onOpenChange} />
      {selection?.kind === "mover" && <MoverDetails event={selection.event} />}
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
    </Dialog>
  );
};
