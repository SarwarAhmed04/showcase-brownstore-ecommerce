import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useLang } from "../context/LangContext";
import { tName } from "../i18n";
import ProductCard from "../components/ProductCard";
import Spinner from "../components/Spinner";

export default function Shop() {
  const { t, lang } = useLang();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") || "");
  const category = params.get("category") || "";
  const sort = params.get("sort") || "newest";
  const page = Number(params.get("page") || 1);
  const [categories, setCategories] = useState([]);
  const [result, setResult] = useState({ products: [], pagination: { pages: 1, total: 0 } });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.categories().then((d) => setCategories(d.categories || []));
  }, []);

  useEffect(() => {
    setLoading(true);
    api
      .products({ q: params.get("q") || "", category, sort, page, limit: 24 })
      .then(setResult)
      .catch(() => setResult({ products: [], pagination: { pages: 1, total: 0 } }))
      .finally(() => setLoading(false));
  }, [params, category, sort, page]);

  function update(next) {
    const merged = {
      q: params.get("q") || "",
      category,
      sort,
      page: "1",
      ...next,
    };
    const sp = new URLSearchParams();
    if (merged.q) sp.set("q", merged.q);
    if (merged.category) sp.set("category", merged.category);
    if (merged.sort && merged.sort !== "newest") sp.set("sort", merged.sort);
    if (merged.page && Number(merged.page) > 1) sp.set("page", String(merged.page));
    setParams(sp);
  }

  function onSearch(e) {
    e.preventDefault();
    update({ q, page: "1" });
  }

  const pages = result.pagination?.pages || 1;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-display text-3xl text-brown">{t.shop}</h1>
          <p className="mt-1 text-sm text-brown/60">
            {result.pagination?.total || 0} {t.results}
          </p>
        </div>
        <form onSubmit={onSearch} className="flex w-full max-w-md gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.search}
            className="w-full rounded-full border border-brown/10 bg-white px-4 py-2.5 text-sm outline-none ring-tan/40 focus:ring-2"
          />
          <button
            type="submit"
            className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream"
          >
            {t.search.split(" ")[0]}
          </button>
        </form>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => update({ category: "", page: "1" })}
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
            !category ? "bg-brown text-cream" : "bg-white text-brown ring-1 ring-brown/10"
          }`}
        >
          {t.allCategories}
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => update({ category: cat.id, page: "1" })}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
              category === cat.id
                ? "bg-brown text-cream"
                : "bg-white text-brown ring-1 ring-brown/10"
            }`}
          >
            {tName(cat.name, lang)}
          </button>
        ))}
        <select
          value={sort}
          onChange={(e) => update({ sort: e.target.value, page: "1" })}
          className="ms-auto rounded-full border border-brown/10 bg-white px-3 py-1.5 text-xs"
        >
          <option value="newest">{t.newest}</option>
          <option value="price_asc">{t.priceAsc}</option>
          <option value="price_desc">{t.priceDesc}</option>
        </select>
      </div>

      {loading ? (
        <Spinner label={t.loading} />
      ) : result.products.length === 0 ? (
        <p className="py-16 text-center text-brown/50">{t.noProducts}</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {result.products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="mt-10 flex items-center justify-center gap-2">
          {Array.from({ length: pages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 2)
            .map((n, idx, arr) => (
              <span key={n} className="contents">
                {idx > 0 && arr[idx - 1] !== n - 1 ? (
                  <span className="px-1 text-brown/40">…</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => update({ page: String(n) })}
                  className={`h-9 min-w-9 rounded-full px-3 text-sm ${
                    n === page ? "bg-brown text-cream" : "bg-white text-brown"
                  }`}
                >
                  {n}
                </button>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
