import {
  Badge,
  Button,
  EmptyState,
  Heading,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core";
import { useCallback, useEffect, useState } from "react";
import type { PortfolioImportStatusDto } from "../../shared/contracts";
import type { ImportError } from "../api";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/I18nProvider";
import { formatDateTime } from "../system/formatters";

interface PortfolioImportsSectionProps {
  imports: PortfolioImportStatusDto[];
  highlightedImportId?: string;
  loadErrors: (
    importId: string,
    cursor?: string,
  ) => Promise<{ errors: ImportError[]; nextCursor: string | null }>;
}

const badgeVariant = (status: PortfolioImportStatusDto["status"]) => {
  switch (status) {
    case "committed":
      return "success" as const;
    case "complete_with_errors":
      return "warning" as const;
    case "terminal":
    case "expired":
      return "error" as const;
    case "pending":
    case "running":
      return "info" as const;
  }
};

const statusKey = (status: PortfolioImportStatusDto["status"]): MessageKey => {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "committed":
      return "complete";
    case "complete_with_errors":
      return "completeWithErrors";
    case "terminal":
      return "terminal";
    case "expired":
      return "expired";
  }
};

export const PortfolioImportsSection = ({
  imports,
  highlightedImportId,
  loadErrors,
}: PortfolioImportsSectionProps) => {
  const { locale, t } = useI18n();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(
    async (importId: string, nextCursor?: string) => {
      setLoading(true);
      setLoadFailed(false);
      try {
        const result = await loadErrors(importId, nextCursor);
        setErrors((current) =>
          nextCursor ? [...current, ...result.errors] : result.errors,
        );
        setCursor(result.nextCursor);
        setLoadedFor(importId);
      } catch {
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [loadErrors],
  );

  useEffect(() => {
    const selected = imports.find(({ id }) => id === expandedId);
    if (
      !selected ||
      (selected.failedRows === 0 && selected.status !== "terminal") ||
      loadedFor === selected.id
    )
      return;
    void load(selected.id);
  }, [expandedId, imports, load, loadedFor]);

  return (
    <section className="status-jobs" aria-labelledby="portfolio-imports-title">
      <div className="status-section-heading">
        <Heading level={2} id="portfolio-imports-title">
          {t("portfolioImports")}
        </Heading>
        <span className="status-jobs__count">{imports.length}</span>
      </div>
      {imports.length > 0 ? (
        <Table
          tableProps={{ className: "status-job-table" }}
          density="compact"
          dividers="rows"
          textOverflow="wrap"
          aria-label={t("portfolioImports")}
        >
          <TableHeader>
            <TableRow isHeaderRow>
              <TableHeaderCell>{t("importFile")}</TableHeaderCell>
              <TableHeaderCell>{t("status")}</TableHeaderCell>
              <TableHeaderCell>{t("symbolProgress")}</TableHeaderCell>
              <TableHeaderCell>{t("failedRows")}</TableHeaderCell>
              <TableHeaderCell>{t("lastActivity")}</TableHeaderCell>
              <TableHeaderCell>{t("actions")}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {imports.map((entry) => (
              <TableRow
                key={entry.id}
                data-import-highlighted={
                  entry.id === highlightedImportId ? "true" : undefined
                }
              >
                <TableCell>
                  <strong>{entry.filename}</strong>
                  <div className="status-job-table__identity-meta">
                    <span>
                      {t("importStarted")}:{" "}
                      {formatDateTime(entry.createdAt, locale)}
                    </span>
                    {entry.completedAt && (
                      <span>
                        {t("importCompleted")}:{" "}
                        {formatDateTime(entry.completedAt, locale)}
                      </span>
                    )}
                  </div>
                  {(entry.terminalErrorMessage || entry.terminalErrorCode) && (
                    <div className="status-source-row__error" role="alert">
                      {entry.terminalErrorMessage ?? entry.terminalErrorCode}
                      {entry.terminalErrorMessage && entry.terminalErrorCode
                        ? ` (${entry.terminalErrorCode})`
                        : ""}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={badgeVariant(entry.status)}
                    label={t(statusKey(entry.status))}
                  />
                </TableCell>
                <TableCell>
                  {entry.processedSymbols} / {entry.totalSymbols}
                </TableCell>
                <TableCell>{entry.failedRows}</TableCell>
                <TableCell>{formatDateTime(entry.updatedAt, locale)}</TableCell>
                <TableCell>
                  <div className="status-import-actions">
                    {(entry.failedRows > 0 || entry.status === "terminal") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        label={t("viewErrorDetails")}
                        onClick={() => {
                          const opening = expandedId !== entry.id;
                          setExpandedId(opening ? entry.id : null);
                          if (opening) {
                            setErrors([]);
                            setCursor(null);
                            setLoadedFor(null);
                          }
                        }}
                      />
                    )}
                    {entry.status === "committed" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        label={t("portfolioEventsLink")}
                        href="/events"
                      />
                    )}
                  </div>
                  {entry.resultPipelineJobId && (
                    <div>
                      {t("reconciliationJob")}: {entry.resultPipelineJobId}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState title={t("noPortfolioImports")} />
      )}
      {expandedId && (
        <div className="status-import-errors" aria-live="polite">
          <Heading level={3}>{t("importErrorDetails")}</Heading>
          {loadFailed ? (
            <p role="alert">{t("statusLoadError")}</p>
          ) : errors.length === 0 && !loading ? (
            <p>{t("notAvailable")}</p>
          ) : (
            <ul>
              {errors.map((entry) => (
                <li
                  key={`${entry.source}-${entry.rowNumber ?? entry.symbol}-${entry.code}`}
                >
                  {entry.rowNumber ? `${t("row")} ${entry.rowNumber} · ` : ""}
                  {entry.symbol} · {entry.code}
                  {entry.message ? ` — ${entry.message}` : ""}
                </li>
              ))}
            </ul>
          )}
          {cursor && (
            <Button
              variant="secondary"
              label={t("loadMore")}
              isLoading={loading}
              isDisabled={loading}
              onClick={() => void load(expandedId, cursor)}
            />
          )}
        </div>
      )}
    </section>
  );
};
