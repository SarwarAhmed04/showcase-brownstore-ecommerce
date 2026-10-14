import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { tName } from "../../i18n";
import AdminModal from "./AdminModal";
import Spinner from "../Spinner";

const BUTTON = "rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST = "rounded-full bg-white px-4 py-2 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

function formatWhen(value, never) {
  if (!value) return never;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return never;
  return date.toLocaleString();
}

function fill(template, values) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value ?? 0)),
    template || ""
  );
}

function reasonText(t, code) {
  return String(code || "")
    .split(";")
    .map((part) => t[`miswagReason_${part.trim()}`] || part.trim())
    .filter(Boolean)
    .join(" · ");
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-brown/5">
      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl text-brown">{value}</p>
    </div>
  );
}

export default function MiswagSync({ t, lang }) {
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState({ products: [], pagination: { page: 1, pages: 1 } });
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const searchTimer = useRef(null);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState([]);
  const [testId, setTestId] = useState("");
  const [preview, setPreview] = useState(null);
  const [publishResults, setPublishResults] = useState([]);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    Promise.all([api.miswagSyncSummary(), api.miswagProducts({ q, status, page, limit: 20 })])
      .then(([nextSummary, nextRows]) => {
        if (ignore) return;
        setSummary(nextSummary);
        setRows(nextRows);
      })
      .catch((err) => {
        if (!ignore) setError(err.message);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [q, status, page, reload]);

  async function run(action, success) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      setMessage(typeof success === "function" ? success(result) : success);
      setReload((value) => value + 1);
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function progressText(result) {
    if (!result) return "";
    return fill(t.miswagBatchResult, result);
  }

  function toggle(id) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  const filters = [
    ["", t.miswagFilterAll],
    ["eligible", t.miswagEligible],
    ["synced", t.miswagSynced],
    ["pending", t.miswagPending],
    ["processing", t.miswagProcessing],
    ["failed", t.miswagFailed],
    ["skipped", t.miswagSkipped],
    ["unmapped", t.miswagUnmapped],
  ];

  return (
    <section className="min-w-0">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t.miswagEligible} value={summary?.eligible ?? "—"} />
        <Stat label={t.miswagSynced} value={summary?.synced ?? "—"} />
        <Stat label={t.miswagPending} value={summary?.pending ?? "—"} />
        <Stat label={t.miswagProcessing} value={summary?.processing ?? "—"} />
        <Stat label={t.miswagFailed} value={summary?.failed ?? "—"} />
        <Stat label={t.miswagSkipped} value={summary?.skipped ?? "—"} />
        <Stat label={t.miswagUnmapped} value={summary?.unmapped ?? "—"} />
        <Stat label={t.miswagLastSuccess} value={formatWhen(summary?.lastSuccessfulSyncAt, t.miswagNever)} />
      </div>
      <p className="mt-4 text-sm text-brown/55">{t.miswagSyncDoesNotPublish}</p>
      <p className="mt-1 text-sm text-brown/55">{t.miswagPublishReadyHint}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={busy || !testId}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setPreview(await api.miswagPreviewProduct(testId));
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t.miswagPreview}
        </button>
        <button type="button" className={BUTTON} disabled={busy || !testId} onClick={() => run(() => api.miswagTestSync(testId), () => t.miswagSendTest)}>
          {t.miswagSendTest}
        </button>
        <button type="button" className={GHOST} disabled={busy || !testId} onClick={() => run(() => api.miswagSyncPrice(testId), () => t.miswagSyncPrice)}>
          {t.miswagSyncPrice}
        </button>
        <button type="button" className={GHOST} disabled={busy || !testId} onClick={() => run(() => api.miswagSyncStock(testId), () => t.miswagSyncStock)}>
          {t.miswagSyncStock}
        </button>
        <button type="button" className={GHOST} disabled={busy} onClick={() => run(() => api.miswagRetryFailed(), progressText)}>
          {t.miswagRetryFailed}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || !selected.length}
          onClick={() => run(() => api.miswagSyncSelected(selected), progressText)}
        >
          {t.miswagSyncSelected} ({selected.length})
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => {
            if (!window.confirm(t.miswagSyncAllConfirm)) return;
            run(() => api.miswagSyncEligible(), progressText);
          }}
        >
          {t.miswagSyncAll}
        </button>
        <button
          type="button"
          className={GHOST}
          disabled={busy || !selected.length}
          onClick={() => {
            if (!window.confirm(t.miswagPublishConfirm)) return;
            run(async () => {
              const result = await api.miswagPublishSelected(selected);
              setPublishResults([...(result.results || []), ...(result.notReady || [])]);
              return result;
            }, () => t.miswagPublishResults);
          }}
        >
          {t.miswagPublishSelected}
        </button>
        <button
          type="button"
          className={GHOST}
          disabled={busy}
          onClick={() => {
            if (!window.confirm(t.miswagPublishConfirm)) return;
            run(async () => {
              const result = await api.miswagPublishReady();
              setPublishResults([...(result.results || []), ...(result.notReady || [])]);
              return result;
            }, (result) => `${t.miswagPublishResults} ${result?.remaining ?? 0}`);
          }}
        >
          {t.miswagPublishReady}
        </button>
      </div>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mt-3 text-sm text-brown/70">{message}</p> : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {filters.map(([id, label]) => (
          <button key={id || "all"} type="button" className={status === id ? BUTTON : GHOST} onClick={() => { setStatus(id); setPage(1); }}>
            {label}
          </button>
        ))}
      </div>
      <input
        value={search}
        onChange={(event) => {
          const value = event.target.value;
          setSearch(value);
          clearTimeout(searchTimer.current);
          searchTimer.current = setTimeout(() => {
            setPage(1);
            setQ(value.trim());
          }, 250);
        }}
        placeholder={t.miswagSearchProducts}
        className="mt-4 w-full rounded-full border border-brown/10 bg-white px-4 py-2.5 text-sm text-brown outline-none"
      />

      {loading ? (
        <div className="mt-8 flex justify-center"><Spinner /></div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-3xl bg-white shadow-sm ring-1 ring-brown/5">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="text-xs tracking-wide text-brown/45 uppercase">
              <tr>
                <th className="px-4 py-3">{t.miswagSelected}</th>
                <th className="px-4 py-3">{t.productName}</th>
                <th className="px-4 py-3">{t.sku}</th>
                <th className="px-4 py-3">{t.miswagPlatformPrice}</th>
                <th className="px-4 py-3">{t.miswagStatus}</th>
                <th className="px-4 py-3">{t.miswagActions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.products?.length ? rows.products.map((product) => (
                <tr key={product.id} className="border-t border-brown/5 align-top">
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.includes(product.id)} onChange={() => toggle(product.id)} />
                  </td>
                  <td className="px-4 py-3">{tName(product.name, lang)}</td>
                  <td className="px-4 py-3">{product.sku || "—"}</td>
                  <td className="px-4 py-3">{Number(product.platformPrice || 0).toLocaleString("en-US")}</td>
                  <td className="px-4 py-3">
                    <div>{product.syncStatus}</div>
                    {product.lastError ? <div className="mt-1 text-xs text-red-700">{reasonText(t, product.lastError)}</div> : null}
                    {product.asyncJobId ? <div className="mt-1 text-xs text-brown/50">{t.miswagJob}: {product.asyncJobStatus || product.asyncJobId}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={testId === product.id ? BUTTON : GHOST} onClick={() => setTestId(product.id)}>
                        {t.miswagSelectTest}
                      </button>
                      {product.asyncJobId ? (
                        <button
                          type="button"
                          className={GHOST}
                          disabled={busy}
                          onClick={() => run(() => api.miswagJob(product.asyncJobId), (result) => result?.job?.status || t.miswagRefreshJob)}
                        >
                          {t.miswagRefreshJob}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              )) : (
                <tr><td className="px-4 py-6 text-brown/50" colSpan={6}>{t.miswagNoProducts}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between text-sm">
        <button type="button" className={GHOST} disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t.miswagPrev}</button>
        <span>{page} / {rows.pagination?.pages || 1}</span>
        <button type="button" className={GHOST} disabled={page >= (rows.pagination?.pages || 1)} onClick={() => setPage((value) => value + 1)}>{t.miswagNext}</button>
      </div>

      {publishResults.length ? (
        <div className="mt-4 rounded-3xl bg-white p-4 text-sm shadow-sm ring-1 ring-brown/5">
          <p className="font-semibold">{t.miswagPublishResults}</p>
          <ul className="mt-2 space-y-1">
            {publishResults.map((row) => (
              <li key={row.id}>{row.id}: {row.status}{row.errors?.length ? ` — ${row.errors.join(", ")}` : ""}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview ? (
        <AdminModal onClose={() => setPreview(null)}>
          <div className="w-full max-w-3xl rounded-3xl bg-cream p-6">
            <h3 className="font-display text-2xl">{t.miswagPreview}</h3>
            <p className="mt-2 text-sm">{tName(preview.product?.name, lang)} · {t.miswagPlatformPrice}: {preview.platformPrice}</p>
            <p className="mt-1 text-sm text-brown/60">{preview.categoryMapping?.externalPath || preview.categoryMapping?.status || t.miswagUnmapped}</p>
            {preview.errors?.length ? (
              <div className="mt-3 text-sm text-red-700">
                <p className="font-semibold">{t.miswagValidation}</p>
                <ul>{preview.errors.map((code) => <li key={code}>{reasonText(t, code)}</li>)}</ul>
              </div>
            ) : null}
            {preview.warnings?.length ? (
              <p className="mt-3 text-sm text-brown/60">{t.miswagWarnings}: {preview.warnings.join(", ")}</p>
            ) : null}
            <pre className="mt-4 max-h-[50vh] overflow-auto rounded-2xl bg-white p-4 text-xs">{JSON.stringify(preview.payload, null, 2)}</pre>
          </div>
        </AdminModal>
      ) : null}
    </section>
  );
}
