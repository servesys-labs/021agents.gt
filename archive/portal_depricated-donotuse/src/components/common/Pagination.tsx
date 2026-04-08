type PaginationProps = {
  offset: number;
  limit: number;
  onOffsetChange: (offset: number) => void;
  onLimitChange: (limit: number) => void;
  /** Available page size options. Defaults to [25, 50, 100]. */
  limitOptions?: number[];
};

export function Pagination({
  offset,
  limit,
  onOffsetChange,
  onLimitChange,
  limitOptions = [25, 50, 100],
}: PaginationProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        className="btn btn-secondary text-xs"
        disabled={offset === 0}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
      >
        Previous
      </button>
      <button
        className="btn btn-secondary text-xs"
        onClick={() => onOffsetChange(offset + limit)}
      >
        Next
      </button>
      <select
        className="text-xs w-auto"
        value={limit}
        onChange={(e) => {
          onLimitChange(Number(e.target.value));
          onOffsetChange(0);
        }}
      >
        {limitOptions.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  );
}
