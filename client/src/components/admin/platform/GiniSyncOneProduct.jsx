import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import { tName } from "../../../i18n";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";

function actionTone(action) {
  if (action === "CREATE") return "bg-emerald-50 text-emerald-800";
  if (action === "UPDATE_AVAILABLE") return "bg-sky-50 text-sky-900";
  return "bg-amber-50 text-amber-900";
}

export default function GiniSyncOneProduct({ t, lang }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const searchTimer = useRef(null);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setResults([]);
      return undefined;
    }
    searchTimer.current = setTimeout(() => {
      api
        .giniSyncOneSearch(query)
        .then((data) => setResults(data.products || []))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(searchTimer.current);
  }, [query]);

  function choose(row) {
    setSelected(row);
    setPreview(null);
    setResult(null);
    setError("");
  }

  async function previewProduct() {
    if (!selected?.id) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const data = await api.giniSyncOnePreview(selected.id);
      setPreview(data);
    } catch (err) {
      setPreview(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendProduct() {
    if (!preview?.canSend || !preview.previewToken) return;
    if (!window.confirm(t.giniSendConfirm)) return;
    setBusy(true);
    setError("");
    try {
      const data = await api.giniSyncOneSend({
        productId: preview.productId,
        previewToken: preview.previewToken,
        confirm: true,
      });
      setResult(data);
      setPreview(null);
      if (!data.ok) setError(data.message || t.giniBlocked);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const payload = preview?.payloadPreview;

  return (
    <section className="space-y-6">
      <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">{t.giniSyncOneTitle}</p>
        <p className="mt-2 max-w-2xl text-sm text-brown/60">{t.giniSyncOneHint}</p>
        <label className="mt-5 block text-sm font-semibold text-brown">
          {t.giniSearchProducts}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={`${CONTROL} mt-2`}
            placeholder={t.giniSearchProducts}
          />
        </label>
        {query.trim() && !results.length ? <p className="mt-3 text-sm text-brown/50">{t.giniNoProducts}</p> : null}
        <div className="mt-4 space-y-2">
          {results.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => choose(row)}
              className={`block w-full rounded-2xl px-4 py-3 text-start ring-1 ${
                selected?.id === row.id ? "bg-cream ring-brown/20" : "bg-white ring-brown/10"
              }`}
            >
              <span className="block font-semibold text-brown">{tName(row.name, lang) || row.itemCode}</span>
              <span className="mt-1 block text-xs font-semibold text-brown/50">{row.itemCode}</span>
            </button>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" className={BUTTON} disabled={!selected || busy} onClick={previewProduct}>
            {busy ? t.loading : t.giniPreviewProduct}
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={!preview?.canSend || !preview?.previewToken || busy}
            onClick={sendProduct}
          >
            {t.giniSendProduct}
          </button>
        </div>
        {error ? <p className="mt-4 text-sm font-semibold text-red-700">{error}</p> : null}
      </div>

      {preview ? (
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${actionTone(preview.action)}`}>
              {preview.action === "BLOCKED" ? t.giniBlocked : preview.action}
            </span>
            {preview.giniMode ? (
              <span className="rounded-full bg-brown/5 px-3 py-1 text-xs font-semibold text-brown">
                GINI mode: {preview.giniMode}
              </span>
            ) : null}
          </div>
          {preview.giniMode === "SIMPLE_PRODUCT" ? (
            <p className="mt-3 text-sm font-semibold text-brown">BrownStore variants collapsed: 1</p>
          ) : null}
          <dl className="mt-4 grid gap-3 text-sm text-brown sm:grid-cols-2">
            <div>
              <dt className="text-brown/45">SKU</dt>
              <dd className="font-semibold">{preview.sku || "—"}</dd>
            </div>
            <div>
              <dt className="text-brown/45">BrownStore</dt>
              <dd className="font-semibold">
                {preview.priceReview ? t.priceNeedsReview : `${preview.brownStorePrice} IQD`}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">Commission</dt>
              <dd className="font-semibold">{preview.commissionRate}%</dd>
            </div>
            <div>
              <dt className="text-brown/45">GINI</dt>
              <dd className="font-semibold">
                {preview.priceReview ? t.priceNeedsReview : `${preview.giniPrice} IQD`}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">Quantity</dt>
              <dd className="font-semibold">{preview.quantity}</dd>
            </div>
            <div>
              <dt className="text-brown/45">Images</dt>
              <dd className="font-semibold">{preview.imageCount}</dd>
            </div>
            <div>
              <dt className="text-brown/45">Category</dt>
              <dd className="font-semibold">
                {preview.category ? `${preview.category.id} ${preview.category.name || ""}` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">Subcategory</dt>
              <dd className="font-semibold">
                {preview.subcategory ? `${preview.subcategory.id} ${preview.subcategory.name || ""}` : "—"}
              </dd>
            </div>
          </dl>
          {preview.blockers?.length ? (
            <ul className="mt-4 space-y-1 text-sm font-semibold text-amber-900">
              {preview.blockers.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          ) : null}
          {preview.warnings?.length ? (
            <ul className="mt-3 space-y-1 text-sm text-brown/60">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-5 text-[11px] font-semibold tracking-[0.16em] text-tan uppercase">{t.giniPayloadPreview}</p>
          <pre className="mt-2 overflow-x-auto rounded-2xl bg-cream p-4 text-xs leading-5 text-brown">
            {JSON.stringify(payload, null, 2)}
          </pre>
          {payload?.images?.length ? (
            <ul className="mt-3 space-y-1 text-xs text-brown/55">
              {payload.images.map((image) => (
                <li key={image.url}>{image.url}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">{t.giniSyncResult}</p>
          <p className="mt-2 text-sm font-semibold text-brown">{result.message}</p>
          <dl className="mt-3 grid gap-2 text-sm text-brown sm:grid-cols-2">
            <div>
              <dt className="text-brown/45">HTTP</dt>
              <dd className="font-semibold">{result.httpStatus}</dd>
            </div>
            <div>
              <dt className="text-brown/45">SKU</dt>
              <dd className="font-semibold">{result.sku}</dd>
            </div>
            <div>
              <dt className="text-brown/45">GINI ID</dt>
              <dd className="font-semibold">{result.giniProductId || "—"}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  );
}
