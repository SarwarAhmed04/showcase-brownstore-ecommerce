import { useEffect, useState } from "react";
import { api } from "../../../api";
import { useLang } from "../../../context/LangContext";
import MiswagSyncAll from "./MiswagSyncAll";
import MiswagSyncOneProduct from "./MiswagSyncOneProduct";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST =
  "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

function statusLabel(t, status) {
  if (status === "connected") return t.miswagStatusConnected;
  if (status === "testing") return t.miswagStatusTesting;
  if (status === "auth_failed") return t.miswagStatusAuthFailed;
  if (status === "forbidden") return t.miswagStatusForbidden;
  if (status === "not_found") return t.miswagStatusNotFound;
  if (status === "rate_limited") return t.miswagStatusServerError;
  if (status === "server_error") return t.miswagStatusServerError;
  if (status === "network_error") return t.miswagStatusNetworkError;
  return t.miswagStatusNotConfigured;
}

function statusTone(status) {
  if (status === "connected") return "bg-emerald-50 text-emerald-800";
  if (status === "testing") return "bg-amber-50 text-amber-900";
  if (status === "auth_failed" || status === "forbidden" || status === "not_found") {
    return "bg-red-50 text-red-800";
  }
  if (status === "server_error" || status === "rate_limited" || status === "network_error") {
    return "bg-orange-50 text-orange-900";
  }
  return "bg-brown/5 text-brown/60";
}

export default function MiswagApiConnection({ t }) {
  const { lang } = useLang();
  const [connection, setConnection] = useState(null);
  const [baseUrl, setBaseUrl] = useState("https://seller-api.miswag.com");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [diagnostics, setDiagnostics] = useState(null);
  const [uiStatus, setUiStatus] = useState("not_configured");

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError("");
    api
      .miswagConnection()
      .then((data) => {
        if (ignore) return;
        setConnection(data);
        setBaseUrl(data.baseUrl || "https://seller-api.miswag.com");
        setApiKey("");
        setApiSecret("");
        setUiStatus(data.status || "not_configured");
        setDiagnostics(data.diagnostics || null);
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
  }, []);

  async function onSave(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const body = { baseUrl: baseUrl.trim() };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      if (apiSecret.trim()) body.apiSecret = apiSecret.trim();
      const data = await api.saveMiswagConnection(body);
      setConnection(data);
      setUiStatus(data.status || "not_configured");
      setDiagnostics(data.diagnostics || null);
      setApiKey("");
      setApiSecret("");
      setMessage(t.miswagConnectionSaved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setUiStatus("testing");
    setError("");
    setMessage("");
    try {
      const body = { baseUrl: baseUrl.trim() };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      if (apiSecret.trim()) body.apiSecret = apiSecret.trim();
      const data = await api.testMiswagConnection(body);
      setDiagnostics(data.diagnostics || null);
      // Prefer server connection status so a successful HEAD alone cannot leave a stale Connected badge.
      const nextStatus =
        data.connection?.status || data.status || (data.ok ? "connected" : "server_error");
      setUiStatus(nextStatus);
      if (data.connection) setConnection(data.connection);
      if (data.ok) {
        setMessage(data.message || t.miswagConnectionOk);
        setApiKey("");
        setApiSecret("");
      } else {
        const detail = [data.message || t.miswagConnectionFail];
        if (data.operation) detail.push(`Operation: ${data.operation}`);
        else if (data.method || data.endpoint) {
          detail.push(`Operation: ${[data.method, data.endpoint].filter(Boolean).join(" ")}`);
        }
        setError(detail.join(" · "));
      }
    } catch (err) {
      setUiStatus("network_error");
      setError(err.message);
    } finally {
      setTesting(false);
    }
  }

  const syncEnabled = connection?.syncEnabled === true && uiStatus === "connected";
  const secretHint = connection?.hasApiSecret || connection?.secretSet
    ? t.miswagSecretKeepHint
    : t.miswagSecretRequiredHint;
  const keyHint = connection?.apiKeyPrefix
    ? `${t.miswagKeyConfigured}: ${connection.apiKeyPrefix}`
    : t.miswagKeyRequiredHint;

  if (loading) {
    return <p className="text-sm text-brown/45">{t.loading}</p>;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
              {t.miswagApiConnection}
            </p>
            <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.miswagApiConnectionHint}</p>
          </div>
          <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${statusTone(uiStatus)}`}>
            {testing ? statusLabel(t, "testing") : statusLabel(t, uiStatus)}
          </span>
        </div>

        <form onSubmit={onSave} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brown/50">{t.miswagBaseUrl}</label>
            <input
              dir="ltr"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={busy || testing || connection?.envLocked?.baseUrl}
              className={CONTROL}
              placeholder="https://seller-api.miswag.com"
              required
            />
            {connection?.envLocked?.baseUrl ? (
              <p className="mt-1 text-xs text-brown/45">{t.miswagEnvLocked}</p>
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-brown/50">{t.miswagApiKeyField}</label>
            <input
              dir="ltr"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={busy || testing || connection?.envLocked?.apiKey}
              className={CONTROL}
              placeholder={connection?.apiKeyPrefix || "ak_prd_…"}
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-brown/45">{keyHint}</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-brown/50">{t.miswagApiSecretField}</label>
            <input
              dir="ltr"
              type="password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              disabled={busy || testing || connection?.envLocked?.apiSecret}
              className={CONTROL}
              placeholder="••••••••••••"
              autoComplete="new-password"
            />
            <p className="mt-1 text-xs text-brown/45">{secretHint}</p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={busy || testing} className={BUTTON}>
              {busy ? t.saving : t.save}
            </button>
            <button type="button" disabled={busy || testing} onClick={onTest} className={GHOST}>
              {testing ? t.miswagStatusTesting : t.miswagTestConnection}
            </button>
          </div>
        </form>

        {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
        {message ? <p className="mt-4 text-sm text-emerald-800">{message}</p> : null}
        {connection?.persistence?.temporary ? (
          <p className="mt-4 text-sm text-amber-900">{connection.persistence.temporary}</p>
        ) : null}
        <p className="mt-4 text-xs text-brown/45">{t.miswagCredentialSourceHint}</p>
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.miswagDiagnostics}
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {[
            [t.miswagDiagBaseUrl, diagnostics?.baseUrl || connection?.baseUrl || "—"],
            [t.miswagDiagEndpoint, diagnostics?.endpoint || connection?.healthcheckPath || "—"],
            [t.miswagDiagHttpStatus, diagnostics?.httpStatus || "—"],
            [t.miswagDiagResponseTime, diagnostics?.responseMs != null ? `${diagnostics.responseMs} ms` : "—"],
            [
              t.miswagDiagAuth,
              diagnostics?.authOk ? t.miswagDiagAuthOk : t.miswagDiagAuthFail,
            ],
            [t.miswagDiagError, diagnostics?.error || "—"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-cream px-4 py-3">
              <dt className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</dt>
              <dd className="mt-1 break-all text-sm font-semibold text-brown" dir="ltr">
                {String(value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.miswagSyncSection}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.miswagSyncLockedHint}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled className={BUTTON} title={t.miswagSyncDisabledTitle}>
            {t.miswagSyncProducts}
          </button>
          <button type="button" disabled className={GHOST} title={t.miswagSyncDisabledTitle}>
            {t.miswagBulkActions}
          </button>
        </div>
        <p className="mt-3 text-xs text-brown/45">
          {syncEnabled ? t.miswagSyncReadyLater : t.miswagSyncNeedsConnection}
        </p>
      </section>

      <MiswagSyncOneProduct t={t} lang={lang} syncEnabled={syncEnabled} />
      <MiswagSyncAll t={t} syncEnabled={syncEnabled} />
    </div>
  );
}
