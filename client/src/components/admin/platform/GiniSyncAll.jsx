import { useEffect, useState } from "react";
import { api } from "../../../api";
import { canReplaceGiniImage, confirmedCreateCount, giniImageSelectionRequired, reconciliationWarnings, selectGiniSyncDisplay, sendCounter } from "./giniSyncAllDisplay.js";

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

function warningText(t, row) {
  const keys = {
    confirmed_send_missing: "giniSyncReconcileMissing",
    confirmed_send_unverified: "giniSyncReconcileUnverified",
    confirmed_send_id_mismatch: "giniSyncReconcileMismatch",
  };
  return String(t[keys[row.code]] || row.code)
    .replaceAll("{sku}", row.sku || "")
    .replaceAll("{id}", row.giniProductId || "");
}

const PREVIEW_REASON_KEYS = {
  local_payload_hash_differs: "giniChangedReasonHash",
  local_payload_hash_matches: "giniChangedReasonSame",
  historical_sku_unresolved: "giniChangedReasonHistorical",
  confirmed_send_missing: "giniSyncReconcileMissing",
  confirmed_send_unverified: "giniSyncReconcileUnverified",
  confirmed_send_id_mismatch: "giniSyncReconcileMismatch",
  confirmed_send_sku_mismatch: "giniChangedReasonLiveSku",
  confirmed_sku_mismatch: "giniChangedReasonLocalSku",
  confirmed_hash_missing: "giniChangedReasonHashMissing",
};

const FIELD_KEYS = {
  price: "giniChangedFieldPrice",
  quantity: "giniChangedFieldQuantity",
  imageCount: "giniChangedFieldImages",
};

function previewReason(t, row) {
  const key = PREVIEW_REASON_KEYS[row?.code];
  if (key && t[key]) {
    return String(t[key]).replaceAll("{sku}", row.sku || "").replaceAll("{id}", row.giniProductId || "");
  }
  return row?.reason || row?.code || "";
}

function fieldLabel(t, field) {
  return t[FIELD_KEYS[field]] || field;
}

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function imageMark(t, images, url, side) {
  if (side === "previous" && (images?.removed || []).includes(url)) return t.giniImageRemoved;
  if (side === "current" && (images?.added || []).includes(url)) return t.giniImageAdded;
  if ((images?.replaced || []).some((item) => item.url === url)) return t.giniImageReplaced;
  return "";
}

function ImageColumn({ label, urls, mark, name, selected, onSelect }) {
  const visible = (urls || []).map(safeImageUrl).filter(Boolean);
  if (!visible.length) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-brown/50">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {visible.map((url) => (
          <figure key={url} className="w-16">
            {onSelect ? (
              <label className="block">
                <input
                  type="radio"
                  className="mb-1"
                  name={name}
                  value={url}
                  checked={selected === url}
                  onChange={() => onSelect(url)}
                  data-gini-image-choice={name}
                />
                <img src={url} alt={label} className="h-16 w-16 rounded-xl bg-cream object-cover ring-1 ring-brown/10" />
              </label>
            ) : (
              <img src={url} alt={label} className="h-16 w-16 rounded-xl bg-cream object-cover ring-1 ring-brown/10" />
            )}
            {mark(url) ? <figcaption className="mt-1 text-[11px] leading-4 text-brown/70">{mark(url)}</figcaption> : null}
          </figure>
        ))}
      </div>
    </div>
  );
}

function ImageReview({ t, images, sku, selectedDelete, selectedSource, onSelectDelete, onSelectSource }) {
  if (!images) return null;
  const countLine =
    images.savedImageCount == null
      ? ""
      : String(t.giniImageCountLine || "")
          .replaceAll("{old}", String(images.savedImageCount))
          .replaceAll("{new}", String(images.currentImageCount ?? 0));
  const showCurrentOnly = images.verificationNeeded && !(images.previousImages || []).length;
  return (
    <div className="mt-3 rounded-2xl bg-white px-3 py-3 ring-1 ring-brown/10" data-gini-image-review={images.status || ""}>
      {images.verificationNeeded ? <p className="text-sm font-semibold text-brown">{t.giniImageVerificationNeeded}</p> : null}
      {images.verificationNeeded ? <p className="mt-1 text-sm text-brown/70">{t.giniImageVerificationDetail}</p> : null}
      {countLine ? (
        <p className="mt-1 text-sm text-brown/70" dir="ltr">
          {countLine}
        </p>
      ) : null}
      {images.status === "urls_match_content_unverified" ? <p className="mt-1 text-sm text-brown/70">{t.giniImageContentUnverified}</p> : null}
      {images.orderChanged ? <p className="mt-1 text-sm text-brown/70">{t.giniImageOrderUnsupported}</p> : null}
      {images.verificationNeeded || images.added?.length || images.removed?.length || images.replaced?.length || images.orderChanged ? (
        <p className="mt-1 text-sm text-brown/70">{t.giniImageNotSent}</p>
      ) : null}
      {(images.previousImages || []).length ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ImageColumn label={t.giniImagePreviousLabel} urls={images.previousImages} mark={(url) => imageMark(t, images, url, "previous")} />
          <ImageColumn label={t.giniImageCurrentLabel} urls={images.currentImages} mark={(url) => imageMark(t, images, url, "current")} />
        </div>
      ) : null}
      {(images.remoteImages || []).length || (images.selectionRequired && (images.currentImages || []).length) ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ImageColumn
            label={t.giniImageRemoteLabel}
            urls={images.remoteImages}
            mark={() => ""}
            name={images.selectionRequired ? `gini-image-delete-${sku}` : ""}
            selected={selectedDelete}
            onSelect={images.selectionRequired ? onSelectDelete : null}
          />
          {images.selectionRequired ? (
            <ImageColumn
              label={t.giniImageCurrentLabel}
              urls={images.currentImages}
              mark={() => ""}
              name={`gini-image-source-${sku}`}
              selected={selectedSource}
              onSelect={onSelectSource}
            />
          ) : null}
        </div>
      ) : null}
      {showCurrentOnly && !images.selectionRequired ? <div className="mt-3"><ImageColumn label={t.giniImageCurrentLabel} urls={images.currentImages} mark={() => ""} /></div> : null}
      {images.selectionRequired ? <p className="mt-2 text-sm text-brown/70">{t.giniImageReplaceSelect}</p> : null}
    </div>
  );
}

function confirmChangedSync(t, row) {
  const changes = (row?.updateChanges || [])
    .map((change) => `${fieldLabel(t, change.field)} ${change.old} → ${change.new}`)
    .join(", ");
  return String(t.giniStartChangedConfirm || "")
    .replaceAll("{sku}", row?.sku || "")
    .replaceAll("{changes}", changes);
}

function Stat({ label, value, marker, markerValue }) {
  const marked = marker ? { [marker]: markerValue ?? "" } : {};
  return (
    <div className="rounded-2xl bg-cream px-4 py-3" {...marked}>
      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums text-brown">{value ?? "—"}</p>
    </div>
  );
}

export default function GiniSyncAll({ t }) {
  const [status, setStatus] = useState(null);
  const [changedPreview, setChangedPreview] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [limit, setLimit] = useState("1");
  const [selectedSku, setSelectedSku] = useState("");
  const [deleteImageUrl, setDeleteImageUrl] = useState("");
  const [replacementImageUrl, setReplacementImageUrl] = useState("");
  const previewId = changedPreview?.previewId || "";

  useEffect(() => {
    setSelectedSku("");
    setDeleteImageUrl("");
    setReplacementImageUrl("");
  }, [previewId]);

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
      if (label === "changed-preview") setChangedPreview(data);
      if (data?.job || (data?.writesEnabled != null && label !== "changed-preview")) {
        setStatus((current) => ({ ...(current || {}), ...data }));
      }
      setMessage(data?.message || t.giniSyncUpdated);
    } catch (err) {
      setError(err.code ? `${err.code}: ${err.message}` : err.message);
    } finally {
      setBusy("");
      refresh().catch(() => {});
    }
  }

  const view = selectGiniSyncDisplay(status);
  const approved = view.preview;
  const writesEnabled = status?.writesEnabled === true;
  const active = view.active;
  const current = view.current;
  const warnings = reconciliationWarnings(status, current);
  const percent = Number(current?.percent) || 0;
  const ready = Number(approved?.readyCreate) || 0;
  const changedCount = Number(approved?.changed) || 0;
  const maxLimit = Number(status?.limitedRunMax) || 25;
  const parsedLimit = Number(limit);
  const limitOk = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= maxLimit;
  const canSend = writesEnabled && approved && !active && !busy;
  const updateWritesEnabled = status?.updateWritesEnabled === true;
  const canStartCatalog = Boolean(
    approved &&
      !active &&
      !busy &&
      !(ready > 0 && !writesEnabled) &&
      ((writesEnabled && ready > 0) || (updateWritesEnabled && changedCount > 0))
  );
  const eligibleUpdates = (changedPreview?.changedProducts || []).filter(
    (row) => row.updateEligible === true && row.identityMatched === true && row.liveGiniProductId === row.giniProductId
  );
  const selectedUpdate = eligibleUpdates.find((row) => row.sku === selectedSku) || null;
  const previewReady = Boolean(
    changedPreview?.previewId &&
      changedPreview?.previewSignature &&
      changedPreview?.updatesSupported === true &&
      changedPreview?.expiresAt &&
      Date.parse(changedPreview.expiresAt) > Date.now()
  );
  const canStartChangedSync = Boolean(
    updateWritesEnabled && previewReady && selectedUpdate && !active && !busy
  );
  const imageWritesEnabled = status?.imageWritesEnabled === true;
  const selectedImage =
    (changedPreview?.changedProducts || []).find(
      (row) =>
        row.sku === selectedSku &&
        giniImageSelectionRequired(row) &&
        row.identityMatched === true &&
        row.liveGiniProductId === row.giniProductId
    ) || null;
  const canReplaceImage = canReplaceGiniImage({
    imageWritesEnabled,
    preview: changedPreview,
    row: selectedImage,
    deleteImageUrl,
    replacementImageUrl,
    active,
    busy,
  });
  const failures = current?.recentFailures || [];
  const examples = current?.blockerExamples || [];
  const stateLabel = current ? t[STATE_KEYS[current.status]] || current.status : "";

  return (
    <section className="space-y-6" data-gini-sync-all="true" data-gini-sync-workflow="new-and-changed">
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
        <p className={`mt-2 rounded-2xl px-4 py-3 text-sm ${updateWritesEnabled ? "bg-amber-50 text-amber-950" : "bg-cream text-brown/70"}`}>
          {updateWritesEnabled ? t.giniSyncAllUpdateWritesOn : t.giniSyncAllUpdateWritesOff}
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
            <button
              type="button"
              className={`${BUTTON} mt-3`}
              data-gini-changed-preview-button="true"
              disabled={Boolean(busy)}
              onClick={() => run(() => api.giniChangedPreview(), "changed-preview")}
            >
              {busy === "changed-preview" ? t.loading : t.giniRunChangedPreview}
            </button>
            <p className="mt-3 text-sm text-brown/70">{t.giniChangedSyncContractRequired}</p>
            <p className="mt-2 text-sm text-brown/70">{t.giniChangedSyncUnsupported}</p>
            <p className="mt-2 text-sm text-brown/70">{t.giniImageWriteBlocked}</p>
            <p className="mt-2 text-sm text-brown/70">{updateWritesEnabled ? t.giniChangedSyncSelect : t.giniChangedSyncWritesOff}</p>
            <p className="mt-2 text-sm text-brown/70">{imageWritesEnabled ? t.giniImageReplaceSelect : t.giniImageWritesOff}</p>
            <p className="mt-2 text-xs text-brown/45" dir="ltr">
              {t.giniChangedUpdateEndpoint}: PUT /api/v2.0/third-party/products/{"{sku}"}
            </p>
            <p className="mt-2 text-xs text-brown/45" dir="ltr">
              POST /api/v2.0/third-party/products/{"{sku}"} · _method=PUT
            </p>
            <button
              type="button"
              className={`${BUTTON} mt-3`}
              data-gini-start-changed-sync="true"
              disabled={!canStartChangedSync}
              onClick={() => {
                if (!canStartChangedSync || !selectedUpdate) return;
                if (!window.confirm(confirmChangedSync(t, selectedUpdate))) return;
                run(
                  () =>
                    api.giniChangedSyncStart({
                      confirm: true,
                      previewId: changedPreview.previewId,
                      previewSignature: changedPreview.previewSignature,
                      sku: selectedUpdate.sku,
                      expectedChanges: selectedUpdate.updateChanges,
                    }),
                  "changed-sync"
                );
              }}
            >
              {busy === "changed-sync" ? t.loading : t.giniStartChangedSync}
            </button>
            <button
              type="button"
              className={`${BUTTON} mt-3`}
              data-gini-replace-image="true"
              disabled={!canReplaceImage}
              onClick={() => {
                if (!canReplaceImage || !selectedImage) return;
                const prompt = String(t.giniImageReplaceConfirm || "")
                  .replaceAll("{sku}", selectedImage.sku || "")
                  .replaceAll("{old}", deleteImageUrl)
                  .replaceAll("{new}", replacementImageUrl);
                if (!window.confirm(prompt)) return;
                run(
                  () =>
                    api.giniImageReplacementStart({
                      confirm: true,
                      previewId: changedPreview.previewId,
                      previewSignature: changedPreview.previewSignature,
                      sku: selectedImage.sku,
                      deleteImageUrl,
                      replacementImageUrl,
                    }),
                  "image-replacement"
                );
              }}
            >
              {busy === "image-replacement" ? t.loading : t.giniImageReplaceOne}
            </button>
            <button
              type="button"
              className={`${GHOST} mt-3`}
              data-gini-reconcile-image="true"
              disabled={!selectedSku || Boolean(busy)}
              onClick={() => {
                if (!selectedSku || busy) return;
                if (!window.confirm(t.giniImageReconcile)) return;
                run(() => api.giniImageReplacementReconcile({ confirm: true, sku: selectedSku }), "image-reconcile");
              }}
            >
              {busy === "image-reconcile" ? t.loading : t.giniImageReconcile}
            </button>
            <button
              type="button"
              className={`${GHOST} mt-3`}
              data-gini-resolve-image="true"
              disabled={!selectedSku || Boolean(busy)}
              onClick={() => {
                if (!selectedSku || busy) return;
                if (!window.confirm(t.giniImageResolveConfirm)) return;
                run(
                  () =>
                    api.giniImageReplacementResolve({
                      confirm: true,
                      sku: selectedSku,
                      resolution: "not_applied",
                      acknowledgeDelay: true,
                    }),
                  "image-resolve"
                );
              }}
            >
              {busy === "image-resolve" ? t.loading : t.giniImageResolve}
            </button>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={GHOST}
                disabled={busy !== "changed-sync"}
                onClick={() => api.giniChangedSyncPause().catch((err) => setError(err.message))}
              >
                {t.giniPauseSync}
              </button>
              <button
                type="button"
                className={GHOST}
                disabled={Boolean(busy)}
                onClick={() => run(() => api.giniChangedSyncResume(), "changed-resume")}
              >
                {t.giniResumeSync}
              </button>
              <button
                type="button"
                className={GHOST}
                disabled={busy !== "changed-sync"}
                onClick={() => api.giniChangedSyncStop().catch((err) => setError(err.message))}
              >
                {t.giniStopSync}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={!canStartCatalog}
            onClick={() => {
              if (!canStartCatalog) return;
              const message = String(t.giniStartFullConfirm || "")
                .replace("{count}", count(writesEnabled ? ready : 0))
                .replace("{changed}", count(updateWritesEnabled ? changedCount : 0));
              if (!window.confirm(message)) return;
              run(
                () =>
                  api.giniSyncAllStart({
                    confirm: true,
                    previewJobId: approved.id,
                    catalogSignature: approved.catalogSignature,
                    expectedReady: approved.readyCreate,
                    scope: "full",
                    approveFullRun: true,
                    expectedChanged: Number(approved.changed) || 0,
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

      {changedPreview ? (
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5" data-gini-changed-preview="true">
          <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">{t.giniChangedPreviewTitle}</p>
          <p className="mt-2 text-sm text-brown/70">{t.giniChangedPreviewLocalNote}</p>
          <p className="mt-2 text-sm text-brown/60">{t.giniChangedPreviewReadOnly}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Stat
              label={t.giniChangedPreviewChecked}
              value={count(changedPreview.checked)}
              marker="data-gini-changed-checked"
              markerValue={String(changedPreview.checked ?? 0)}
            />
            <Stat
              label={t.giniChangedPreviewChanged}
              value={count(changedPreview.changed)}
              marker="data-gini-changed-changed"
              markerValue={String(changedPreview.changed ?? 0)}
            />
            <Stat
              label={t.giniChangedPreviewUnchanged}
              value={count(changedPreview.unchanged)}
              marker="data-gini-changed-unchanged"
              markerValue={String(changedPreview.unchanged ?? 0)}
            />
            <Stat
              label={t.giniChangedPreviewReconcile}
              value={count(changedPreview.reconciliationNeeded)}
              marker="data-gini-changed-reconcile"
              markerValue={String(changedPreview.reconciliationNeeded ?? 0)}
            />
            <Stat
              label={t.giniChangedPreviewBlocked}
              value={count(changedPreview.blocked)}
              marker="data-gini-changed-blocked"
              markerValue={String(changedPreview.blocked ?? 0)}
            />
            <Stat
              label={t.giniChangedPreviewImageChecks}
              value={count(changedPreview.imageVerificationNeeded)}
              marker="data-gini-changed-image-checks"
              markerValue={String(changedPreview.imageVerificationNeeded ?? 0)}
            />
          </div>
          <div className="mt-5">
            <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">{t.giniChangedPreviewList}</p>
            {changedPreview.changedProducts?.length ? (
              <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto text-sm">
                {changedPreview.changedProducts.map((row) => (
                  <li key={`${row.sku}-${row.giniProductId}`} className="rounded-2xl bg-cream px-4 py-3" data-gini-changed-product="true">
                    {(row.updateEligible || giniImageSelectionRequired(row)) && row.identityMatched ? (
                      <label className="flex items-center gap-2 text-sm font-semibold text-brown">
                        <input
                          type="radio"
                          name="gini-changed-sync-sku"
                          value={row.sku}
                          checked={selectedSku === row.sku}
                          onChange={() => setSelectedSku(row.sku)}
                          data-gini-changed-sync-sku={row.sku}
                        />
                        <span dir="ltr">{row.sku}</span>
                      </label>
                    ) : (
                      <span className="font-semibold text-brown" dir="ltr">
                        {row.sku}
                      </span>
                    )}
                    {row.name ? <span className="mt-1 block text-brown/80">{row.name}</span> : null}
                    <span className="mt-1 block text-brown/70">{previewReason(t, row)}</span>
                    {row.changes?.length ? (
                      <ul className="mt-2 space-y-1">
                        {row.changes.map((change) => (
                          <li key={change.field} dir="ltr" data-gini-changed-field={change.field}>
                            <span className="font-semibold text-brown">{fieldLabel(t, change.field)}</span>
                            {": "}
                            {t.giniChangedPreviewOld} {change.old}
                            {" → "}
                            {t.giniChangedPreviewNew} {change.new}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="mt-1 block text-brown/60">{t.giniChangedPreviewHashOnly}</span>
                    )}
                    {row.updateEligible ? null : (
                      <span className="mt-1 block text-brown/60">{t.giniChangedSyncNotSendable}</span>
                    )}
                    {row.imageReplacementBlocked ? <p className="mt-2 text-sm text-brown/70">{t.giniImageMixedBlocked}</p> : null}
                    <ImageReview
                      t={t}
                      sku={row.sku}
                      images={row.images}
                      selectedDelete={selectedSku === row.sku ? deleteImageUrl : ""}
                      selectedSource={selectedSku === row.sku ? replacementImageUrl : ""}
                      onSelectDelete={(url) => {
                        setSelectedSku(row.sku);
                        setDeleteImageUrl(url);
                      }}
                      onSelectSource={(url) => {
                        setSelectedSku(row.sku);
                        setReplacementImageUrl(url);
                      }}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-brown/50">{t.giniChangedPreviewNone}</p>
            )}
          </div>
          {changedPreview.reconciliationProducts?.length ? (
            <div className="mt-5" data-gini-changed-reconcile-list="true">
              <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">{t.giniChangedPreviewReconcileList}</p>
              <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto text-sm">
                {changedPreview.reconciliationProducts.map((row) => (
                  <li key={`${row.code}-${row.sku}-${row.giniProductId}`} className="rounded-2xl bg-amber-50 px-4 py-3 text-amber-950">
                    <span className="font-semibold" dir="ltr">
                      {row.sku || row.giniProductId}
                    </span>
                    {row.name ? <span className="mt-1 block">{row.name}</span> : null}
                    <span className="mt-1 block">{previewReason(t, row)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {changedPreview.blockedProducts?.length ? (
            <div className="mt-5" data-gini-changed-blocked-list="true">
              <p className="text-xs font-semibold tracking-wide text-brown/45 uppercase">{t.giniChangedPreviewBlockedList}</p>
              <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto text-sm">
                {changedPreview.blockedProducts.map((row) => (
                  <li key={`${row.code}-${row.sku}-${row.giniProductId}`} className="rounded-2xl bg-cream px-4 py-3">
                    <span className="font-semibold text-brown" dir="ltr">
                      {row.sku || row.giniProductId}
                    </span>
                    {row.name ? <span className="mt-1 block text-brown/80">{row.name}</span> : null}
                    <span className="mt-1 block text-brown/70">{previewReason(t, row)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        {current ? (
          <div className="space-y-4">
            <p className="text-sm text-brown/60" data-gini-sync-mode={current.mode || ""} data-gini-sync-status={current.status || ""}>
              {t.status}: <span className="font-semibold text-brown">{stateLabel}</span>
              {current.runScope ? ` · ${current.runScope}` : ""}
            </p>
            {current.lastError ? (
              <p className="text-sm text-red-700" data-gini-job-error="true">
                <span className="font-semibold">{t.giniSyncJobError}</span>
                {current.errorCode ? <span dir="ltr"> · {current.errorCode}</span> : null}
                <span className="mt-1 block" dir="ltr">
                  {current.lastError}
                </span>
              </p>
            ) : null}
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
            {current.mappingCoverage ? (
              <div className="rounded-2xl bg-cream px-4 py-3 text-sm text-brown/70" data-gini-mapping-coverage="true">
                <p className="font-semibold text-brown">{t.giniMappingCoverage}</p>
                <p className="mt-1" dir="ltr">
                  {current.mappingCoverage.configured || 0} mapped · {current.mappingCoverage.unmapped || current.mappingCoverage.missing || 0} unmapped ·{" "}
                  {current.mappingCoverage.invalid || 0} invalid · {current.mappingCoverage.inactive || 0} inactive
                </p>
                <p className="mt-1">{t.giniMappingNotEligible}</p>
                {(current.mappingCoverage.unmappedCollections || []).length ? (
                  <ul className="mt-2 space-y-1" dir="ltr">
                    {(current.mappingCoverage.unmappedCollections || []).map((row) => (
                      <li key={row.id || row.name}>
                        {t.giniMappingUnmapped}: {row.name || row.id} · {count(row.productCount)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {current.limitReached ? <p className="text-sm text-brown/70">{t.giniSyncLimitReached}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label={t.giniSyncTotal} value={count(current.total)} />
              <Stat label={t.giniSyncEligible} value={count(current.eligible)} />
              <Stat label={t.giniSyncReady} value={count(current.readyCreate)} />
              <Stat label={t.giniSyncChanged} value={count(current.changed)} marker="data-gini-changed" markerValue={String(current.changed || 0)} />
              <Stat label={t.giniSyncUnchanged} value={count(current.unchanged)} marker="data-gini-unchanged" markerValue={String(current.unchanged || 0)} />
              <Stat label={t.giniSyncExists} value={count(current.alreadyExists)} />
              <Stat label={t.giniSyncPriceStockUpdated} value={count(sendCounter(current, "updated"))} />
              <Stat label={t.giniSyncBlocked} value={count(current.blocked)} />
              <Stat label={t.giniSyncInactive} value={count(current.inactive)} />
              <Stat label={t.giniSyncNeedsReview} value={count(current.needsReview)} />
              <Stat label={t.giniSyncLookupUncertain} value={count(current.lookupUncertain)} />
              <Stat
                label={t.giniSyncCreated}
                value={count(confirmedCreateCount(current))}
                marker="data-gini-created"
                markerValue={String(confirmedCreateCount(current))}
              />
              <Stat label={t.giniSyncFailed} value={count(sendCounter(current, "failed"))} />
              <Stat label={t.giniSyncCreateUncertain} value={count(sendCounter(current, "createUncertain"))} />
              <Stat label={t.giniSyncProgress} value={`${count(current.processed)} / ${count(current.total)}`} />
            </div>
            {warnings.length ? (
              <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-950" data-gini-reconcile="true">
                <p className="font-semibold">{t.giniSyncReconcileTitle}</p>
                <ul className="mt-2 space-y-2">
                  {warnings.map((row) => (
                    <li key={`${row.code}-${row.sku}-${row.giniProductId}`} dir="ltr">
                      {warningText(t, row)}
                      {row.liveGiniProductId ? <span> · {row.liveGiniProductId}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {current.mode === "sync" && approved ? (
              <div className="rounded-2xl bg-cream px-4 py-4" data-gini-preview-summary="true">
                <p className="text-xs font-semibold tracking-wide text-brown/50 uppercase">{t.giniSyncPreviewTitle}</p>
                <p className="mt-1 text-sm text-brown/60">{t.giniSyncPreviewSeparate}</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat label={t.giniSyncReady} value={count(approved.readyCreate)} />
                  <Stat label={t.giniSyncExists} value={count(approved.alreadyExists)} />
                  <Stat label={t.giniSyncBlocked} value={count(approved.blocked)} />
                  <Stat label={t.giniSyncLookupUncertain} value={count(approved.lookupUncertain)} />
                </div>
              </div>
            ) : null}
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
