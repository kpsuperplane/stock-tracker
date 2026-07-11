import { Badge, VStack } from "@astryxdesign/core";
import type {
  PortfolioConflictDto,
  PortfolioPositionDto,
} from "../../shared/contracts";
import { useI18n } from "../i18n/I18nProvider";

export type FactFreshness = PortfolioPositionDto["freshness"];

export const freshnessBadgeVariant = (
  freshness: FactFreshness,
): "neutral" | "success" | "warning" | "error" => {
  switch (freshness) {
    case "fresh":
      return "success";
    case "stale":
      return "warning";
    case "error":
      return "error";
    case "pending":
      return "warning";
    default:
      return "neutral";
  }
};

export interface FactStatusProps {
  freshness: FactFreshness;
  conflicts?: PortfolioConflictDto[];
  analysisStatus?: NonNullable<PortfolioPositionDto["analysisStatus"]>;
}

export const FactStatus = ({
  freshness,
  conflicts = [],
  analysisStatus,
}: FactStatusProps) => {
  const { t } = useI18n();
  return (
    <VStack gap={1} align="start">
      <Badge variant={freshnessBadgeVariant(freshness)} label={t(freshness)} />
      {analysisStatus && analysisStatus !== "complete" && (
        <Badge
          variant={freshnessBadgeVariant(analysisStatus as FactFreshness)}
          label={t(analysisStatus)}
        />
      )}
      {conflicts.length > 0 && (
        <VStack gap={0.5}>
          {conflicts.map((conflict, index) => (
            <span key={`${conflict.code}-${conflict.effectiveDate ?? index}`}>
              {conflict.message}
            </span>
          ))}
        </VStack>
      )}
    </VStack>
  );
};
