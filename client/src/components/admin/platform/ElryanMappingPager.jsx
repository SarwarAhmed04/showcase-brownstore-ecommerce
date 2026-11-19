import { elryanMappingPageItems } from "../../../utils/elryanMappingTablePage";

const BUTTON =
  "rounded-full px-3 py-1.5 font-semibold text-brown/70 disabled:opacity-40";
const CURRENT =
  "rounded-full bg-brown px-3 py-1.5 font-semibold text-cream";

export default function ElryanMappingPager({
  t,
  page = 1,
  pages = 1,
  total = 0,
  limit = 25,
  busy = false,
  numbered = true,
  hasPrevious,
  hasNext,
  onPage,
  onLimit,
}) {
  const current = Math.max(1, Number(page) || 1);
  const last = Math.max(1, Number(pages) || 1);
  const previousEnabled = hasPrevious ?? current > 1;
  const nextEnabled = hasNext ?? current < last;
  const items = numbered ? elryanMappingPageItems(current, last) : [];
  const countLabel = (t?.elryanMappingMatchCount || "{count} matching rows").replace(
    "{count}",
    String(total ?? 0)
  );

  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-3 text-sm"
      aria-label={t?.elryanMappingPagerLabel || "Pagination"}
      data-elryan-mapping-pager="true"
      data-page={current}
      data-pages={last}
      data-total={total ?? 0}
      data-limit={limit}
    >
      <p className="font-semibold text-brown/70">{countLabel}</p>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={BUTTON}
          disabled={busy || !previousEnabled}
          onClick={() => onPage(current - 1)}
        >
          {t?.pagePrevious || "Previous"}
        </button>
        {items.map((item) =>
          item.type === "gap" ? (
            <span key={item.key} className="px-1 text-brown/40" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={item.key}
              type="button"
              className={item.page === current ? CURRENT : BUTTON}
              aria-current={item.page === current ? "page" : undefined}
              disabled={busy || item.page === current}
              onClick={() => onPage(item.page)}
            >
              {item.page}
            </button>
          )
        )}
        <button
          type="button"
          className={BUTTON}
          disabled={busy || !nextEnabled}
          onClick={() => onPage(current + 1)}
        >
          {t?.pageNext || "Next"}
        </button>
      </div>
      <label className="font-semibold text-brown/70">
        {t?.elryanMappingPageSize || "Rows per page"}
        <select
          className="ms-2 rounded-full border border-brown/10 bg-cream px-3 py-1.5 text-sm font-semibold text-brown"
          value={limit}
          disabled={busy}
          aria-label={t?.elryanMappingPageSize || "Rows per page"}
          onChange={(event) => onLimit(Number(event.target.value))}
        >
          <option value={25}>25</option>
          <option value={50}>50</option>
        </select>
      </label>
    </nav>
  );
}
