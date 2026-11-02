import { useEffect, useState } from "react";
import { api } from "../../../api";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON = "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST =
  "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

const STATE_KEYS = {
  preview_running: "giniSyncStatePreviewRunning",
  preview: "giniSyncStatePreview",
  running: "giniSyncStateRunning",
  paused: "giniSyncStatePaused",
  completed: "giniSyncStateCompleted",
  stopped: "giniSyncStateStopped",
  auth_failed: "giniSyncStateAuthFailed",
  rate_limited: "giniSyncStateRateLimited",
  edge_blocked: "giniSyncStateEdgeBlocked",
  failed: "giniSyncStateFailed",
  stale: "giniSyncStateStale",
};

function count(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function fill(template, value) {
  return String(template || "").replace("{count}", count(value));
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl bg-cream px-4 py-3">
      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums text-brown">{value ?? "—"}</p>
    </div>
  );
}

function approvedPreview(status) {
  const preview = status?.preview?.status === "preview" && status.preview.finishedAt ? status.preview : null;
  const job = status?.job;
  if (preview) return preview;
  if (job?.mode === "preview" && job.status === "preview" && job.finishedAt) return job;
  return null;
}

export default function GiniSyncAll({ t }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [limit, setLimit] = useState("1");

  async function refresh() {
    const data = await api.giniSyncAllStatus();
    setStatus(data);
    return data;
  }

  useEffect(() => {
    let cancelled = false;
    refresh().catch((err) => {
      if (!cancelled) setError(err.message);
    });
    const id = setInterval(() => {
      refresh().catch(() => {});
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function run(action, label) {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      const data = await action();
      if (data?.job || data?.writesEnabled != null) setStatus((current) => ({ ...(current || {}), ...data }));
      setMessage(data?.message || t.giniSyncUpdated);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
      refresh().catch(() => {});
    }
  }

  const job = status?.job || null;
  const approved = approvedPreview(status);
  const writesEnabled = status?.writesEnabled === true;
  const active = job && ["preview_running", "running", "paused", "auth_failed", "rate_limited", "edge_blocked"].includes(job.status);
  const current = active ? job : approved || job;
  const percent = Number(current?.percent) || 0;
  const ready = Number(approved?.readyCreate) || 0;
  const maxLimit = Number(status?.limitedRunMax) || 25;
  const parsedLimit = Number(limit);
  const limitOk = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= maxLimit;
  const canSend = writesEnabled && approved && !active && !busy;
  const failures = current?.recentFailures || [];
  const examples = current?.blockerExamples || [];
  const stateLabel = current ? t[STATE_KEYS[current.status]] || current.status : "";

  return (
    <section className="space-y-6" data-gini-sync-all="true">
      <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">{t.giniSyncAllTitle}</p>
            <p className="mt-2 max-w-2xl text-sm text-brown/60">{t.giniSyncAllHint}</p>
          </div>
          <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">
            {t.giniSyncConnected}
          </span>
        </div>
        <p className={`mt-4 rounded-2xl px-4 py-3 text-sm ${writesEnabled ? "bg-amber-50 text-amber-950" : "bg-cream text-brown/70"}`}>
          {writesEnabled ? t.giniSyncAllWritesOn : t.giniSyncAllWritesOff}
        </p>
        <p className="mt-3 text-xs text-brown/45" dir="ltr">
          {t.giniSyncEndpoint}: POST {status?.endpoint || "/api/v2.0/third-party/products"}
        </p>

        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl bg-cream px-4 py-4">
            <p className="text-xs font-semibold tracking-wide text-brown/50 uppercase">{t.giniFullSyncTitle}</p>
            <p className="mt-1 text-sm text-brown/60">{t.giniFullSyncHint}</p>
            <button
              type="button"
              className={`${BUTTON} mt-3`}
              disabled={Boolean(busy)}
              onClick={() => run(() => api.giniSyncAllPreview(), "preview")}
            >
              {busy === "preview" ? t.loading : t.giniRunFullPreview}
            </button>
          </div>
          <div className="rounded-2xl bg-cream px-4 py-4">
            <p className="text-xs font-semibold tracking-wide text-brown/50 uppercase">{t.giniLimitedSyncTitle}</p>
            <p className="mt-1 text-sm text-brown/60">{t.giniLimitedSyncHint}</p>
            <label className="mt-3 block text-sm font-semibold text-brown">
              {t.giniLimitedLimit}
              <input
                type="number"
                min="1"
                max={maxLimit}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                className={`${CONTROL} mt-2`}
              />
            </label>
            <button
              type="button"
              className={`${BUTTON} mt-3`}
              disabled={!canSend || !limitOk}
              onClick={() => {
                if (!canSend || !limitOk) return;
                const sendCount = Math.min(parsedLimit, ready);
                if (!window.confirm(fill(t.giniStartLimitedConfirm, sendCount))) return;
                run(
                  () =>
                    api.giniSyncAllStart({
                      confirm: true,
                      previewJobId: approved.id,
                      catalogSignature: approved.catalogSignature,
                      expectedReady: approved.readyCreate,
                      scope: "limited",
                      limit: parsedLimit,
                    }),
                  "limited"
                );
              }}
            >
              {busy === "limited" ? t.loading : t.giniStartLimitedSync}
            </button>
          </div>
          <div className="rounded-2xl bg-cream px-4 py-4">
            <p className="text-xs font-semibold tracking-wide text-brown/50 uppercase">{t.giniChangedSyncTitle}</p>
            <p className="mt-1 text-sm text-brown/60">{t.giniChangedSyncHint}</p>
            <p className="mt-2 text-sm text-brown/70">{t.giniChangedSyncUnsupported}</p>
            <button type="button" className={`${BUTTON} mt-3`} disabled>
              {t.giniStartChangedSync}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={!canSend || ready < 1}
            onClick={() => {
              if (!canSend || ready < 1) return;
              if (!window.confirm(fill(t.giniStartFullConfirm, ready))) return;
              run(
                () =>
                  api.giniSyncAllStart({
                    confirm: true,
                    previewJobId: approved.id,
                    catalogSignature: approved.catalogSignature,
                    expectedReady: approved.readyCreate,
                    scope: "full",
                    approveFullRun: true,
                  }),
                "full"
              );
            }}
          >
            {busy === "full" ? t.loading : t.giniStartFullSync}
          </button>
          <button type="button" className={GHOST} disabled={Boolean(busy)} onClick={() => run(() => api.giniSyncAllPause(), "pause")}>
            {t.giniPauseSync}
          </button>
          <button type="button" className={GHOST} disabled={Boolean(busy)} onClick={() => run(() => api.giniSyncAllResume(), "resume")}>
            {t.giniResumeSync}
          </button>
          <button type="button" className={GHOST} disabled={Boolean(busy)} onClick={() => run(() => api.giniSyncAllStop(), "stop")}>
            {t.giniStopSync}
          </button>
          <button type="button" className={GHOST} disabled={Boolean(busy)} onClick={() => run(() => api.giniSyncAllStatus(), "refresh")}>
            {t.giniRefreshStatus}
          </button>
        </div>
        {!approved ? <p className="mt-3 text-sm text-brown/50">{t.giniPreviewRequired}</p> : null}
        <p className="mt-3 text-xs text-brown/45">{t.giniSyncPreviewNote}</p>
        {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
        {message ? <p className="mt-4 text-sm text-emerald-800">{message}</p> : null}
      </div>

      <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        {current ? (
          <div className="space-y-4">
            <p className="text-sm text-brown/60">
              {t.status}: <span className="font-semibold text-brown">{stateLabel}</span>
              {current.runScope ? ` · ${current.runScope}` : ""}
            </p>
            <div>
              <div className="flex items-center justify-between text-xs font-semibold text-brown/50">
                <span>{t.giniSyncProgress}</span>
                <span className="tabular-nums">{percent}%</span>
              </div>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-brown/10"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={t.giniSyncProgress}
              >
                <div className="h-full bg-brown" style={{ width: `${percent}%` }} />
              </div>
            </div>
            {current.limitReached ? <p className="text-sm text-brown/70">{t.giniSyncLimitReached}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label={t.giniSyncTotal} value={count(current.total)} />
              <Stat label={t.giniSyncEligible} value={count(current.eligible)} />
              <Stat label={t.giniSyncReady} value={count(current.readyCreate)} />
              <Stat label={t.giniSyncExists} value={count(current.alreadyExists)} />
              <Stat label={t.giniSyncBlocked} value={count(current.blocked)} />
              <Stat label={t.giniSyncInactive} value={count(current.inactive)} />
              <Stat label={t.giniSyncNeedsReview} value={count(current.needsReview)} />
              <Stat label={t.giniSyncLookupUncertain} value={count(current.lookupUncertain)} />
              <Stat label={t.giniSyncCreated} value={count(current.mode === "preview" ? 0 : current.created)} />
              <Stat label={t.giniSyncFailed} value={count(current.failed)} />
              <Stat label={t.giniSyncCreateUncertain} value={count(current.createUncertain)} />
              <Stat label={t.giniSyncProgress} value={`${count(current.processed)} / ${count(current.total)}`} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-brown/50">{t.giniSyncNoJob}</p>
        )}
      </div>

      {examples.length ? (
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">{t.giniBlockerExamples}</p>
          <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto text-sm">
            {examples.map((row) => (
              <li key={`${row.code}-${row.productId}`} className="rounded-2xl bg-cream px-4 py-3" dir="ltr">
                <span className="font-semibold text-brown">{row.sku || row.productId}</span>
                <span className="text-brown/50"> · {row.code}</span>
                {row.message ? <span className="mt-1 block text-brown/70">{row.message}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {failures.length ? (
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">{t.giniRecentFailures}</p>
          <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto text-sm">
            {failures.map((row) => (
              <li key={`${row.productId}-${row.errorCode}-${row.reason}`} className="rounded-2xl bg-cream px-4 py-3" dir="ltr">
                <span className="font-semibold text-brown">{row.sku || row.productId}</span>
                <span className="text-brown/50"> · {row.status}</span>
                {row.errorCode ? <span className="text-brown/50"> · {row.errorCode}</span> : null}
                {row.httpStatus ? <span className="text-brown/50"> · HTTP {row.httpStatus}</span> : null}
                {row.reason ? <span className="mt-1 block text-brown/70">{row.reason}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
