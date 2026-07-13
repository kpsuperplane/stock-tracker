import { Skeleton } from "@astryxdesign/core";

export const PortfolioSkeleton = () => (
  <div className="portfolio-skeleton" aria-hidden="true">
    <div className="portfolio-summary-strip">
      {[0, 1, 2, 3].map((index) => (
        <div className="portfolio-summary-item" key={index}>
          <Skeleton width="45%" height={12} index={index} radius={1} />
          <Skeleton width="72%" height={26} index={index + 1} radius={1} />
          <Skeleton width="55%" height={12} index={index + 2} radius={1} />
        </div>
      ))}
    </div>
    <Skeleton width="100%" height={360} index={4} radius={1} />
    <Skeleton width="100%" height={180} index={5} radius={1} />
  </div>
);
