import { useEffect, useState } from "react";
import { api } from "../../../api";
import { resyncRemoteLabelKey, selectEligibleResyncSkus } from "./giniResyncDisplay.js";

const BUTTON = "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST = "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

function count(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function Stat({ label, value, marker }) {
  return (
    <div className="rounded-2xl bg-cream px-4 py-3" {...(marker ? { [marker]: String(value ?? 0) } : {})}>
      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums text-brown">{value ?? "—"}</p>
    </div>
  );
}

function remoteText(t, row) {
  const key = resyncRemoteLabelKey(row);
  return t[key] || row?.remoteState || "";
}

function ProductList({ title, rows, marker, tone = "cream", selected, onToggle, showCheck, t }) {
  return (
    <div className="mt-5" {...(marker ? { [marker]: "true" } : {})}>
      <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">{title}</p>
      {rows?.length ? (
        <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto text-sm">
          {rows.map((row) => (
            <li key={`${row.classification}-${row.sku}-${row.savedGiniProductId || row.giniProductId}`} className={`rounded-2xl px-4 py-3 ${tone}`}>
              {showCheck ? (
                <label className="flex items-center gap-2 font-semibold text-brown">
                  <input
                    type="checkbox"
                    checked={selected.has(row.sku)}
                    onChange={(event) => onToggle(row.sku, event.target.checked)}
                    data-gini-resync-sku={row.sku}
                  />
                  <span dir="ltr">{row.sku}</span>
                </label>
              ) : (
                <span className="font-semibold text-brown" dir="ltr">
                  {row.sku || row.savedGiniProductId}
                </span>
              )}
              {row.name ? <span className="mt-1 block text-brown/80">{row.name}</span> : null}
              <span className="mt-1 block text-brown/70">{remoteText(t, row)}</span>
              {row.reason ? <span className="mt-1 block text-brown/70">{row.reason}</span> : null}
              {row.historical ? <span className="mt-1 block text-brown/70">{t.giniResyncHistorical}</span> : null}
              <span className="mt-1 block text-brown/50" dir="ltr">
                {row.savedGiniProductId || row.giniProductId || ""}
                {row.liveGiniProductId ? ` · ${row.liveGiniProductId}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-brown/50">{t.giniResyncNone}</p>
      )}
    </div>
  );
}

export default function GiniResyncDeleted({ t }) {
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const previewId = preview?.previewId || "";
  const eligible = selectEligibleResyncSkus(preview);
  const allEligibleSelected = eligible.length > 0 && eligible.every((sku) => selected.has(sku));

  useEffect(() => {
    setSelected(new Set());
    setResults([]);
  }, [previewId]);

  function toggle(sku, checked) {
    const allowed = new Set(selectEligibleResyncSkus(preview));
    setSelected((current) => {
      const next = new Set([...current].filter((item) => allowed.has(item)));
      if (checked && allowed.has(sku)) next.add(sku);
      if (!checked) next.delete(sku);
      return next;
    });
  }

  function toggleAll(checked) {
    setSelected(checked ? new Set(selectEligibleResyncSkus(preview)) : new Set());
  }

  async function runPreview() {
    setBusy("preview");
    setError("");
    setMessage("");
    try {
      const data = await api.giniResyncPreview();
      setPreview(data);
      setMessage(data?.message || t.giniResyncReadOnly);
    } catch (err) {
      setError(err.code ? `${err.code}: ${err.message}` : err.message);
    } finally {
      setBusy("");
    }
  }

  async function send(skus, scope) {
    if (!preview?.previewId || !skus.length) return;
    const exact = skus.length;
    const prompt = String(t.giniResyncConfirm || "")
      .replaceAll("{count}", String(exact))
      .replaceAll("{skus}", skus.join(", "));
    if (!window.confirm(prompt)) return;
    setBusy(scope);
    setError("");
    setMessage("");
    try {
      const data = await api.giniResyncStart({
        confirm: true,
        previewId: preview.previewId,
        previewSignature: preview.previewSignature,
        skus,
        expectedCount: exact,
        scope,
        all: false,
      });
      setResults(Array.isArray(data?.results) ? data.results : []);
      setMessage(data?.message || t.giniResyncResult);
    } catch (err) {
      setError(err.code ? `${err.code}: ${err.message}` : err.message);
    } finally {
      setBusy("");
    }
  }

  async function reconcile(sku) {
    const prompt = String(t.giniResyncReconcileConfirm || "").replaceAll("{sku}", sku);
    if (!window.confirm(prompt)) return;
    setBusy("reconcile");
    setError("");
    try {
      const data = await api.giniResyncReconcile({ confirm: true, sku });
      setMessage(data?.message || t.giniResyncReconcileButton);
      setResults((current) => [{ ...data, sku }, ...current.filter((item) => item.sku !== sku)]);
    } catch (err) {
      setError(err.code ? `${err.code}: ${err.message}` : err.message);
    } finally {
      setBusy("");
    }
  }

  const chosen = [...selected];
  const writesOn = preview?.resyncWritesEnabled === true;

  return (
    <section className="mt-8 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5" data-gini-resync="true">
      <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">{t.giniResyncTitle}</p>
      <p className="mt-2 text-sm text-brown/70">{t.giniResyncHint}</p>
      <p className="mt-2 text-sm text-brown/60">{t.giniResyncContract}</p>
      <p className="mt-2 text-sm text-brown/60">{writesOn ? t.giniResyncWritesOn : t.giniResyncWritesOff}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={Boolean(busy)} onClick={runPreview} data-gini-resync-preview="true">
          {t.giniResyncPreviewButton}
        </button>
      </div>
      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mt-4 text-sm text-emerald-800">{message}</p> : null}

      {preview ? (
        <div className="mt-5" data-gini-resync-preview-result="true">
          <p className="text-sm text-brown/60">{t.giniResyncReadOnly}</p>
          <p className="mt-2 text-sm text-brown/70" dir="ltr" data-gini-resync-account={preview.account?.clientId || ""}>
            {t.giniResyncAccount}: {preview.account?.clientId || "—"} · {preview.account?.baseHost || "—"}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Stat label={t.giniResyncConfirmed} value={count(preview.confirmed)} marker="data-gini-resync-confirmed" />
            <Stat label={t.giniResyncExisting} value={count(preview.stillExisting)} marker="data-gini-resync-existing" />
            <Stat label={t.giniResyncMissing} value={count(preview.verifiedMissing)} marker="data-gini-resync-missing" />
            <Stat label={t.giniResyncEligible} value={count(preview.eligible)} marker="data-gini-resync-eligible" />
            <Stat label={t.giniResyncBlocked} value={count(preview.blocked)} marker="data-gini-resync-blocked" />
            <Stat label={t.giniResyncReconcile} value={count(preview.reconciliation)} marker="data-gini-resync-reconcile" />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-brown">
              <input
                type="checkbox"
                checked={allEligibleSelected}
                disabled={!eligible.length || Boolean(busy)}
                onChange={(event) => toggleAll(event.target.checked)}
                data-gini-resync-select-all="true"
              />
              {t.giniResyncSelectAll} ({count(eligible.length)})
            </label>
            <button
              type="button"
              className={GHOST}
              disabled={!writesOn || chosen.length !== 1 || Boolean(busy)}
              onClick={() => send(chosen, "one")}
              data-gini-resync-one="true"
            >
              {t.giniResyncSendOne}
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={!writesOn || !chosen.length || Boolean(busy)}
              onClick={() => send(chosen, "selected")}
              data-gini-resync-send="true"
            >
              {t.giniResyncSendSelected} ({count(chosen.length)})
            </button>
          </div>

          <ProductList
            t={t}
            title={t.giniResyncMissingList}
            rows={preview.missingEligible}
            marker="data-gini-resync-missing-list"
            showCheck
            selected={selected}
            onToggle={toggle}
          />
          <ProductList t={t} title={t.giniResyncExistingList} rows={preview.existingProducts} marker="data-gini-resync-existing-list" />
          <ProductList t={t} title={t.giniResyncBlockedList} rows={preview.blockedProducts} marker="data-gini-resync-blocked-list" />
          <div data-gini-resync-reconcile-list="true">
            <ProductList
              t={t}
              title={t.giniResyncReconcileList}
              rows={preview.reconciliationProducts}
              tone="bg-amber-50 text-amber-950"
            />
            {preview.reconciliationProducts?.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {preview.reconciliationProducts.map((row) => (
                  <button
                    key={`reconcile-${row.sku}`}
                    type="button"
                    className={GHOST}
                    disabled={Boolean(busy) || !row.sku}
                    onClick={() => reconcile(row.sku)}
                    data-gini-resync-reconcile-sku={row.sku}
                  >
                    {t.giniResyncReconcileButton} · {row.sku}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {results.length ? (
        <div className="mt-5" data-gini-resync-results="true">
          <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">{t.giniResyncResult}</p>
          <ul className="mt-3 space-y-2 text-sm">
            {results.map((row) => (
              <li key={`${row.sku}-${row.code}-${row.giniProductId || ""}`} className="rounded-2xl bg-cream px-4 py-3" data-gini-resync-result={row.sku || ""}>
                <span className="font-semibold text-brown" dir="ltr">
                  {row.sku}
                </span>
                {row.code ? <span className="text-brown/50"> · {row.code}</span> : null}
                {row.previousGiniProductId ? <span className="text-brown/50" dir="ltr"> · {row.previousGiniProductId}</span> : null}
                {row.giniProductId ? <span className="text-brown/50" dir="ltr"> · {row.giniProductId}</span> : null}
                {row.message ? <span className="mt-1 block text-brown/70">{row.message}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
