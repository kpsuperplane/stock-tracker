import {
  Banner,
  Button,
  Dialog,
  DialogHeader,
  FileInput,
  FormLayout,
  HStack,
  Icon,
  VStack,
} from "@astryxdesign/core";
import { useState } from "react";
import {
  ApiClientError,
  type EventImportsApiClient,
  eventImportsApi,
  type ImportStartResponse,
} from "../api";
import { useI18n } from "../i18n/I18nProvider";

export interface EventImportDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  apiClient?: EventImportsApiClient;
  onAccepted?: (result: ImportStartResponse) => void;
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

export const EventImportDialog = ({
  isOpen,
  onOpenChange,
  apiClient = eventImportsApi,
  onAccepted,
}: EventImportDialogProps) => {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const close = (open: boolean) => {
    if (!open) {
      setFile(null);
      setError(null);
      setIsImporting(false);
    }
    onOpenChange(open);
  };

  const startImport = async () => {
    if (!file) {
      setError(t("chooseCsvFile"));
      return;
    }
    setError(null);
    setIsImporting(true);
    try {
      const result = await apiClient.start(file);
      onAccepted?.(result);
      close(false);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError && caught.message
          ? caught.message
          : t("invalidCsv"),
      );
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={close}
      purpose="form"
      width="min(620px, calc(100vw - 2rem))"
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
              setFile(Array.isArray(next) ? (next[0] ?? null) : next);
              setError(null);
            }}
            accept=".csv,text/csv,application/csv,text/plain"
            mode="dropzone"
            placeholder={t("chooseFile")}
            description={t("csvTemplateDescription")}
            isDisabled={isImporting}
            isRequired
          />
          <Button
            variant="ghost"
            label={t("csvTemplate")}
            href="/templates/portfolio-events.csv"
            target="_blank"
            rel="noreferrer"
          />
        </FormLayout>
        {error && <Banner status="error" title={error} />}
        <HStack gap={2} justify="end" wrap="wrap">
          <Button
            variant="ghost"
            label={t("cancel")}
            isDisabled={isImporting}
            onClick={() => close(false)}
          />
          <Button
            variant="primary"
            label={isImporting ? t("importingCsv") : t("importCsv")}
            isLoading={isImporting}
            isDisabled={!file || isImporting}
            onClick={() => void startImport()}
          />
        </HStack>
      </VStack>
    </Dialog>
  );
};
