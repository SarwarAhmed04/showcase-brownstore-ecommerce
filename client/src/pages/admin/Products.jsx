import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useLang } from "../../context/LangContext";
import { tName } from "../../i18n";
import { imgUrl } from "../../lib/img";
import Spinner from "../../components/Spinner";
import ProductEditor, { digitsOnly, formatGrouped } from "../../components/admin/ProductEditor";

const COLS =
  "grid grid-cols-[minmax(14rem,1.6fr)_9rem_11rem_7rem_10rem_9rem_8rem] items-center gap-x-3";

const FILTER_CONTROL =
  "rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm font-semibold text-brown";

function ProductFilters({ t, lang, params, setParams, facets }) {
  const brand = params.get("brand") || "";
  const category = params.get("category") || "";
  const availability = params.get("availability") || "";
  const minPrice = params.get("minPrice") || "";
  const maxPrice = params.get("maxPrice") || "";
  const [minDraft, setMinDraft] = useState(minPrice);
  const [maxDraft, setMaxDraft] = useState(maxPrice);

  useEffect(() => {
    setMinDraft(formatGrouped(minPrice));
    setMaxDraft(formatGrouped(maxPrice));
  }, [minPrice, maxPrice]);

  useEffect(() => {
    const id = setTimeout(() => {
      const min = digitsOnly(minDraft);
      const max = digitsOnly(maxDraft);
      if (min === digitsOnly(minPrice) && max === digitsOnly(maxPrice)) return;
      patchParams(setParams, { minPrice: min, maxPrice: max });
    }, 400);
    return () => clearTimeout(id);
  }, [minDraft, maxDraft, minPrice, maxPrice, setParams]);

  const active =
    Boolean(brand || category || availability || minPrice || maxPrice);

  return (
    <section className="mb-4 flex flex-wrap items-center gap-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-brown/5">
      <select
        value={brand}
        onChange={(e) => patchParams(setParams, { brand: e.target.value })}
        className={FILTER_CONTROL}
      >
        <option value="">{t.allBrands}</option>
        {(facets.brands || []).map((item) => (
          <option key={item.id} value={item.id}>
            {tName(item.name, lang)}
          </option>
        ))}
      </select>
      <select
        value={category}
        onChange={(e) => patchParams(setParams, { category: e.target.value })}
        className={FILTER_CONTROL}
      >
        <option value="">{t.allCategories}</option>
        {(facets.categories || []).map((item) => (
          <option key={item.id} value={item.id}>
            {tName(item.name, lang)}
          </option>
        ))}
      </select>
      <input
        type="text"
        inputMode="numeric"
        dir="ltr"
        value={minDraft}
        onChange={(e) => setMinDraft(formatGrouped(e.target.value))}
        placeholder={t.minPrice}
        className={`${FILTER_CONTROL} w-36 font-medium tabular-nums`}
      />
      <input
        type="text"
        inputMode="numeric"
        dir="ltr"
        value={maxDraft}
        onChange={(e) => setMaxDraft(formatGrouped(e.target.value))}
        placeholder={t.maxPrice}
        className={`${FILTER_CONTROL} w-36 font-medium tabular-nums`}
      />
      <select
        value={availability}
        onChange={(e) =>
          patchParams(setParams, { availability: e.target.value })
        }
        className={FILTER_CONTROL}
      >
        <option value="">{t.allStatuses}</option>
        <option value="in">{t.inStock}</option>
        <option value="out">{t.outOfStock}</option>
      </select>
      {active ? (
        <button
          type="button"
          onClick={() => {
            const next = new URLSearchParams();
            const q = params.get("q");
            if (q) next.set("q", q);
            setParams(next);
          }}
          className="rounded-full px-4 py-2 text-sm font-semibold text-tan hover:text-brown"
        >
          {t.clearFilters}
        </button>
      ) : null}
    </section>
  );
}

function patchParams(setParams, patch) {
  setParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(patch).forEach(([key, value]) => {
      if (value) next.set(key, String(value));
      else next.delete(key);
    });
    next.delete("page");
    return next;
  });
}

function Row({ product, onEdit, t, lang }) {
  return (
    <div
      className={`${COLS} border-b border-brown/5 px-4 py-3 ${
        product.outOfStock ? "bg-brown/[0.03]" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <img
          src={imgUrl(product.image) || "/logo.png"}
          alt=""
          className="h-12 w-12 shrink-0 rounded-xl bg-cream object-cover"
        />
        <div className="min-w-0">
          <p className="truncate font-medium">{tName(product.name, lang)}</p>
          <p className="truncate text-xs text-brown/40">
            {t.source}: {product.itemCode || "—"}
          </p>
        </div>
      </div>
      <p className="truncate text-center text-sm">{product.sku || "—"}</p>
      <p className="text-center text-sm tabular-nums">
        {formatGrouped(product.sellingPrice ?? product.price ?? 0)}
      </p>
      <p className="text-center text-sm">{product.stock ?? 0}</p>
      <p
        className={`text-center text-xs font-semibold ${
          product.outOfStock ? "text-red-800" : "text-emerald-800"
        }`}
      >
        {product.outOfStock ? t.outOfStock : t.inStock}
      </p>
      <p className="truncate px-1 text-center text-sm font-medium text-brown" title={tName(product.brand?.name, lang)}>
        {tName(product.brand?.name, lang) || "—"}
      </p>
      <div className="text-center">
        <button
          type="button"
          onClick={() => onEdit(product)}
          className="rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream"
        >
          {t.editProduct}
        </button>
      </div>
    </div>
  );
}

export default function AdminProducts() {
  const { t, lang } = useLang();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const brand = params.get("brand") || "";
  const category = params.get("category") || "";
  const minPrice = params.get("minPrice") || "";
  const maxPrice = params.get("maxPrice") || "";
  const availability = params.get("availability") || "";
  const page = Math.max(1, Number(params.get("page") || 1));
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [data, setData] = useState({
    products: [],
    pagination: { pages: 1, total: 0 },
    facets: { brands: [], categories: [] },
  });
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editMessage, setEditMessage] = useState("");
  const firstLoad = useRef(true);

  const query = {
    page,
    q,
    brand,
    category,
    minPrice: digitsOnly(minPrice),
    maxPrice: digitsOnly(maxPrice),
    availability,
    limit: 20,
  };

  useEffect(() => {
    let cancelled = false;
    if (firstLoad.current) setLoading(true);
    else setSearching(true);

    api
      .adminProducts(query)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setMessage(err.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setSearching(false);
          firstLoad.current = false;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [page, q, brand, category, minPrice, maxPrice, availability]);

  function goPage(nextPage) {
    const next = new URLSearchParams(params);
    if (nextPage > 1) next.set("page", String(nextPage));
    else next.delete("page");
    setParams(next);
  }

  async function sync() {
    setSyncing(true);
    setMessage("");
    try {
      const result = await api.sync();
      setMessage(`${result.products} ${t.products}`);
      const refreshed = await api.adminProducts(query);
      setData(refreshed);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-3xl">{t.products}</h2>
          <p className="text-sm text-brown/50">
            {searching
              ? t.loading
              : `${Number(data.pagination.total || 0).toLocaleString("en-US")} ${t.results}`}
          </p>
        </div>
        <button
          type="button"
          onClick={sync}
          disabled={syncing}
          className="rounded-full bg-tan px-4 py-2 text-sm font-semibold text-brown disabled:opacity-60"
        >
          {syncing ? t.syncing : t.sync}
        </button>
      </div>

      {message ? <p className="mb-3 text-sm text-brown/70">{message}</p> : null}

      <ProductFilters
        t={t}
        lang={lang}
        params={params}
        setParams={setParams}
        facets={data.facets || { brands: [], categories: [] }}
      />

      <div className="overflow-x-auto rounded-3xl bg-white shadow-sm ring-1 ring-brown/5">
        {loading ? (
          <Spinner label={t.loading} />
        ) : (
          <div className="min-w-[70rem] text-sm">
            <div
              className={`${COLS} bg-cream px-4 py-3 text-center text-xs font-semibold text-brown/60`}
            >
              <span>{t.products}</span>
              <span>{t.sku}</span>
              <span>{t.price}</span>
              <span>{t.stock}</span>
              <span>{t.availability}</span>
              <span>{t.productBrand}</span>
              <span>{t.editProduct}</span>
            </div>
            {data.products.length ? (
              data.products.map((p) => (
                <Row
                  key={p.id}
                  product={p}
                  t={t}
                  lang={lang}
                  onEdit={async (item) => {
                    setEditMessage("");
                    try {
                      const data = await api.adminProduct(item.id);
                      setEditing(data.product || item);
                    } catch {
                      setEditing(item);
                    }
                  }}
                />
              ))
            ) : (
              <p className="px-4 py-10 text-center text-sm text-brown/50">{t.noProducts}</p>
            )}
          </div>
        )}
      </div>

      {data.pagination.pages > 1 && (
        <div className="mt-4 flex justify-center gap-2">
          {Array.from({ length: data.pagination.pages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === data.pagination.pages || Math.abs(n - page) <= 2)
            .map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => goPage(n)}
                className={`h-9 min-w-9 rounded-full ${
                  n === page ? "bg-brown text-cream" : "bg-white"
                }`}
              >
                {n}
              </button>
            ))}
        </div>
      )}
      {editing ? (
        <ProductEditor
          product={editing}
          t={t}
          lang={lang}
          mode="store"
          busy={editBusy}
          message={editMessage}
          onClose={() => setEditing(null)}
          onReset={async () => {
            setEditBusy(true);
            setEditMessage("");
            try {
              const data = await api.patchProduct(editing.id, {
                reset: [
                  "sku",
                  "price",
                  "discountPrice",
                  "stock",
                  "outOfStock",
                  "isActive",
                  "name",
                  "description",
                  "brand",
                  "category",
                  "subCategory",
                  "collectionName",
                  "variants",
                  "warranty",
                  "keyword",
                  "badge",
                  "is_featured",
                  "is_new_arrival",
                  "is_best_seller",
                ],
              });
              setEditing(data.product);
              setData((prev) => ({
                ...prev,
                products: prev.products.map((item) =>
                  item.id === data.product.id ? data.product : item
                ),
              }));
              setEditMessage(t.saved);
            } catch (err) {
              setEditMessage(err.message);
            } finally {
              setEditBusy(false);
            }
          }}
          onSave={async (patch) => {
            setEditBusy(true);
            setEditMessage("");
            try {
              const data = await api.patchProduct(editing.id, patch);
              setEditing(data.product);
              setData((prev) => ({
                ...prev,
                products: prev.products.map((item) =>
                  item.id === data.product.id ? data.product : item
                ),
              }));
              setEditMessage(t.saved);
            } catch (err) {
              setEditMessage(err.message);
            } finally {
              setEditBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}
