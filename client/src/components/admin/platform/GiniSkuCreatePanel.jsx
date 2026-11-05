import { useState } from "react";
import { api } from "../../../api";
import { canConfirmGiniSkuCreate } from "./giniSkuCreateDisplay.js";

const INPUT =
  "w-full rounded-2xl border border-brown/10 bg-cream px-4 py-2.5 text-sm text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON = "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST = "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

export default function GiniSkuCreatePanel({ t }) {
  const [sku, setSku] = useState("");
  const [productId, setProductId] = useState("");
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  function changeSku(value) {
    setSku(value);
    setPreview(null);
    setConfirmed(false);
    setResult(null);
  }

  function changeProductId(value) {
    setProductId(value);
    setPreview(null);
    setConfirmed(false);
    setResult(null);
  }

  async function runPreview(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    setConfirmed(false);
    setPreview(null);
    try {
      const next = await api.giniSkuCreatePreview({ sku: sku.trim(), productId: productId.trim() });
      setPreview(next);
    } catch (err) {
      setError(err.message || t.giniSkuCreateFailed);
    } finally {
      setBusy(false);
    }
  }

  async function runSend() {
    if (!canConfirmGiniSkuCreate({ preview, sku, productId, confirmed, busy })) return;
    setBusy(true);
    setError("");
    try {
      const sent = await api.giniSkuCreateSend({
        sku: preview.sku,
        productId: preview.productId,
        confirm: true,
        expectedCount: 1,
        previewToken: preview.previewToken,
      });
      setResult(sent);
      setPreview(null);
      setConfirmed(false);
    } catch (err) {
      setError(err.message || t.giniSkuCreateFailed);
    } finally {
      setBusy(false);
    }
  }

  const sendReady = canConfirmGiniSkuCreate({ preview, sku, productId, confirmed, busy });
  const merchant = preview?.merchant || null;
  const payload = preview?.payloadPreview || null;
  const price = preview?.giniPrice ?? payload?.price ?? null;
  const quantity = preview?.quantity ?? payload?.quantity ?? null;

  return (
    <section className="mt-8 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5" data-gini-sku-create-panel="true">
      <h2 className="text-lg font-semibold text-brown">{t.giniSkuCreateTitle}</h2>
      <p className="mt-2 text-sm text-brown/60">{t.giniSkuCreateHint}</p>
      <form className="mt-5 grid gap-4" onSubmit={runPreview}>
        <label className="block text-sm font-semibold text-brown">
          {t.giniSkuCreateSku}
          <input
            className={`${INPUT} mt-2`}
            dir="ltr"
            value={sku}
            autoComplete="off"
            onChange={(event) => changeSku(event.target.value)}
            data-gini-sku-create-sku="true"
          />
        </label>
        <label className="block text-sm font-semibold text-brown">
          {t.giniSkuCreateProductId}
          <input
            className={`${INPUT} mt-2`}
            dir="ltr"
            value={productId}
            autoComplete="off"
            onChange={(event) => changeProductId(event.target.value)}
            data-gini-sku-create-product="true"
          />
        </label>
        <div>
          <button className={GHOST} type="submit" disabled={busy || !sku.trim() || !productId.trim()} data-gini-sku-create-preview="true">
            {t.giniSkuCreatePreview}
          </button>
          <p className="mt-2 text-xs text-brown/50">{t.giniSkuCreatePreviewNote}</p>
        </div>
      </form>

      {preview ? (
        <div className="mt-5 rounded-2xl bg-cream px-4 py-4 text-sm text-brown" data-gini-sku-create-result="true">
          <p>
            {t.giniSkuCreateIdentity}: <span dir="ltr">{preview.sku || "—"}</span>
            {" · "}
            <span dir="ltr">{preview.productId || "—"}</span>
          </p>
          <p className="mt-2">
            {t.giniSkuCreatePrice}: <span dir="ltr">{price ?? "—"}</span>
          </p>
          <p className="mt-2">
            {t.giniSkuCreateQuantity}: <span dir="ltr">{quantity ?? "—"}</span>
          </p>
          <p className="mt-2">
            {t.giniSkuCreateMerchant}:{" "}
            <span dir="ltr">
              {merchant?.host || "—"}
              {merchant?.clientMask ? ` · ${merchant.clientMask}` : ""}
            </span>
          </p>
          {preview.code ? (
            <p className="mt-2 text-red-700" dir="ltr">
              {preview.code}
            </p>
          ) : null}
          {preview.writesEnabled === true ? null : <p className="mt-2 text-brown/70">{t.giniSkuCreateWritesOff}</p>}
        </div>
      ) : null}

      <div className="mt-6 border-t border-brown/10 pt-5">
        <p className="text-sm font-semibold text-brown">{t.giniSkuCreateSeparate}</p>
        <label className="mt-3 flex items-start gap-3 text-sm text-brown">
          <input
            type="checkbox"
            className="mt-1"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            data-gini-sku-create-confirm="true"
          />
          <span>{t.giniSkuCreateConfirm}</span>
        </label>
        <button className={`${BUTTON} mt-4`} type="button" disabled={!sendReady} onClick={runSend} data-gini-sku-create-send="true">
          {t.giniSkuCreateSend}
        </button>
      </div>
      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {result?.ok ? (
        <p className="mt-4 text-sm text-brown" data-gini-sku-create-sent="true">
          {t.giniSkuCreateSent} <span dir="ltr">{result.giniProductId || ""}</span>
        </p>
      ) : null}
    </section>
  );
}
