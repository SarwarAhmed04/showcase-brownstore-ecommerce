import { useEffect, useState } from "react";
import { api } from "../../../api";

const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST =
  "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl bg-cream px-4 py-3">
      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums text-brown">{value ?? "—"}</p>
    </div>
  );
}

export default function MiswagSyncAll({ t, syncEnabled: syncEnabledProp }) {
  const [connected, setConnected] = useState(syncEnabledProp === true);
  const [job, setJob] = useState(null);
  const [preview, setPreview] = useState(null);
  const [fullPreview, setFullPreview] = useState(null);
  const [changedPreview, setChangedPreview] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const syncEnabled = syncEnabledProp === true || connected;

  async function refreshConnection() {
    try {
      const data = await api.miswagConnection();
      setConnected(Boolean(data?.syncEnabled || data?.status === "connected"));
    } catch {
      setConnected(false);
    }
  }

  async function refresh() {
    try {
      const data = await api.miswagSyncAllStatus();
      setJob(data.job || null);
    } catch {
      // ignore polling errors
    }
  }

  useEffect(() => {
    refreshConnection();
  }, []);

  useEffect(() => {
    if (!syncEnabled) return undefined;
    refresh();
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [syncEnabled]);

  async function run(action, label) {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      const data = await action();
      if (data.job) setJob(data.job);
      if (data.dryRun) {
        setPreview(data);
        if (data.strategy === "changed" || data.job?.strategy === "changed") setChangedPreview(data);
        else setFullPreview(data);
      }
      setMessage(data.message || t.miswagSyncAllUpdated);
    } catch (err) {
      setError(err.message);
      await refreshConnection();
    } finally {
      setBusy("");
      refresh();
    }
  }

  if (!syncEnabled) {
    return (
      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.miswagSyncAllTitle}
        </p>
        <p className="mt-2 text-sm text-brown/55">{t.miswagSyncNeedsConnection}</p>
      </section>
    );
  }

  const live = job && ["running", "paused", "auth_failed"].includes(job.status) ? job : null;
  const previewTime = preview?.job?.createdAt ? new Date(preview.job.createdAt).getTime() : 0;
  const jobTime = job?.createdAt ? new Date(job.createdAt).getTime() : 0;
  const current = live || (job && jobTime >= previewTime ? job : preview?.job) || job;
  const failures = current?.recentFailures || preview?.job?.blockedSamples || [];
  const showingPreview = !live && current && current === preview?.job;
  const changedView = current?.strategy === "changed";

  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.miswagSyncAllTitle}
          </p>
          <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.miswagSyncAllHint}</p>
        </div>
        <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">
          {t.miswagStatusConnected}
        </span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl bg-cream px-4 py-4">
          <p className="text-xs font-semibold tracking-wide text-brown/50 uppercase">{t.miswagFullSyncTitle}</p>
          <p className="mt-1 text-sm text-brown/60">{t.miswagFullSyncHint}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(busy)}
              className={BUTTON}
              onClick={() => run(() => api.miswagSyncAllPreview("full"), "full-preview")}
            >
              {busy === "full-preview" ? t.loading : t.miswagRunFullPreview}
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !fullPreview?.dryRun}
              className={BUTTON}
              title={!fullPreview?.dryRun ? t.miswagRunFullPreview : undefined}
              onClick={() => {
                if (!fullPreview?.dryRun) return;
                if (!window.confirm(t.miswagStartSyncConfirm)) return;
                run(() => api.miswagSyncAllStart(true, "full"), "full-start");
              }}
            >
              {busy === "full-start" ? t.loading : t.miswagStartFullSync}
            </button>
          </div>
        </div>
        <div className="rounded-2xl bg-cream px-4 py-4">
          <p className="text-xs font-semibold tracking-wide text-brown/50 uppercase">{t.miswagChangedSyncTitle}</p>
          <p className="mt-1 text-sm text-brown/60">{t.miswagChangedSyncHint}</p>
          <p className="mt-2 text-sm text-brown/70">{t.miswagUnchangedNote}</p>
          <p className="mt-2 text-xs text-brown/50">{t.miswagFirstRunNote}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(busy)}
              className={BUTTON}
              onClick={() => run(() => api.miswagSyncAllPreview("changed"), "changed-preview")}
            >
              {busy === "changed-preview" ? t.loading : t.miswagRunChangedPreview}
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !changedPreview?.dryRun}
              className={BUTTON}
              title={!changedPreview?.dryRun ? t.miswagRunChangedPreview : undefined}
              onClick={() => {
                if (!changedPreview?.dryRun) return;
                if (!window.confirm(t.miswagStartChangedConfirm)) return;
                run(() => api.miswagSyncAllStart(true, "changed"), "changed-start");
              }}
            >
              {busy === "changed-start" ? t.loading : t.miswagStartChangedSync}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={Boolean(busy)}
          className={GHOST}
          onClick={() => run(() => api.miswagSyncAllPause(), "pause")}
        >
          {t.miswagPauseSync}
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          className={GHOST}
          onClick={() => run(() => api.miswagSyncAllResume(), "resume")}
        >
          {t.miswagResumeSync}
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          className={GHOST}
          onClick={() => run(() => api.miswagSyncAllStop(), "stop")}
        >
          {t.miswagStopSync}
        </button>
      </div>

      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mt-4 text-sm text-emerald-800">{message}</p> : null}

      {current ? (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-brown/60">
            {t.status}: <span className="font-semibold text-brown">{current.status}</span>
            {current.strategy ? ` · ${t.miswagSyncStrategy}: ${current.strategy}` : ""}
            {current.percent != null ? ` · ${current.percent}%` : ""}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={t.miswagSyncScanned} value={`${current.scanned ?? current.processed ?? 0} / ${current.total ?? 0}`} />
            <Stat label={t.miswagSyncSent} value={showingPreview ? 0 : current.sent ?? current.success ?? 0} />
            <Stat label={t.miswagSyncReady} value={current.ready ?? 0} />
            <Stat label={t.miswagSyncNew} value={current.newCount ?? 0} />
            <Stat label={t.miswagSyncChanged} value={current.changedCount ?? 0} />
            <Stat label={t.miswagSyncUnchanged} value={current.unchangedCount ?? 0} />
            <Stat label={t.miswagSyncBlocked} value={current.skipped ?? 0} />
            <Stat label={t.miswagSyncInactive} value={current.inactive ?? 0} />
            <Stat label={t.miswagSyncFailed} value={current.failed ?? 0} />
            <Stat label={t.miswagSyncMissingMapping} value={current.missingCategory ?? 0} />
            <Stat label={t.miswagSyncMissingBrand} value={current.missingBrand ?? 0} />
            <Stat label={t.miswagSyncMissingColor} value={current.missingColor ?? 0} />
            <Stat label={t.miswagSyncMissingData} value={current.missingData ?? 0} />
          </div>
          {changedView ? <p className="text-sm text-brown/70">{t.miswagUnchangedNote}</p> : null}
          {showingPreview ? (
            <p className="text-xs text-brown/45">
              {t.miswagDryRunNote} · {t.miswagBatchSize}: {preview.batchSize}
            </p>
          ) : null}
        </div>
      ) : null}

      {failures.length ? (
        <div className="mt-6">
          <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">
            {t.miswagRecentFailures}
          </p>
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-2xl bg-cream px-4 py-3 text-sm">
            {failures.map((row) => (
              <li key={`${row.productId}-${row.reason}`} dir="ltr">
                <span className="font-semibold">{row.sku || row.productId}</span>
                {" · "}
                {row.status}
                {" · "}
                {row.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
