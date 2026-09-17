import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useLang } from "../context/LangContext";
import { adaptCategory, adaptProduct } from "./catalog";
import { getCookie } from "./cookies";

const CatalogContext = createContext(null);

function savedIds() {
  try {
    const raw = JSON.parse(getCookie("bs:saved") || "[]");
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    return [];
  }
}

export function CatalogProvider({ children }) {
  const { lang } = useLang();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [previews, setPreviews] = useState({});
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setStatus("loading");
      try {
        const ids = savedIds();
        const [catRes, list, deals, saved] = await Promise.all([
          api.categories(),
          api.products({ limit: 48, sort: "newest" }),
          api.products({ deals: 1, limit: 48, sort: "newest" }),
          ids.length ? api.products({ ids: ids.join(","), limit: 48 }) : Promise.resolve({ products: [] }),
        ]);

        const cats = (catRes.categories || []).map((c, i) => adaptCategory(c, lang, i));
        const merged = new Map();
        for (const row of [...(list.products || []), ...(deals.products || []), ...(saved.products || [])]) {
          const item = adaptProduct(row, lang);
          if (item) merged.set(item.id, item);
        }

        setCategories(cats);
        setProducts([...merged.values()]);
        setTotal(Number(list.pagination?.total) || merged.size);
        setError(null);
        setStatus("ready");

        const previewRows = await Promise.all(
          cats.slice(0, 3).map((cat) => api.products({ category: cat.id, limit: 10, sort: "newest" }))
        );
        const previewMap = {};
        cats.slice(0, 3).forEach((cat, i) => {
          previewMap[cat.slug] = (previewRows[i].products || [])
            .map((row) => adaptProduct(row, lang))
            .filter(Boolean);
        });
        setPreviews(previewMap);
      } catch (err) {
        setError(err);
        setStatus("error");
      }
    },
    [lang]
  );

  useEffect(() => {
    load();
  }, [load]);

  const derived = useMemo(() => {
    const live = products;
    const bySlugMap = Object.fromEntries(live.map((p) => [p.slug, p]));
    const categoryBySlug = Object.fromEntries(categories.map((c) => [c.slug, c]));

    return {
      live,
      total,
      bySlug: (slug) => bySlugMap[String(slug)],
      byId: (id) => live.find((p) => p.id === String(id)),
      categoryBySlug,
      featured: live.filter((p) => p.featured).concat(live).filter((p, i, all) => all.findIndex((x) => x.id === p.id) === i).slice(0, 12),
      deals: live.filter((p) => p.onDeal),
      brands: [...new Set(live.map((p) => p.brand).filter(Boolean))].sort(),
      byCategory: (slug) => previews[slug] || live.filter((p) => p.category === String(slug)),
      related: (p, n = 6) =>
        live
          .filter((x) => x.id !== p.id)
          .sort((a, b) => {
            const score = (x) => (x.category === p.category ? 2 : 0) + (x.brand === p.brand ? 1 : 0);
            return score(b) - score(a);
          })
          .slice(0, n),
    };
  }, [products, categories, total, previews]);

  const value = useMemo(
    () => ({
      products,
      categories,
      status,
      error,
      refresh: load,
      ...derived,
    }),
    [products, categories, status, error, load, derived]
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog() {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error("useCatalog must be used inside <CatalogProvider>");
  return ctx;
}

export const discountPct = () => 0;
