import { useState } from "react";
import { api } from "../../../api";
import { tName } from "../../../i18n";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST =
  "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

export default function ElryanSyncOneProduct({ t, lang }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSearch() {
    setBusy(true);
    setError("");
    try {
      const data = await api.elryanSyncOneSearch(query);
      setResults(data.products || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onPreview() {
    if (!selected?.id) return;
    setBusy(true);
    setError("");
    try {
      const data = await api.elryanSyncOnePreview(selected.id, { investigateCommission: true });
      setPreview(data);
    } catch (err) {
      setError(err.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function onSendBlocked() {
    if (!selected?.id || !preview?.previewToken) return;
    setBusy(true);
    setError("");
    try {
      const data = await api.elryanSyncOneSend({
        productId: selected.id,
        previewToken: preview.previewToken,
        confirm: true,
      });
      setError(data.message || t.elryanSendDisabled);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.elryanSyncOneTitle}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-brown/60">{t.elryanSyncOneHint}</p>
      </div>

      <div className="flex max-w-xl flex-wrap gap-2">
        <input
          className={`${CONTROL} flex-1`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.elryanSearchProducts}
        />
        <button type="button" className={BUTTON} disabled={busy} onClick={onSearch}>
          {busy ? t.loading : t.search}
        </button>
      </div>

      <ul className="max-w-xl space-y-2">
        {results.map((product) => (
          <li key={product.id}>
            <button
              type="button"
              className={`w-full rounded-2xl px-4 py-3 text-left text-sm ring-1 ${
                selected?.id === product.id ? "bg-cream ring-tan" : "bg-white ring-brown/10"
              }`}
              onClick={() => {
                setSelected(product);
                setPreview(null);
              }}
            >
              <span className="font-semibold text-brown">{tName(product.name, lang) || product.sku}</span>
              <span className="mt-1 block text-xs text-brown/45">{product.sku}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={!selected || busy} onClick={onPreview}>
          {busy ? t.loading : t.elryanPreviewProduct}
        </button>
        <button type="button" className={GHOST} disabled title={t.elryanSendDisabled}>
          {t.elryanSendProduct}
        </button>
        <button type="button" className={GHOST} disabled={busy || !preview} onClick={onSendBlocked}>
          {t.elryanProbeSendGate}
        </button>
      </div>

      {preview ? (
        <div className="max-w-3xl space-y-4 rounded-[1.75rem] bg-white p-5 ring-1 ring-brown/10">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">
              {preview.readiness}
            </span>
            <span className="text-xs text-brown/45">
              {preview.productWritesEnabled ? t.elryanWritesEnabledCaution : t.elryanWritesDisabled}
            </span>
          </div>

          <dl className="grid gap-2 text-sm md:grid-cols-2">
            <div>
              <dt className="text-brown/45">SKU</dt>
              <dd className="font-semibold">{preview.product?.sku}</dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.elryanCategory}</dt>
              <dd className="font-semibold">
                {preview.mapping?.categoryId || "—"} {preview.mapping?.categoryName || ""}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.storePrice}</dt>
              <dd className="font-semibold">{preview.pricing?.storeSellingPrice} IQD</dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.commission}</dt>
              <dd className="font-semibold">{preview.pricing?.commissionRate}%</dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.platformPrice}</dt>
              <dd className="font-semibold">{preview.pricing?.platformPrice} IQD</dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.elryanProposedPrice}</dt>
              <dd className="font-semibold">{preview.pricing?.proposedElryanPrice ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.elryanProposedCost}</dt>
              <dd className="font-semibold">{preview.pricing?.proposedElryanCost ?? "—"}</dd>
            </div>
          </dl>

          {preview.blockers?.length ? (
            <ul className="space-y-1 text-sm text-red-700">
              {preview.blockers.map((blocker, index) => (
                <li key={`${blocker.code}-${index}`}>
                  [{blocker.status}] {blocker.message || blocker.code}
                </li>
              ))}
            </ul>
          ) : null}

          <pre className="max-h-80 overflow-auto rounded-2xl bg-cream/70 p-4 text-xs text-brown/80">
            {JSON.stringify(preview.proposedPayload, null, 2)}
          </pre>
        </div>
      ) : null}

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
