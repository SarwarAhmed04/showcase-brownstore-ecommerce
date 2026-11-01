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

export default function ElryanSyncAll({ t }) {
  const [job, setJob] = useState(null);
  const [samples, setSamples] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    const data = await api.elryanSyncAllStatus();
    setJob(data.job || null);
    setSamples(data.job?.blockedSamples || []);
    return data;
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  useEffect(() => {
    if (!job || !["running", "paused"].includes(job.status)) return undefined;
    const id = setInterval(() => {
      refresh().catch(() => {});
    }, 2500);
    return () => clearInterval(id);
  }, [job?.status]);

  async function run(action, label) {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      const data = await action();
      if (data.job) {
        setJob(data.job);
        setSamples(data.job.blockedSamples || []);
      }
      setMessage(data.message || t.elryanSyncUpdated);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  const active = job && ["running", "paused"].includes(job.status);

  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.elryanSyncAllTitle}
          </p>
          <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.elryanSyncAllHint}</p>
        </div>
        <span className="rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900">
          {t.elryanSyncWritesDisabled}
        </span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl bg-cream px-4 py-4">
          <p className="text-xs font-semibold tracking-wide text-brown/50 uppercase">{t.elryanFullSyncTitle}</p>
          <p className="mt-1 text-sm text-brown/60">{t.elryanFullSyncHint}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(busy) || active}
              className={BUTTON}
              onClick={() => run(() => api.elryanSyncAllPreview("full"), "full-preview")}
            >
              {busy === "full-preview" ? t.loading : t.elryanRunFullPreview}
            </button>
            <button type="button" className={BUTTON} disabled title={t.elryanSyncWritesDisabled}>
              {t.elryanStartFullSync}
            </button>
          </div>
        </div>
        <div className="rounded-2xl bg-cream px-4 py-4">
          <p className="text-xs font-semibold tracking-wide text-brown/50 uppercase">{t.elryanChangedSyncTitle}</p>
          <p className="mt-1 text-sm text-brown/60">{t.elryanChangedSyncHint}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(busy) || active}
              className={BUTTON}
              onClick={() => run(() => api.elryanSyncAllPreview("changed"), "changed-preview")}
            >
              {busy === "changed-preview" ? t.loading : t.elryanRunChangedPreview}
            </button>
            <button type="button" className={BUTTON} disabled title={t.elryanSyncWritesDisabled}>
              {t.elryanStartChangedSync}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={Boolean(busy) || job?.status !== "running"}
          className={GHOST}
          onClick={() => run(() => api.elryanSyncAllPause(), "pause")}
        >
          {t.elryanPause}
        </button>
        <button
          type="button"
          disabled={Boolean(busy) || job?.status !== "paused"}
          className={GHOST}
          onClick={() => run(() => api.elryanSyncAllResume(), "resume")}
        >
          {t.elryanResume}
        </button>
        <button
          type="button"
          disabled={Boolean(busy) || !active}
          className={GHOST}
          onClick={() => run(() => api.elryanSyncAllStop(), "stop")}
        >
          {t.elryanStop}
        </button>
      </div>

      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mt-4 text-sm text-emerald-800">{message}</p> : null}

      {job ? (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-brown/60">
            {t.status}: <span className="font-semibold text-brown">{job.status}</span>
            {job.environment ? ` · ${job.environment}` : ""}
            {job.strategy ? ` · ${job.strategy}` : ""}
            {job.percent != null ? ` · ${job.percent}%` : ""}
          </p>
          {job.warrantySummary?.message ? (
            <p className="text-sm text-brown/70">
              <span className="font-semibold">{job.warrantySummary.status}.</span> {job.warrantySummary.message}
            </p>
          ) : null}
          {job.pricingSummary?.message ? (
            <p className="text-sm text-brown/70">{job.pricingSummary.message}</p>
          ) : null}
          {job.packageDimensions?.note ? (
            <p className="text-sm text-brown/60">{job.packageDimensions.note}</p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={t.elryanSyncScanned} value={`${job.scanned ?? job.processed ?? 0} / ${job.total ?? 0}`} />
            <Stat label={t.elryanSyncReady} value={job.ready ?? 0} />
            <Stat label={t.elryanSyncNew} value={job.newCount ?? 0} />
            <Stat label={t.elryanSyncChanged} value={job.changedCount ?? 0} />
            <Stat label={t.elryanSyncUnchanged} value={job.unchangedCount ?? 0} />
            <Stat label={t.elryanSyncBlocked} value={job.skipped ?? 0} />
            <Stat label={t.elryanSyncInactive} value={job.inactive ?? 0} />
            <Stat label={t.elryanSyncFailed} value={job.failed ?? 0} />
            <Stat label={t.elryanSyncMissingCategory} value={job.missingCategory ?? 0} />
            <Stat label={t.elryanSyncMissingBrand} value={job.missingBrand ?? 0} />
            <Stat label={t.elryanSyncMissingColor} value={job.missingColor ?? 0} />
            <Stat label={t.elryanSyncWarrantyUnverified} value={job.warrantyUnverified ?? 0} />
            <Stat label={t.elryanSyncPricingUnverified} value={job.pricingUnverified ?? 0} />
            <Stat label={t.elryanSyncMissingRequired} value={job.missingRequired ?? 0} />
            <Stat label={t.elryanSyncVariationBlocked} value={job.variationBlocked ?? 0} />
          </div>
          <p className="text-xs text-brown/45">{t.elryanSyncPreviewNote}</p>
          {samples.length ? (
            <ul className="space-y-2 text-sm text-brown/70">
              {samples.slice(0, 8).map((row) => (
                <li key={row.productId} className="rounded-2xl bg-cream px-4 py-3">
                  <span className="font-semibold text-brown">{row.sku || row.productId}</span>
                  <span className="mt-1 block">{row.reason || row.status}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="mt-6 text-sm text-brown/55">{t.elryanSyncNoJob}</p>
      )}
    </section>
  );
}
