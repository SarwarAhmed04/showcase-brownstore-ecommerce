export function formatCount(value) {
  return Number(value || 0).toLocaleString("en-US");
}

export function reasonLabel(t, reason) {
  const code = typeof reason === "string" ? reason : reason?.code;
  const labels = {
    platform_inactive: t.reasonPlatformInactive,
    category_inactive: t.reasonCategoryInactive,
    subcategory_inactive: t.reasonSubcategoryInactive,
    collection_inactive: t.reasonCollectionInactive,
    brand_inactive: t.reasonBrandInactive,
    vendor_inactive: t.reasonVendorInactive,
    product_inactive: t.reasonProductInactive,
    taxonomy_config_missing:
      String(reason?.message || "").includes("Gini")
        ? t.reasonGiniTaxonomyMissing
        : t.reasonMappingMissing,
  };
  return labels[code] || reason?.message || code || "";
}

const BADGE = {
  ready: "bg-emerald-50 text-emerald-800",
  active: "bg-emerald-50 text-emerald-800",
  blocked: "bg-red-50 text-red-800",
  inactive: "bg-brown/10 text-brown/55",
  unmapped: "bg-amber-50 text-amber-900",
  missing_setup: "bg-amber-50 text-amber-900",
};

export function StatusBadge({ kind, t, children }) {
  const labels = {
    ready: t.ready,
    active: t.commissionActive,
    blocked: t.blocked,
    inactive: t.commissionInactive,
    unmapped: t.unmapped,
    missing_setup: t.unmapped,
  };
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${BADGE[kind] || BADGE.blocked}`}>
      {children || labels[kind] || kind}
    </span>
  );
}

export function Pager({ page, pages, onPage }) {
  if (!pages || pages <= 1) return null;
  const items = [];
  for (let n = 1; n <= pages; n += 1) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 2) items.push(n);
  }
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {items.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onPage(n)}
          className={`h-9 min-w-9 rounded-full px-3 text-sm font-semibold ${
            n === page ? "bg-brown text-cream" : "bg-cream text-brown"
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
