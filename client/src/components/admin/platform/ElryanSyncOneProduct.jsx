import { useState } from "react";
import { api } from "../../../api";
import { tName } from "../../../i18n";
import {
  describeElryanSendResult,
  elryanStagingSendConfirmFacts,
  elryanStagingSendGate,
  elryanStagingSendRequest,
} from "./elryanSyncOneSendGate";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST =
  "rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

export default function ElryanSyncOneProduct({ t, lang }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [writesGate, setWritesGate] = useState(null);
  const [localHold, setLocalHold] = useState("");
  const [sendResult, setSendResult] = useState(null);
  const [attemptView, setAttemptView] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [gateNote, setGateNote] = useState("");

  const sendGate = elryanStagingSendGate({ preview, writesGate, localHold });
  const confirmFacts = preview ? elryanStagingSendConfirmFacts(preview) : null;
  const showAttempt =
    localHold === "uncertain" ||
    localHold === "in_progress" ||
    sendResult?.kind === "uncertain" ||
    sendResult?.kind === "in_progress" ||
    preview?.sendAttempt?.blocked === true;

  function clearSendState() {
    setPreview(null);
    setLocalHold("");
    setSendResult(null);
    setAttemptView(null);
    setConfirmOpen(false);
    setError("");
  }

  async function onSearch() {
    setBusy(true);
    setError("");
    try {
      const data = await api.elryanSyncOneSearch(query);
      setResults(data.products || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onPreview() {
    if (!selected?.id) return;
    setBusy(true);
    setError("");
    setConfirmOpen(false);
    setSendResult(null);
    try {
      const data = await api.elryanSyncOnePreview(selected.id, { investigateCommission: true });
      setPreview(data);
      setWritesGate(data.writesGate || null);
      setAttemptView(data.sendAttempt || null);
      setLocalHold(data.sendAttempt?.blocked ? data.sendAttempt.status : "");
    } catch (err) {
      setError(err.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function onProbeWritesGate() {
    setBusy(true);
    setError("");
    setGateNote("");
    try {
      const data = await api.elryanWritesGate();
      setWritesGate(data);
      setGateNote(data.note || t.elryanSendDisabled);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function onAskSend() {
    if (!elryanStagingSendGate({ preview, writesGate, localHold }).enabled) return;
    setConfirmOpen(true);
  }

  function applySendResult(data) {
    const view = describeElryanSendResult(data);
    setSendResult({ ...view, message: data?.message || "" });
    if (view.retryBlocked && view.hold) setLocalHold(view.hold);
    if (view.tokenConsumed) {
      setPreview((current) => (current ? { ...current, previewToken: "" } : current));
    }
    if (view.kind === "uncertain" || view.kind === "in_progress" || view.kind === "already_sent") {
      const productId = preview?.product?.id || selected?.id;
      if (productId) {
        api
          .elryanSendAttempt(productId)
          .then((attempt) => setAttemptView(attempt))
          .catch(() => {});
      }
    }
  }

  async function onConfirmSend() {
    const gate = elryanStagingSendGate({ preview, writesGate, localHold });
    const body = elryanStagingSendRequest({ preview, writesGate, localHold, confirm: true });
    setConfirmOpen(false);
    if (!gate.enabled || !body) return;
    setBusy(true);
    setError("");
    try {
      const data = await api.elryanSyncOneSend(body);
      applySendResult(data);
    } catch (err) {
      applySendResult({
        ok: false,
        code: err.code || "",
        message: err.message || "",
        published: false,
      });
    } finally {
      setBusy(false);
    }
  }

  async function onRefreshSendAttempt() {
    const productId = preview?.product?.id || selected?.id;
    if (!productId) return;
    setBusy(true);
    setError("");
    try {
      const attempt = await api.elryanSendAttempt(productId);
      setAttemptView(attempt);
      if (attempt?.blocked && attempt.status) setLocalHold(attempt.status);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const reasonText = {
    writes_disabled: t.elryanSendReasonWrites,
    writes_partial: t.elryanSendReasonPartial,
    staging_only: t.elryanSendReasonStaging,
    not_ready: t.elryanSendReasonReady,
    blockers: t.elryanSendReasonBlockers,
    preview_required: t.elryanSendReasonToken,
    token_expired: t.elryanSendReasonExpired,
    send_attempt_blocked: t.elryanSendReasonAttempt,
    wrong_sku: t.elryanSendReasonSku,
  };
  const lineText = {
    created: t.elryanSendResultCreated,
    in_review: t.elryanSendResultInReview,
    published: t.elryanSendResultPublished,
    validation_error: t.elryanSendResultValidation,
    already_sent: t.elryanSendResultAlreadySent,
    in_progress: t.elryanSendResultInProgress,
    uncertain: t.elryanSendResultUncertain,
    preview_invalid: t.elryanSendResultPreview,
    writes_disabled: t.elryanSendResultWrites,
    staging_only: t.elryanSendResultStaging,
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.elryanSyncOneTitle}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-brown/60">{t.elryanSyncOneHint}</p>
      </div>

      <div className="flex max-w-xl flex-wrap gap-2">
        <input
          className={`${CONTROL} flex-1`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.elryanSearchProducts}
        />
        <button type="button" className={BUTTON} disabled={busy} onClick={onSearch}>
          {busy ? t.loading : t.search}
        </button>
      </div>

      <ul className="max-w-xl space-y-2">
        {results.map((product) => (
          <li key={product.id}>
            <button
              type="button"
              className={`w-full rounded-2xl px-4 py-3 text-left text-sm ring-1 ${
                selected?.id === product.id ? "bg-cream ring-tan" : "bg-white ring-brown/10"
              }`}
              onClick={() => {
                setSelected(product);
                clearSendState();
              }}
            >
              <span className="font-semibold text-brown">{tName(product.name, lang) || product.sku}</span>
              <span className="mt-1 block text-xs text-brown/45">{product.sku}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={!selected || busy} onClick={onPreview}>
          {busy ? t.loading : t.elryanPreviewProduct}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={!sendGate.enabled || busy}
          title={sendGate.enabled ? t.elryanSendProduct : reasonText[sendGate.reason] || t.elryanSendDisabled}
          onClick={onAskSend}
        >
          {t.elryanSendProduct}
        </button>
        <button type="button" className={GHOST} disabled={busy} onClick={onProbeWritesGate}>
          {t.elryanProbeSendGate}
        </button>
      </div>
      {preview && !sendGate.enabled ? (
        <p className="max-w-2xl text-sm text-brown/70">{reasonText[sendGate.reason] || t.elryanSendDisabled}</p>
      ) : null}
      {gateNote ? <p className="max-w-2xl text-sm text-brown/70">{gateNote}</p> : null}

      {sendResult ? (
        <div className="max-w-2xl space-y-1 rounded-2xl bg-cream/70 p-4 text-sm text-brown" role="status">
          {sendResult.lines.map((line) => (
            <p key={line} className="font-semibold">
              {lineText[line] || line}
            </p>
          ))}
          {sendResult.message ? <p className="text-brown/70">{sendResult.message}</p> : null}
        </div>
      ) : null}

      {showAttempt ? (
        <div className="max-w-2xl space-y-2 rounded-2xl bg-white p-4 text-sm text-brown ring-1 ring-brown/10">
          <p className="font-semibold">
            {localHold === "in_progress" || sendResult?.kind === "in_progress"
              ? t.elryanSendResultInProgress
              : localHold === "succeeded" || sendResult?.kind === "already_sent"
                ? t.elryanSendResultAlreadySent
                : t.elryanSendResultUncertain}
          </p>
          <p className="text-brown/70">{t.elryanSendAttemptReadOnly}</p>
          {attemptView?.status ? (
            <p>
              {attemptView.status}
              {attemptView.errorMessage ? `: ${attemptView.errorMessage}` : ""}
            </p>
          ) : null}
          {attemptView?.note ? <p className="text-brown/70">{attemptView.note}</p> : null}
          <button type="button" className={GHOST} disabled={busy} onClick={onRefreshSendAttempt}>
            {t.elryanRefreshSendAttempt}
          </button>
        </div>
      ) : null}

      {confirmOpen && confirmFacts ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-brown/40 p-4" role="presentation">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="elryan-send-title"
            className="max-w-lg space-y-4 rounded-[1.5rem] bg-white p-5 text-sm text-brown shadow-xl"
          >
            <h2 id="elryan-send-title" className="text-lg font-semibold">
              {t.elryanSendConfirmTitle}
            </h2>
            <p className="text-red-800">{t.elryanSendConfirmWarning}</p>
            <dl className="grid gap-2">
              <div>
                <dt className="text-brown/45">{t.elryanSendName}</dt>
                <dd className="font-semibold">{tName(confirmFacts.name, lang) || confirmFacts.sku}</dd>
              </div>
              <div>
                <dt className="text-brown/45">SKU</dt>
                <dd className="font-semibold">{confirmFacts.sku}</dd>
              </div>
              <div>
                <dt className="text-brown/45">{t.elryanSendEnvironment}</dt>
                <dd className="font-semibold">{confirmFacts.environment}</dd>
              </div>
              <div>
                <dt className="text-brown/45">{t.elryanSendPrice}</dt>
                <dd className="font-semibold">
                  {confirmFacts.price ?? "—"} {confirmFacts.currency}
                </dd>
              </div>
              <div>
                <dt className="text-brown/45">{t.elryanSendCurrency}</dt>
                <dd className="font-semibold">{confirmFacts.currency}</dd>
              </div>
              <div>
                <dt className="text-brown/45">{t.elryanSendQuantity}</dt>
                <dd className="font-semibold">{confirmFacts.quantity ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-brown/45">{t.elryanSendImage}</dt>
                <dd>
                  {String(confirmFacts.image).startsWith("https://") ? (
                    <img src={confirmFacts.image} alt="" className="mt-1 h-24 w-24 rounded-xl object-cover" />
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={GHOST} onClick={() => setConfirmOpen(false)}>
                {t.elryanSendCancel}
              </button>
              <button type="button" className={BUTTON} disabled={busy} onClick={onConfirmSend}>
                {t.elryanSendConfirmAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="max-w-3xl space-y-4 rounded-[1.75rem] bg-white p-5 ring-1 ring-brown/10">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">
              {preview.readiness}
            </span>
            <span className="text-xs text-brown/45">
              {preview.productWritesEnabled && preview.liveWritesAllowed
                ? t.elryanWritesEnabledCaution
                : t.elryanWritesDisabled}
            </span>
          </div>

          <dl className="grid gap-2 text-sm md:grid-cols-2">
            <div>
              <dt className="text-brown/45">SKU</dt>
              <dd className="font-semibold">{preview.product?.sku}</dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.elryanCategory}</dt>
              <dd className="font-semibold">
                {preview.mapping?.categoryId || "—"} {preview.mapping?.categoryName || ""}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.storePrice}</dt>
              <dd className="font-semibold">
                {preview.pricing?.priceReview ? t.priceNeedsReview : `${preview.pricing?.storeSellingPrice} IQD`}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.commission}</dt>
              <dd className="font-semibold">{preview.pricing?.commissionRate}%</dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.platformPrice}</dt>
              <dd className="font-semibold">
                {preview.pricing?.priceReview ? t.priceNeedsReview : `${preview.pricing?.platformPrice} IQD`}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.elryanProposedPrice}</dt>
              <dd className="font-semibold">
                {preview.pricing?.priceReview ? t.priceNeedsReview : (preview.pricing?.proposedElryanPrice ?? "—")}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.elryanProposedCost}</dt>
              <dd className="font-semibold">{preview.pricing?.proposedElryanCost ?? "—"}</dd>
            </div>
          </dl>

          {preview.pricing?.pricingNote ? (
            <p className="text-sm text-brown/70">{preview.pricing.pricingNote}</p>
          ) : null}
          {preview.warrantyContract?.message ? (
            <p className="text-sm text-brown/70">
              {preview.warrantyContract.status}: {preview.warrantyContract.message}
            </p>
          ) : null}
          <div className="rounded-2xl bg-cream/60 p-4">
            <p className="text-xs font-semibold tracking-wide text-brown uppercase">{t.elryanRemainingBlockers}</p>
            {preview.blockers?.length ? (
              <ul className="mt-2 space-y-2 text-sm text-red-800">
                {preview.blockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${index}`}>
                    <span className="font-semibold">{blocker.code}</span>
                    <span className="mt-0.5 block text-red-900/80">{blocker.message || blocker.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-brown/70">{t.elryanNoBlockers}</p>
            )}
          </div>

          <dl className="grid gap-3 text-sm md:grid-cols-3">
            <div>
              <dt className="text-brown/45">{t.elryanStagingOverride}</dt>
              <dd className="font-semibold">
                {preview.stagingOverride
                  ? Object.entries(preview.stagingOverride.attributes || {})
                      .map(([code, value]) => `${code}: ${value}`)
                      .join(", ")
                  : t.elryanNoStagingOverride}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.elryanPriceApproval}</dt>
              <dd className="font-semibold">
                {preview.pricingApproval?.valid ? "matched" : preview.pricingApproval?.reason || "missing"}
              </dd>
            </div>
            <div>
              <dt className="text-brown/45">{t.elryanDimensions}</dt>
              <dd className="font-semibold">
                {preview.packageDimensions?.source || preview.packageDimensions?.status || "UNVERIFIED"}
              </dd>
            </div>
          </dl>
          {preview.packageDimensions?.note ? (
            <p className="text-sm text-brown/60">{preview.packageDimensions.note}</p>
          ) : null}
          {preview.packageDimensions?.suggestion ? (
            <p className="text-sm text-brown/60">
              {t.elryanDimSuggestion}: {preview.packageDimensions.suggestion.height} × {preview.packageDimensions.suggestion.width} × {preview.packageDimensions.suggestion.depth} cm
            </p>
          ) : null}
          {preview.sendAttempt?.blocked ? (
            <p className="text-sm text-brown/70">
              {preview.sendAttempt.status}: {preview.sendAttempt.note}
            </p>
          ) : null}

          <pre className="max-h-80 overflow-auto rounded-2xl bg-cream/70 p-4 text-xs text-brown/80">
            {JSON.stringify(preview.proposedPayload, null, 2)}
          </pre>
        </div>
      ) : null}

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
