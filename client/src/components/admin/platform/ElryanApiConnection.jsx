import { useEffect, useState } from "react";
import { api } from "../../../api";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST =
  "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

function statusTone(status) {
  if (status === "authenticated") return "bg-emerald-50 text-emerald-800";
  if (status === "key_configured" || status === "reachable") return "bg-amber-50 text-amber-900";
  if (status === "auth_rejected" || status === "auth_failed" || status === "config_error") {
    return "bg-red-50 text-red-800";
  }
  if (status === "awaiting_access") return "bg-brown/5 text-brown/60";
  return "bg-brown/5 text-brown/60";
}

function detailLines(connection, t) {
  const lines = [];
  if (!connection) return lines;
  if (connection.decryptionError) lines.push(t.elryanStateConfigError);
  else if (!connection.keyStored && !connection.hasApiKey) lines.push(t.elryanStateKeyMissing);
  else lines.push(t.elryanStateKeyStored);

  if (connection.reachable || connection.status === "reachable" || connection.status === "authenticated") {
    if (connection.authenticated || connection.status === "authenticated") {
      lines.push(t.elryanStateAuthVerified);
    } else {
      lines.push(t.elryanStateReachableUnverified);
    }
  } else if (connection.status === "auth_rejected" || connection.status === "auth_failed") {
    lines.push(t.elryanStateAuthRejected);
  }
  return lines;
}

export default function ElryanApiConnection({ t }) {
  const [connection, setConnection] = useState(null);
  const [environment, setEnvironment] = useState("staging");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    api
      .elryanConnection()
      .then((data) => {
        if (ignore) return;
        setConnection(data);
        setEnvironment(data.environment || "staging");
        setApiKey("");
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
      const body = { environment };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const data = await api.saveElryanConnection(body);
      setConnection(data);
      setApiKey("");
      setMessage(t.elryanConnectionSaved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setError("");
    setMessage("");
    try {
      const body = { environment };
      const temporary = Boolean(apiKey.trim());
      if (temporary) body.apiKey = apiKey.trim();
      const data = await api.testElryanConnection(body);
      if (data.connection) setConnection(data.connection);
      const notes = [];
      if (data.message) notes.push(data.message);
      if (data.temporaryKey && !data.keyPersisted) notes.push(t.elryanTempKeyNotSaved);
      if (data.ok) setMessage(notes.join(" "));
      else setError(notes.join(" ") || t.elryanConnectionFail);
      // Keep pasted key if it was temporary and not saved, so the admin can Save it.
      if (data.keyPersisted || !temporary) setApiKey("");
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-brown/50">{t.loading}</p>;
  }

  const status = connection?.status || "awaiting_access";
  const writesOff = !connection?.writes?.productWritesEnabled;
  const details = detailLines(connection, t);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.elryanApiConnection}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-brown/60">{t.elryanApiConnectionHint}</p>
      </div>

      <div className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusTone(status)}`}>
        {connection?.accessLabel || status}
      </div>

      {details.length ? (
        <ul className="max-w-xl space-y-1 text-sm text-brown/65">
          {details.map((line) => (
            <li key={line}>• {line}</li>
          ))}
        </ul>
      ) : null}

      <form onSubmit={onSave} className="max-w-xl space-y-4 rounded-[1.75rem] bg-white p-5 ring-1 ring-brown/10">
        <div>
          <label className="mb-1 block text-xs font-semibold text-brown/50">{t.elryanEnvironment}</label>
          <select
            className={CONTROL}
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
          >
            <option value="staging">Staging</option>
            <option value="production">Production</option>
          </select>
          <p className="mt-2 text-xs text-brown/45">
            {environment === "production"
              ? "https://marketplace-api.elryan.com/api/v1"
              : "https://staging-marketplace-api.elryan.com/api/v1"}
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brown/50">{t.elryanApiKey}</label>
          <input
            type="password"
            autoComplete="off"
            className={CONTROL}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              connection?.keyStored || connection?.hasApiKey
                ? t.elryanApiKeyConfiguredPlaceholder
                : t.elryanApiKeyPlaceholder
            }
          />
          <p className="mt-2 text-xs text-brown/45">{t.elryanApiKeyHint}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={BUTTON} disabled={busy}>
            {busy ? t.loading : t.save}
          </button>
          <button type="button" className={GHOST} disabled={testing} onClick={onTest}>
            {testing ? t.loading : t.elryanTestConnection}
          </button>
        </div>
      </form>

      <div className="max-w-xl rounded-[1.75rem] bg-cream/60 p-5 text-sm text-brown/70 ring-1 ring-brown/10">
        <p className="font-semibold text-brown">{t.elryanWritesTitle}</p>
        <p className="mt-2">{writesOff ? t.elryanWritesDisabled : t.elryanWritesEnabledCaution}</p>
        <p className="mt-3 text-xs text-brown/45">{t.elryanTestExplainer}</p>
        {connection?.lastError ? (
          <p className="mt-3 text-xs text-red-700">{connection.lastError}</p>
        ) : null}
        {connection?.lastAuthVerifiedAt ? (
          <p className="mt-3 text-xs text-brown/45">
            {t.elryanLastAuth}: {new Date(connection.lastAuthVerifiedAt).toLocaleString()}
          </p>
        ) : null}
      </div>

      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
