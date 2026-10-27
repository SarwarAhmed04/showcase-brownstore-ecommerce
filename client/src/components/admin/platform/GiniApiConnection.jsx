import { useEffect, useState } from "react";
import { api } from "../../../api";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST =
  "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

const DEFAULT_BASE = "https://merchant.gini.iq";

function statusLabel(t, status) {
  if (status === "connected") return t.giniStatusConnected;
  if (status === "configured") return t.giniStatusConfigured;
  if (status === "testing") return t.giniStatusTesting;
  if (status === "auth_failed") return t.giniStatusAuthFailed;
  if (status === "forbidden") return t.giniStatusForbidden;
  if (status === "rate_limited") return t.giniStatusRateLimited;
  if (status === "server_error") return t.giniStatusServerError;
  if (status === "edge_blocked") return t.giniStatusEdgeBlocked;
  if (status === "host_unverified") return t.giniStatusHostUnverified;
  if (status === "connection_failed" || status === "network_error") return t.giniStatusConnectionFailed;
  return t.giniStatusNotConfigured;
}

function statusTone(status) {
  if (status === "connected") return "bg-emerald-50 text-emerald-800";
  if (status === "configured" || status === "testing") return "bg-amber-50 text-amber-900";
  if (status === "auth_failed" || status === "forbidden" || status === "edge_blocked") {
    return "bg-red-50 text-red-800";
  }
  if (status === "server_error" || status === "rate_limited" || status === "host_unverified" || status === "connection_failed") {
    return "bg-orange-50 text-orange-900";
  }
  return "bg-brown/5 text-brown/60";
}

export default function GiniApiConnection({ t }) {
  const [connection, setConnection] = useState(null);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [uiStatus, setUiStatus] = useState("not_configured");
  const [categories, setCategories] = useState(null);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    api
      .giniConnection()
      .then((data) => {
        if (ignore) return;
        setConnection(data);
        setBaseUrl(data.baseUrl || DEFAULT_BASE);
        setClientId(data.clientId || "");
        setClientSecret("");
        setUiStatus(data.status || "not_configured");
        setCategories(data.categories || null);
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

  function applyConnection(data) {
    setConnection(data);
    setUiStatus(data.status || "not_configured");
    if (data.baseUrl) setBaseUrl(data.baseUrl);
    if (data.clientId != null) setClientId(data.clientId);
    setCategories(data.categories || null);
  }

  async function onSave(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const body = { baseUrl: baseUrl.trim(), clientId: clientId.trim() };
      if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
      const data = await api.saveGiniConnection(body);
      applyConnection(data);
      setClientSecret("");
      setMessage(t.giniConnectionSaved);
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
      const body = { baseUrl: baseUrl.trim(), clientId: clientId.trim() };
      if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
      const data = await api.testGiniConnection(body);
      if (data.connection) setConnection(data.connection);
      setUiStatus(data.status || data.connection?.status || "connection_failed");
      setCategories(data.categories || data.connection?.categories || null);
      if (data.ok) setMessage(data.message || t.giniConnectionOk);
      else setError(data.message || t.giniConnectionFail);
      setClientSecret("");
    } catch (err) {
      setUiStatus("connection_failed");
      setError(err.message || t.giniConnectionFail);
    } finally {
      setTesting(false);
    }
  }

  const hosts = connection?.officialHosts?.length
    ? connection.officialHosts
    : [DEFAULT_BASE, "https://app.gini.iq"];
  const secretHint = connection?.hasSecret ? t.giniSecretSaved : t.giniSecretRequired;

  if (loading) return <p className="text-sm text-brown/45">{t.loading}</p>;

  return (
    <div className="space-y-6">
      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">{t.giniApiConnection}</p>
            <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.giniApiConnectionHint}</p>
          </div>
          <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${statusTone(uiStatus)}`}>
            {testing ? statusLabel(t, "testing") : statusLabel(t, uiStatus)}
          </span>
        </div>

        <form onSubmit={onSave} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brown/50" htmlFor="gini-base-url">
              {t.giniBaseUrl}
            </label>
            <select
              id="gini-base-url"
              dir="ltr"
              value={hosts.includes(baseUrl) ? baseUrl : DEFAULT_BASE}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={busy || testing}
              className={CONTROL}
            >
              {hosts.map((host) => (
                <option key={host} value={host}>
                  {host}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-brown/45">{t.giniBaseUrlHint}</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-brown/50" htmlFor="gini-client-id">
              {t.giniClientId}
            </label>
            <input
              id="gini-client-id"
              dir="ltr"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              disabled={busy || testing}
              className={CONTROL}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-brown/50" htmlFor="gini-client-secret">
              {t.giniClientSecret}
            </label>
            <input
              id="gini-client-secret"
              dir="ltr"
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              disabled={busy || testing}
              className={CONTROL}
              autoComplete="new-password"
              placeholder={connection?.hasSecret ? t.giniSecretSaved : ""}
            />
            <p className="mt-1 text-xs text-brown/45">{secretHint}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || testing} className={BUTTON}>
              {busy ? t.loading : t.giniSaveConnection}
            </button>
            <button type="button" onClick={onTest} disabled={busy || testing} className={GHOST}>
              {testing ? t.loading : t.giniTestConnection}
            </button>
            <button
              type="button"
              disabled={busy || testing}
              onClick={() => setBaseUrl(connection?.alternateHost || "https://app.gini.iq")}
              className={GHOST}
            >
              {t.giniUseAlternateHost}
            </button>
          </div>
        </form>

        {message ? <p className="mt-4 text-sm text-emerald-800">{message}</p> : null}
        {error ? <p className="mt-4 text-sm text-red-800">{error}</p> : null}
        {categories?.ok ? (
          <p className="mt-3 text-sm text-brown/70">
            {t.giniCategoriesRead.replace("{count}", String(categories.topLevelCount || 0))}
          </p>
        ) : null}
        <p className="mt-4 text-xs text-brown/45">{t.giniReadOnlyNote}</p>
      </section>
    </div>
  );
}
