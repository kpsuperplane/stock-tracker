import {
  Banner,
  Button,
  Heading,
  HStack,
  Icon,
  Popover,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@astryxdesign/core";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  PortfolioMovementDto,
  PortfolioPositionDto,
  PortfolioReadModelDto,
} from "../../shared/contracts";
import {
  ApiClientError,
  type PortfolioApiClient,
  type PortfolioReadOptions,
  portfolioApi,
} from "../api";
import { RefreshIcon } from "../components/ProductIcons";
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

const formatSignedCurrency = (
  value: string | null,
  currency: "CAD" | "USD",
  locale: "en" | "cn",
): string => {
  if (value === null) return "—";
  const trimmed = value.trim();
  const sign = trimmed.startsWith("-") ? "-" : "+";
  const absolute = trimmed.replace(/^[+-]/, "");
  if (/^0(?:\.0*)?$/.test(absolute)) {
    return safeCurrency("0", currency, locale);
  }
  return `${sign}${safeCurrency(absolute, currency, locale)}`;
};

export const formatSignedDecimal = (
  value: string | null,
  locale: "en" | "cn",
  maximumFractionDigits = 2,
): string => {
  if (value === null) return "—";
  if (/^[+-]?0(?:\.0*)?$/.test(value.trim())) {
    const zero =
      maximumFractionDigits > 0
        ? `0.${"0".repeat(maximumFractionDigits)}`
        : "0";
    return safeDecimal(zero, locale, maximumFractionDigits);
  }
  const formatted = safeDecimal(value, locale, maximumFractionDigits);
  if (formatted === "—" || formatted.startsWith("-")) return formatted;
  return `+${formatted}`;
};

export const movementTone = (
  movement: PortfolioMovementDto | null,
): "positive" | "negative" | "neutral" => {
  if (!movement?.movementPercentDecimal) return "neutral";
  const value = movement.movementPercentDecimal.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) return "neutral";
  if (/^[+-]?0(?:\.0*)?$/.test(value)) return "neutral";
  return value.startsWith("-") ? "negative" : "positive";
};

export const portfolioErrorMessageKey = (
  error: unknown,
): "portfolioReadModelDisabled" | "portfolioLoadError" =>
  error instanceof ApiClientError && error.code === "read_model_disabled"
    ? "portfolioReadModelDisabled"
    : "portfolioLoadError";

const movementColor = {
  positive: "var(--color-success)",
  negative: "var(--color-error)",
  neutral: "var(--color-text-secondary)",
} as const;

const movementLabel = (
  movement: PortfolioMovementDto | null,
  currency: "CAD" | "USD",
  locale: "en" | "cn",
  emptyLabel: string,
) => {
  if (!movement) return emptyLabel;
  const amount = formatSignedCurrency(
    movement.movementAmountDecimal,
    currency,
    locale,
  );
  const percent = formatSignedDecimal(
    movement.movementPercentDecimal,
    locale,
    2,
  );
  return { amount, percent };
};

const movementPercentValue = (
  position: PortfolioPositionDto,
): number | null => {
  const raw = position.movement?.movementPercentDecimal?.trim();
  if (!raw || !/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

export const sortPortfolioPositions = (
  positions: PortfolioPositionDto[],
): PortfolioPositionDto[] =>
  [...positions].sort((left, right) => {
    const leftValue = movementPercentValue(left);
    const rightValue = movementPercentValue(right);
    if (leftValue === null) return rightValue === null ? 0 : 1;
    if (rightValue === null) return -1;
    return rightValue - leftValue;
  });

type PositionSource = PortfolioPositionDto["sources"][number] & {
  sourceUrl: string;
};

const sourcesForPosition = (position: PortfolioPositionDto): PositionSource[] =>
  position.sources.filter(
    (source): source is PositionSource => source.sourceUrl !== null,
  );

const SourceLinks = ({ sources }: { sources: PositionSource[] }) => {
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

const SourcesButton = ({ position }: { position: PortfolioPositionDto }) => {
  const { t } = useI18n();
  const sources = sourcesForPosition(position);
  if (sources.length === 0) return null;
  return (
    <Popover
      label={t("sources")}
      width="min(28rem, calc(100vw - 2rem))"
      content={<SourceLinks sources={sources} />}
    >
      <Button
        variant="ghost"
        size="sm"
        label={t("sources")}
        tooltip={t("sources")}
        icon={<Icon icon="externalLink" size="sm" />}
      />
    </Popover>
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
  const movement = movementLabel(
    position.movement,
    position.currency,
    locale,
    t("unavailable"),
  );
  const summary = position.summaryZhCn?.trim();
  const hasAnalysis = Boolean(summary);
  return (
    <Fragment key={position.instrumentId}>
      <TableRow>
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
            <HStack gap={1} justify="end" wrap="nowrap">
              <strong>{movement.percent}%</strong>
              <span>{movement.amount}</span>
            </HStack>
          )}
        </TableCell>
      </TableRow>
      {hasAnalysis && (
        <TableRow>
          <TableCell
            colSpan={5}
            style={{
              color: "var(--color-text-secondary)",
              background: "var(--color-background-muted)",
            }}
          >
            <HStack gap={2} align="start" wrap="wrap">
              <span>{summary}</span>
              <SourcesButton position={position} />
            </HStack>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
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
  const [readModelDisabled, setReadModelDisabled] = useState(false);

  useEffect(() => {
    portfolioRef.current = portfolio;
  }, [portfolio]);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const hadCachedPortfolio = portfolioRef.current !== null;
    setLoading(!hadCachedPortfolio);
    setRefreshing(hadCachedPortfolio);
    setError(null);
    setReadModelDisabled(false);
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
    } catch (caught) {
      if (requestId === requestIdRef.current) {
        const messageKey = portfolioErrorMessageKey(caught);
        setReadModelDisabled(messageKey === "portfolioReadModelDisabled");
        setError(t(messageKey));
      }
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
    <VStack gap={3} data-testid="portfolio-page">
      <HStack gap={3} justify="between" align="start" wrap="wrap">
        <VStack gap={0.5}>
          <Heading level={1}>{t("portfolioHeading")}</Heading>
          {portfolio && (
            <div className="product-page-meta">
              {formatDate(portfolio.asOfDate, locale)} · {t("latestClose")}{" "}
              {portfolio.latestTradingDate
                ? formatDate(portfolio.latestTradingDate, locale)
                : "—"}
            </div>
          )}
        </VStack>
        <Button
          variant="secondary"
          size="sm"
          label={refreshing ? t("portfolioRefreshing") : t("refresh")}
          tooltip={refreshing ? t("portfolioRefreshing") : t("refresh")}
          icon={<Icon icon={RefreshIcon} size="sm" />}
          isIconOnly
          isLoading={refreshing}
          onClick={retry}
        />
      </HStack>

      {error && (
        <Banner
          status="error"
          title={error}
          {...(readModelDisabled
            ? {
                description: t("portfolioReadModelDisabledDescription"),
              }
            : {})}
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
        <VStack gap={2}>
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
            <section aria-label={t("positions")}>
              <Table
                tableProps={{ className: "product-portfolio-table" }}
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortPortfolioPositions(portfolio.positions).map(
                    (position) => (
                      <PositionRow
                        key={position.instrumentId}
                        position={position}
                        locale={locale}
                      />
                    ),
                  )}
                </TableBody>
              </Table>
            </section>
          )}
        </VStack>
      )}
    </VStack>
  );
};
