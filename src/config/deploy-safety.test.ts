import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultPortfolioFeatureFlags,
  parseFeatureFlag,
  readPortfolioFeatureFlags,
} from "./features";

const readJsonc = (path: string) =>
  JSON.parse(
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, ""),
  ) as WranglerConfig;

type QueueProducer = { binding: string; queue: string };
type QueueConsumer = {
  queue: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  dead_letter_queue?: string;
  max_concurrency?: number;
  visibility_timeout_ms?: number;
  retry_delay?: number;
};
type WranglerConfig = {
  name: string;
  vars?: Record<string, string>;
  secrets?: { required?: string[] };
  assets?: { binding?: string };
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id?: string;
  }>;
  ai?: { binding?: string; remote?: boolean };
  queues?: {
    producers?: QueueProducer[];
    consumers?: QueueConsumer[];
  };
  triggers?: { crons?: string[] };
};

const flagKeys = [
  "PORTFOLIO_DUAL_WRITE_ENABLED",
  "PORTFOLIO_MIGRATOR_ENABLED",
  "PORTFOLIO_NEW_READS_ENABLED",
  "PORTFOLIO_NEW_WRITES_ENABLED",
] as const;

describe("deployment safety", () => {
  it("keeps cutover flags disabled by default and rejects arbitrary truthy strings", () => {
    expect(defaultPortfolioFeatureFlags).toEqual({
      dualWrite: false,
      migrator: false,
      newReads: false,
      newWrites: false,
    });
    expect(parseFeatureFlag(true)).toBe(true);
    expect(parseFeatureFlag("true")).toBe(true);
    for (const value of ["TRUE", "1", "on", "enabled", 1, {}, []]) {
      expect(parseFeatureFlag(value)).toBe(false);
    }
    expect(readPortfolioFeatureFlags({})).toEqual(defaultPortfolioFeatureFlags);
    expect(
      readPortfolioFeatureFlags({
        PORTFOLIO_DUAL_WRITE_ENABLED: "true",
        PORTFOLIO_MIGRATOR_ENABLED: "on",
        PORTFOLIO_NEW_READS_ENABLED: true,
        PORTFOLIO_NEW_WRITES_ENABLED: "false",
      }),
    ).toEqual({
      dualWrite: true,
      migrator: false,
      newReads: true,
      newWrites: false,
    });
  });

  it("keeps production and test bindings separated while preserving legacy bindings", () => {
    const production = readJsonc("wrangler.jsonc");
    const test = readJsonc("wrangler.test.jsonc");
    const productionProducers = production.queues?.producers ?? [];
    const testProducers = test.queues?.producers ?? [];
    const productionProducer = (binding: string) =>
      productionProducers.find((candidate) => candidate.binding === binding);
    const testProducer = (binding: string) =>
      testProducers.find((candidate) => candidate.binding === binding);

    expect(production.name).not.toBe(test.name);
    expect(production.assets?.binding).toBe("ASSETS");
    expect(production.ai).toEqual({ binding: "AI", remote: true });
    expect(production.secrets?.required).toEqual([
      "BASIC_AUTH_USERNAME",
      "BASIC_AUTH_PASSWORD",
      "ALPHA_VANTAGE_API_KEY",
      "SEC_USER_AGENT",
    ]);
    expect(production.d1_databases).toEqual([
      expect.objectContaining({
        binding: "DB",
        database_name: "stock-tracker",
      }),
    ]);
    expect(test.d1_databases).toEqual([
      expect.objectContaining({
        binding: "DB",
        database_name: "stock-tracker-test",
      }),
    ]);

    expect(productionProducer("SCREENING_QUEUE")).toEqual({
      binding: "SCREENING_QUEUE",
      queue: "stock-tracker-screenings",
    });
    expect(testProducer("SCREENING_QUEUE")).toEqual({
      binding: "SCREENING_QUEUE",
      queue: "stock-tracker-screenings-test",
    });
    expect(productionProducer("NORMALIZED_WORK_QUEUE")).toEqual({
      binding: "NORMALIZED_WORK_QUEUE",
      queue: "stock-tracker-normalized-work",
    });
    expect(testProducer("NORMALIZED_WORK_QUEUE")).toEqual({
      binding: "NORMALIZED_WORK_QUEUE",
      queue: "stock-tracker-normalized-work-test",
    });
    expect(productionProducer("NORMALIZED_WORK_DLQ")).toEqual({
      binding: "NORMALIZED_WORK_DLQ",
      queue: "stock-tracker-normalized-work-dlq",
    });
    expect(testProducer("NORMALIZED_WORK_DLQ")).toEqual({
      binding: "NORMALIZED_WORK_DLQ",
      queue: "stock-tracker-normalized-work-dlq-test",
    });
    for (const binding of [
      "SCREENING_QUEUE",
      "NORMALIZED_WORK_QUEUE",
      "NORMALIZED_WORK_DLQ",
    ]) {
      expect(productionProducer(binding)?.queue).not.toBe(
        testProducer(binding)?.queue,
      );
    }

    const productionWorkConsumer = production.queues?.consumers?.find(
      (consumer) => consumer.queue === "stock-tracker-normalized-work",
    );
    const testWorkConsumer = test.queues?.consumers?.find(
      (consumer) => consumer.queue === "stock-tracker-normalized-work-test",
    );
    expect(productionWorkConsumer).toMatchObject({
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 3,
      dead_letter_queue: "stock-tracker-normalized-work-dlq",
      max_concurrency: 5,
      visibility_timeout_ms: 600000,
      retry_delay: 30,
    });
    expect(testWorkConsumer).toMatchObject({
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 3,
      dead_letter_queue: "stock-tracker-normalized-work-dlq-test",
      max_concurrency: 5,
      visibility_timeout_ms: 600000,
      retry_delay: 30,
    });
  });

  it("keeps writes and migration off while production reads are enabled", () => {
    const production = readJsonc("wrangler.jsonc");
    const test = readJsonc("wrangler.test.jsonc");
    expect(production.vars?.PORTFOLIO_NEW_READS_ENABLED).toBe("true");
    expect(production.vars?.CALENDAR_READ_MODELS_ENABLED).toBe("true");
    expect(production.vars?.JOB_READ_MODELS_ENABLED).toBe("true");
    for (const config of [production, test]) {
      for (const key of flagKeys.filter(
        (candidate) => candidate !== "PORTFOLIO_NEW_READS_ENABLED",
      )) {
        expect(config.vars?.[key]).toBe("false");
      }
    }
    expect(test.vars?.PORTFOLIO_NEW_READS_ENABLED).toBe("false");
  });

  it("covers both Toronto 4:30 p.m. UTC candidates and the 15-minute dispatcher", () => {
    const expectedCrons = [
      "0 22 * * MON-FRI",
      "30 20 * * MON-FRI",
      "30 21 * * MON-FRI",
      "*/15 * * * *",
    ];
    for (const config of [
      readJsonc("wrangler.jsonc"),
      readJsonc("wrangler.test.jsonc"),
    ]) {
      expect(config.triggers?.crons).toEqual(expectedCrons);
    }
  });

  it("keeps Worker integration tests off the production Wrangler config", () => {
    const config = readFileSync("vitest.worker.config.ts", "utf8");

    expect(config).not.toContain('configPath: "./wrangler.jsonc"');
    expect(config).toContain('configPath: "./wrangler.test.jsonc"');
  });
});
