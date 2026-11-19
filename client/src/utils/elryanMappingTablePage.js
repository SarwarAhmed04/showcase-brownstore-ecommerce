/** Numbered page window for an Elryan mapping table. */

export function elryanMappingPageItems(page, pages) {
  const current = Math.max(1, Number(page) || 1);
  const last = Math.max(1, Number(pages) || 1);
  const wanted = [1, last, current - 2, current - 1, current, current + 1, current + 2]
    .filter((value, index, all) => value >= 1 && value <= last && all.indexOf(value) === index)
    .sort((left, right) => left - right);
  const items = [];
  let previous = 0;
  for (const value of wanted) {
    if (previous && value - previous > 1) items.push({ type: "gap", key: `gap-${value}` });
    items.push({ type: "page", page: value, key: `page-${value}` });
    previous = value;
  }
  return items;
}
