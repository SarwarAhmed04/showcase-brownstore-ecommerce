import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import { tName } from "../../../i18n";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST =
  "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

function actionTone(action) {
  if (action === "CREATE") return "bg-emerald-50 text-emerald-800";
  if (action === "UPDATE") return "bg-sky-50 text-sky-900";
  return "bg-amber-50 text-amber-900";
}

export default function MiswagSyncOneProduct({ t, lang, syncEnabled }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [categoryQuery, setCategoryQuery] = useState("");
  const [brandQuery, setBrandQuery] = useState("");
  const [categoryHits, setCategoryHits] = useState([]);
  const [brandHits, setBrandHits] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedBrand, setSelectedBrand] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState("");
  const [error, setError] = useState("");
  const searchTimer = useRef(null);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  useEffect(() => {
    if (!syncEnabled) return undefined;
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      api
        .miswagSyncOneSearch(query)
        .then((data) => setResults(data.products || []))
        .catch(() => setResults([]));
    }, 220);
    return () => clearTimeout(searchTimer.current);
  }, [query, syncEnabled]);

  async function loadPreview(productId) {
    if (!productId) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const data = await api.miswagSyncOnePreview(productId, { categoryId, brandId });
      setPreview(data);
      setSelectedId(productId);
    } catch (err) {
      setError(err.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function refreshPreview() {
    if (!selectedId) return;
    await loadPreview(selectedId);
  }

  async function findCategories() {
    setFinding("categories");
    setError("");
    try {
      const data = await api.miswagFindCategories(categoryQuery || query, 20);
      setCategoryHits(data.categories || []);
      if (!(data.categories || []).length) setError(t.miswagNoCategories);
    } catch (err) {
      setError(err.message);
      setCategoryHits([]);
    } finally {
      setFinding("");
    }
  }

  async function findBrands() {
    setFinding("brands");
    setError("");
    try {
      const data = await api.miswagFindBrands(brandQuery, 20);
      setBrandHits(data.brands || []);
      if (!(data.brands || []).length) setError(t.miswagNoBrands);
    } catch (err) {
      setError(err.message);
      setBrandHits([]);
    } finally {
      setFinding("");
    }
  }

  function pickCategory(row) {
    setCategoryId(row.id);
    setSelectedCategory(row);
  }

  function pickBrand(row) {
    setBrandId(String(row.id));
    setSelectedBrand(row);
  }

  async function sendTest() {
    if (!selectedId || !preview?.canSend) return;
    if (!window.confirm(t.miswagSendTestConfirm)) return;
    setBusy(true);
    setError("");
    try {
      const data = await api.miswagSyncOneSend({
        productId: selectedId,
        categoryId,
        brandId,
        confirm: true,
      });
      setResult(data);
      if (!data.ok) setError(data.message || t.miswagSendTestFail);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!syncEnabled) {
    return (
      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.miswagSyncOneTitle}
        </p>
        <p className="mt-2 text-sm text-brown/55">{t.miswagSyncNeedsConnection}</p>
        <button type="button" disabled className={`${BUTTON} mt-4`}>
          {t.miswagSyncOneTitle}
        </button>
      </section>
    );
  }

  const product = preview?.product;

  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
      <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
        {t.miswagSyncOneTitle}
      </p>
      <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.miswagSyncOneHint}</p>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-brown/50">{t.miswagPickProduct}</label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.miswagSearchProducts}
            className={CONTROL}
          />
          <ul className="mt-2 max-h-48 overflow-y-auto rounded-2xl bg-cream ring-1 ring-brown/5">
            {results.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => loadPreview(row.id)}
                  className={`flex w-full flex-col gap-0.5 px-4 py-2.5 text-start text-sm transition hover:bg-white ${
                    selectedId === row.id ? "bg-white font-semibold" : ""
                  }`}
                >
                  <span>{tName(row.name, lang) || row.sku || row.id}</span>
                  <span className="text-xs text-brown/45" dir="ltr">
                    {row.sku || row.itemCode} · {row.brand || "—"}
                  </span>
                </button>
              </li>
            ))}
            {!results.length ? (
              <li className="px-4 py-3 text-sm text-brown/45">{t.miswagNoProducts}</li>
            ) : null}
          </ul>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brown/50">
              {t.miswagFindCategory}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                dir="ltr"
                value={categoryQuery}
                onChange={(e) => setCategoryQuery(e.target.value)}
                placeholder={t.miswagCategorySearchPlaceholder}
                className={`${CONTROL} min-w-0 flex-1`}
              />
              <button
                type="button"
                disabled={Boolean(finding)}
                onClick={findCategories}
                className={GHOST}
              >
                {finding === "categories" ? t.loading : t.miswagFindCategory}
              </button>
            </div>
            <p className="mt-1 text-xs text-brown/45">{t.miswagTempCategoryHint}</p>
            {selectedCategory ? (
              <p className="mt-1 text-xs font-semibold text-emerald-800" dir="ltr">
                {selectedCategory.level} · {selectedCategory.id} · {selectedCategory.name}
              </p>
            ) : null}
            <ul className="mt-2 max-h-40 overflow-y-auto rounded-2xl bg-cream ring-1 ring-brown/5">
              {categoryHits.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => pickCategory(row)}
                    className={`flex w-full flex-col gap-0.5 px-4 py-2 text-start text-sm hover:bg-white ${
                      categoryId === row.id ? "bg-white font-semibold" : ""
                    }`}
                  >
                    <span dir="ltr">
                      {row.level || "?"} · {row.id} · {row.name}
                    </span>
                    <span className="text-xs text-brown/45" dir="ltr">
                      {row.path || "—"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <input
              dir="ltr"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setSelectedCategory(null);
              }}
              placeholder="L4-12345"
              className={`${CONTROL} mt-2`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-brown/50">
              {t.miswagFindBrand}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                dir="ltr"
                value={brandQuery}
                onChange={(e) => setBrandQuery(e.target.value)}
                placeholder={t.miswagBrandSearchPlaceholder}
                className={`${CONTROL} min-w-0 flex-1`}
              />
              <button type="button" disabled={Boolean(finding)} onClick={findBrands} className={GHOST}>
                {finding === "brands" ? t.loading : t.miswagFindBrand}
              </button>
            </div>
            <p className="mt-1 text-xs text-brown/45">{t.miswagTempBrandHint}</p>
            {selectedBrand ? (
              <p className="mt-1 text-xs font-semibold text-emerald-800" dir="ltr">
                {selectedBrand.id} · {selectedBrand.name}
              </p>
            ) : null}
            <ul className="mt-2 max-h-40 overflow-y-auto rounded-2xl bg-cream ring-1 ring-brown/5">
              {brandHits.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => pickBrand(row)}
                    className={`flex w-full flex-col gap-0.5 px-4 py-2 text-start text-sm hover:bg-white ${
                      brandId === String(row.id) ? "bg-white font-semibold" : ""
                    }`}
                  >
                    <span dir="ltr">
                      {row.id} · {row.name || "—"}
                    </span>
                    {row.alias ? (
                      <span className="text-xs text-brown/45" dir="ltr">
                        {row.alias}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            <input
              dir="ltr"
              value={brandId}
              onChange={(e) => {
                setBrandId(e.target.value);
                setSelectedBrand(null);
              }}
              placeholder={preview?.brand?.id ? String(preview.brand.id) : "123"}
              className={`${CONTROL} mt-2`}
            />
          </div>

          <button type="button" disabled={busy || !selectedId} onClick={refreshPreview} className={GHOST}>
            {t.miswagRefreshPreview}
          </button>
        </div>
      </div>

      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}

      {preview ? (
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${actionTone(preview.plannedAction)}`}>
              {preview.plannedAction}
            </span>
            <span className="text-xs text-brown/45" dir="ltr">
              {preview.method} {preview.endpoint}
            </span>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[
              [t.miswagPreviewName, tName(product?.name, lang)],
              [t.miswagPreviewBrand, product?.brandName || "—"],
              [t.miswagPreviewSku, product?.sku || product?.itemCode || "—"],
              [t.miswagPreviewStorePrice, preview.pricing?.storePrice],
              [t.miswagPreviewCommission, `${preview.pricing?.commissionPercent ?? 0}%`],
              [t.miswagPreviewRawPrice, preview.pricing?.rawPriceAfterCommission],
              [t.miswagPreviewFinalPrice, preview.pricing?.finalRoundedPrice],
              [t.miswagPreviewStock, product?.stock],
              [t.miswagPreviewEligible, preview.eligibility?.eligible ? t.yes : t.no],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-cream px-4 py-3">
                <dt className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</dt>
                <dd className="mt-1 text-sm font-semibold text-brown" dir="ltr">
                  {String(value ?? "—")}
                </dd>
              </div>
            ))}
          </dl>

          <div>
            <p className="text-xs font-semibold text-brown/50 uppercase">{t.miswagPreviewImages}</p>
            <p className="mt-1 text-sm text-brown/70" dir="ltr">
              {(product?.images || []).length
                ? (product.images || []).slice(0, 5).join(" · ")
                : "—"}
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold text-brown/50 uppercase">{t.miswagPreviewVariants}</p>
            <ul className="mt-1 space-y-2 text-sm text-brown/70" dir="ltr">
              {(product?.variants || []).map((variant) => (
                <li key={variant.external_id} className="rounded-2xl bg-cream px-3 py-2">
                  <p>
                    {variant.external_id} · {variant.color?.name || "?"} ·{" "}
                    {(variant.sizes || []).map((size) => `${size.label}:${size.quantity}`).join(", ")}
                  </p>
                  <p className="mt-1 text-xs">
                    {t.miswagBarcode}: {variant.barcode || "—"}
                    {variant.barcodeLabel ? (
                      <span className="text-brown/45">
                        {" "}
                        · {t.miswagBarcodeSource}: {variant.barcodeLabel}
                      </span>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {(preview.missingFields || []).length ? (
            <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-semibold">{t.miswagMissingFields}</p>
              <ul className="mt-1 list-disc ps-5">
                {preview.missingFields.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="text-xs text-brown/45">{preview.lookupNote}</p>
          <p className="text-xs text-brown/45">{preview.categoryNote}</p>

          <button type="button" disabled={busy || !preview.canSend} onClick={sendTest} className={BUTTON}>
            {busy ? t.loading : t.miswagSendTestProduct}
          </button>
        </div>
      ) : null}

      {result ? (
        <div className="mt-6 rounded-2xl bg-cream px-4 py-4 text-sm">
          <p className="font-semibold text-brown">{t.miswagSendResult}</p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2" dir="ltr">
            <div>
              <dt className="text-brown/45">{t.miswagDiagHttpStatus}</dt>
              <dd>{result.httpStatus || "—"}</dd>
            </div>
            <div>
              <dt className="text-brown/45">Action</dt>
              <dd>{result.action}</dd>
            </div>
            <div>
              <dt className="text-brown/45">Endpoint</dt>
              <dd>
                {result.method} {result.endpoint}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">Miswag ID</dt>
              <dd>{result.miswagProductId || "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-brown/45">Message</dt>
              <dd>{result.message}</dd>
            </div>
          </dl>
          {(result.validationErrors || []).length ? (
            <ul className="mt-2 list-disc ps-5 text-red-700">
              {result.validationErrors.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
