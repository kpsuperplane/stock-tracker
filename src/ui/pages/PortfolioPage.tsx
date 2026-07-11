import {
  Badge,
  Banner,
  Button,
  Heading,
  HStack,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@astryxdesign/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PortfolioMovementDto,
  PortfolioPositionDto,
  PortfolioReadModelDto,
} from "../../shared/contracts";
import {
  type PortfolioApiClient,
  type PortfolioReadOptions,
  portfolioApi,
} from "../api";
import { FactStatus } from "../components/FactStatus";
import { useI18n } from "../i18n/I18nProvider";
import {
  formatDate,
  formatDecimalString,
  formatNativeCurrency,
} from "../system/formatters";

export interface PortfolioPageProps {
  apiClient?: PortfolioApiClient;
  initialPortfolio?: PortfolioReadModelDto;
  today?: string;
}

const numericStyle = {
  textAlign: "end" as const,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap" as const,
};

const summaryStyle = {
  minWidth: "15rem",
  maxWidth: "30rem",
  overflowWrap: "anywhere" as const,
};

const safeDecimal = (
  value: string | null,
  locale: "en" | "cn",
  maximumFractionDigits?: number,
): string => {
  if (value === null) return "—";
  try {
    return formatDecimalString(value, locale, maximumFractionDigits);
  } catch {
    return "—";
  }
};

const safeCurrency = (
  value: string | null,
  currency: "CAD" | "USD",
  locale: "en" | "cn",
): string => {
  if (value === null) return "—";
  try {
    return formatNativeCurrency(value, currency, locale);
  } catch {
    return "—";
  }
};

export const formatSignedDecimal = (
  value: string | null,
  locale: "en" | "cn",
  maximumFractionDigits = 2,
): string => {
  if (value === null) return "—";
  const formatted = safeDecimal(value, locale, maximumFractionDigits);
  if (formatted === "—" || formatted.startsWith("-")) return formatted;
  return `+${formatted}`;
};

export const movementTone = (
  movement: PortfolioMovementDto | null,
): "positive" | "negative" | "neutral" => {
  if (!movement?.movementPercentDecimal) return "neutral";
  try {
    if (movement.movementPercentDecimal.startsWith("-")) return "negative";
    if (movement.movementPercentDecimal === "0") return "neutral";
    return "positive";
  } catch {
    return "neutral";
  }
};

const movementColor = {
  positive: "var(--color-success)",
  negative: "var(--color-error)",
  neutral: "var(--color-text-secondary)",
} as const;

const movementLabel = (
  movement: PortfolioMovementDto | null,
  locale: "en" | "cn",
  emptyLabel: string,
) => {
  if (!movement) return emptyLabel;
  const amount = formatSignedDecimal(movement.movementAmountDecimal, locale, 2);
  const percent = formatSignedDecimal(
    movement.movementPercentDecimal,
    locale,
    2,
  );
  return { amount, percent };
};

const SourceLinks = ({ position }: { position: PortfolioPositionDto }) => {
  const { t } = useI18n();
  const sources = position.sources.filter(
    (source): source is typeof source & { sourceUrl: string } =>
      source.sourceUrl !== null,
  );
  if (sources.length === 0) {
    return <span>{t("noSources")}</span>;
  }
  return (
    <VStack gap={0.5}>
      {sources.map((source) => (
        <a
          key={source.sourceUrl}
          href={source.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          {source.title}
          {source.publisher ? ` · ${source.publisher}` : ""}
        </a>
      ))}
    </VStack>
  );
};

const PositionRow = ({
  position,
  locale,
}: {
  position: PortfolioPositionDto;
  locale: "en" | "cn";
}) => {
  const { t } = useI18n();
  const tone = movementTone(position.movement);
  const movement = movementLabel(position.movement, locale, t("unavailable"));
  const qualified = position.movement?.qualified;
  const showAnalysis = qualified === true;
  return (
    <TableRow key={position.instrumentId}>
      <TableCell>
        <strong>{position.symbol}</strong>
        <div>{position.companyName}</div>
        <div>
          {position.exchange} · {position.currency}
        </div>
      </TableCell>
      <TableCell style={numericStyle}>
        {safeDecimal(position.quantityDecimal, locale)}
      </TableCell>
      <TableCell style={numericStyle}>
        {safeCurrency(
          position.currentRawCloseDecimal,
          position.currency,
          locale,
        )}
      </TableCell>
      <TableCell style={numericStyle}>
        {safeCurrency(position.valuationDecimal, position.currency, locale)}
      </TableCell>
      <TableCell style={{ ...numericStyle, color: movementColor[tone] }}>
        {typeof movement === "string" ? (
          movement
        ) : (
          <VStack gap={0.5} align="end">
            <strong>{movement.percent}%</strong>
            <span>{movement.amount}</span>
            {position.movement && (
              <span>
                {t("previousClose")}:{" "}
                {position.movement.previousRawCloseDecimal === null
                  ? "—"
                  : safeCurrency(
                      position.movement.previousRawCloseDecimal,
                      position.currency,
                      locale,
                    )}
              </span>
            )}
            {position.movement && (
              <span>
                {t("movementBasis")}:{" "}
                {position.movement.basis === "split_adjusted_price_return"
                  ? t("splitAdjustedBasis")
                  : t("legacyBasis")}
              </span>
            )}
            <Badge
              variant={qualified === true ? "success" : "neutral"}
              label={
                qualified === true
                  ? t("qualified")
                  : qualified === false
                    ? t("notQualified")
                    : t("unavailable")
              }
            />
          </VStack>
        )}
      </TableCell>
      <TableCell>
        {position.latestTradingDate
          ? formatDate(position.latestTradingDate, locale)
          : "—"}
      </TableCell>
      <TableCell style={summaryStyle}>
        <VStack gap={1}>
          <span>
            {showAnalysis
              ? (position.summaryZhCn ?? t("summaryUnavailable"))
              : t("summaryNotRequired")}
          </span>
          {showAnalysis && <SourceLinks position={position} />}
        </VStack>
      </TableCell>
      <TableCell>
        <FactStatus
          freshness={position.freshness}
          conflicts={position.conflicts}
          {...(position.analysisStatus
            ? { analysisStatus: position.analysisStatus }
            : {})}
        />
      </TableCell>
    </TableRow>
  );
};

export const PortfolioPage = ({
  apiClient = portfolioApi,
  initialPortfolio,
  today,
}: PortfolioPageProps) => {
  const { locale, t } = useI18n();
  const [portfolio, setPortfolio] = useState<PortfolioReadModelDto | null>(
    initialPortfolio ?? null,
  );
  const portfolioRef = useRef<PortfolioReadModelDto | null>(portfolio);
  const requestIdRef = useRef(0);
  const [loading, setLoading] = useState(initialPortfolio === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    portfolioRef.current = portfolio;
  }, [portfolio]);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const hadCachedPortfolio = portfolioRef.current !== null;
    setLoading(!hadCachedPortfolio);
    setRefreshing(hadCachedPortfolio);
    setError(null);
    const options: PortfolioReadOptions = {
      locale,
      ...(today ? { today } : {}),
    };
    try {
      const result = await apiClient.read(options);
      if (requestId !== requestIdRef.current) return;
      if (result.portfolio) {
        portfolioRef.current = result.portfolio;
        setPortfolio(result.portfolio);
      }
    } catch {
      if (requestId === requestIdRef.current) setError(t("portfolioLoadError"));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [apiClient, locale, t, today]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = () => void load();

  return (
    <VStack gap={4} data-testid="portfolio-page">
      <HStack gap={3} justify="between" align="start" wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>{t("portfolioHeading")}</Heading>
          <div>{t("portfolioIntro")}</div>
          {portfolio && (
            <div>
              {t("asOfDate")}: {formatDate(portfolio.asOfDate, locale)} ·{" "}
              {t("latestTradingDate")}:{" "}
              {portfolio.latestTradingDate
                ? formatDate(portfolio.latestTradingDate, locale)
                : "—"}
            </div>
          )}
        </VStack>
        <Button
          variant="secondary"
          label={refreshing ? t("portfolioRefreshing") : t("refresh")}
          isLoading={refreshing}
          onClick={retry}
        />
      </HStack>

      {error && (
        <Banner
          status="error"
          title={error}
          endContent={
            <Button variant="ghost" label={t("retry")} onClick={retry} />
          }
        />
      )}

      {loading && !portfolio && (
        <Banner status="info" title={t("loadingPortfolio")} />
      )}

      {!loading && !portfolio && !error && (
        <Banner status="info" title={t("noPositions")} />
      )}

      {portfolio && (
        <VStack gap={3}>
          <section aria-labelledby="portfolio-totals-heading">
            <VStack gap={2}>
              <Heading level={2} id="portfolio-totals-heading">
                {t("totals")}
              </Heading>
              <HStack gap={5} wrap="wrap">
                <VStack gap={0.5}>
                  <span>{t("usdTotal")}</span>
                  <strong style={numericStyle}>
                    {safeCurrency(portfolio.totals.USD, "USD", locale)}
                  </strong>
                </VStack>
                <VStack gap={0.5}>
                  <span>{t("cadTotal")}</span>
                  <strong style={numericStyle}>
                    {safeCurrency(portfolio.totals.CAD, "CAD", locale)}
                  </strong>
                </VStack>
                <FactStatus freshness={portfolio.freshness} conflicts={[]} />
              </HStack>
            </VStack>
          </section>

          {portfolio.conflicts.length > 0 && (
            <Banner
              status="warning"
              title={t("portfolioConflict")}
              defaultIsExpanded
            >
              <VStack gap={1}>
                {portfolio.conflicts.map((conflict, index) => (
                  <div
                    key={`${conflict.code}-${conflict.instrumentId ?? index}`}
                  >
                    {conflict.message}
                  </div>
                ))}
              </VStack>
            </Banner>
          )}

          {portfolio.positions.length === 0 ? (
            <Banner status="info" title={t("noPositions")} />
          ) : (
            <section aria-labelledby="portfolio-positions-heading">
              <VStack gap={2}>
                <Heading level={2} id="portfolio-positions-heading">
                  {t("positions")}
                </Heading>
                <Table
                  density="compact"
                  dividers="rows"
                  hasHover
                  textOverflow="wrap"
                  aria-label={t("positions")}
                >
                  <TableHeader>
                    <TableRow isHeaderRow>
                      <TableHeaderCell>{t("instrument")}</TableHeaderCell>
                      <TableHeaderCell style={numericStyle}>
                        {t("quantity")}
                      </TableHeaderCell>
                      <TableHeaderCell style={numericStyle}>
                        {t("rawClose")}
                      </TableHeaderCell>
                      <TableHeaderCell style={numericStyle}>
                        {t("valuation")}
                      </TableHeaderCell>
                      <TableHeaderCell style={numericStyle}>
                        {t("movement")}
                      </TableHeaderCell>
                      <TableHeaderCell>
                        {t("actualTradingDate")}
                      </TableHeaderCell>
                      <TableHeaderCell>{t("summary")}</TableHeaderCell>
                      <TableHeaderCell>{t("freshness")}</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {portfolio.positions.map((position) => (
                      <PositionRow
                        key={position.instrumentId}
                        position={position}
                        locale={locale}
                      />
                    ))}
                  </TableBody>
                </Table>
              </VStack>
            </section>
          )}
        </VStack>
      )}
    </VStack>
  );
};
