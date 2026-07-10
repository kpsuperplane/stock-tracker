import type { MoverDto } from "../../shared/contracts";
import { MoverCard } from "./MoverCard";

export const MoverTable = ({
  label,
  movers,
}: {
  label: string;
  movers: MoverDto[];
}) => (
  <div className="table-scroll">
    <table className="portfolio-table mover-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">标的</th>
          <th scope="col">收盘价</th>
          <th scope="col">日涨跌</th>
          <th scope="col">异动说明</th>
          <th scope="col">来源 / 操作</th>
        </tr>
      </thead>
      <tbody>
        {movers.map((mover) => (
          <MoverCard key={mover.screeningId} mover={mover} />
        ))}
      </tbody>
    </table>
  </div>
);
