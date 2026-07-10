import type { RunRepository, ScreeningWork } from "../db/runs";
import { calculateMovement, selectComparison } from "../domain/market";
import type { ExplanationProvider } from "../providers/explanations";
import type { MarketDataProvider } from "../providers/market-data";
import type { NewsProvider } from "../providers/news";

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const easternCloseUtc = (date: string) => {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const zoneName =
    new Intl.DateTimeFormat("en", {
      timeZone: "America/Toronto",
      timeZoneName: "shortOffset",
    })
      .formatToParts(noonUtc)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT-4";
  const match = zoneName.match(/GMT([+-])(\d{1,2})/);
  const offsetHours = match
    ? (match[1] === "+" ? 1 : -1) * Number(match[2])
    : -4;
  return new Date(
    Date.UTC(
      noonUtc.getUTCFullYear(),
      noonUtc.getUTCMonth(),
      noonUtc.getUTCDate(),
      16 - offsetHours,
    ),
  ).toISOString();
};

type Repository = Pick<
  RunRepository,
  | "claimScreening"
  | "savePrice"
  | "saveSources"
  | "saveAnalysis"
  | "completeWithoutAnalysis"
  | "markNoTradingData"
  | "markFailed"
>;

export class ScreeningService {
  constructor(
    private readonly repository: Repository,
    private readonly market: MarketDataProvider,
    private readonly news: NewsProvider,
    private readonly explanations: ExplanationProvider,
  ) {}

  private async analyze(
    work: ScreeningWork,
    previousDate: string,
    changePct: number,
    now: string,
  ) {
    const sources = await this.news.search({
      symbol: work.symbol,
      companyName: work.companyName,
      publishedAfter: easternCloseUtc(previousDate),
      publishedBefore: new Date(
        Date.parse(easternCloseUtc(work.targetDate)) + 2 * 3_600_000,
      ).toISOString(),
    });
    await this.repository.saveSources(work.id, sources);
    const result = await this.explanations.explain({
      symbol: work.symbol,
      companyName: work.companyName,
      changePct,
      sources,
    });
    await this.repository.saveAnalysis(work.id, result, now);
  }

  async process(screeningId: string, now: string): Promise<string | null> {
    const work = await this.repository.claimScreening(screeningId, now);
    if (!work) return null;
    if (
      work.qualified === true &&
      work.previousDate !== null &&
      work.previousPrice !== null &&
      work.currentPrice !== null &&
      work.changeAmount !== null &&
      work.changePct !== null &&
      work.priceBasis !== null
    ) {
      await this.analyze(work, work.previousDate, work.changePct, now);
      return work.reportRunId;
    }
    const series = await this.market.getInstrument(
      work.symbol,
      addDays(work.targetDate, -10),
      addDays(work.targetDate, 1),
    );
    const comparison = selectComparison(series, work.targetDate);
    if (!comparison.ok) {
      await this.repository.markNoTradingData(work.id, comparison.code);
      return work.reportRunId;
    }
    const movement = calculateMovement(comparison);
    await this.repository.savePrice(work.id, {
      previousDate: comparison.previousDate,
      previousPrice: comparison.previousPrice,
      currentPrice: comparison.currentPrice,
      changeAmount: movement.changeAmount,
      changePct: movement.changePct,
      priceBasis: comparison.priceBasis,
      qualified: movement.qualified,
    });
    if (!movement.qualified) {
      await this.repository.completeWithoutAnalysis(work.id);
      return work.reportRunId;
    }
    await this.analyze(work, comparison.previousDate, movement.changePct, now);
    return work.reportRunId;
  }
}
