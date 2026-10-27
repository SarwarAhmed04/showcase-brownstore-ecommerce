import { useState } from "react";
import { api } from "../../../api";
import {
  applyElryanCategoryPick,
  canReviewElryanMapping,
  isElryanCategoryPicked,
  normalizeElryanCategoryPickId,
} from "../../../utils/elryanSmartMappingSelect";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const BUTTON_GHOST =
  "rounded-full border border-brown/15 bg-white px-4 py-2.5 text-sm font-semibold text-brown disabled:opacity-50";
const BUTTON_DANGER =
  "rounded-full border border-amber-700/30 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-950 disabled:opacity-50";

function loc(name) {
  if (!name) return "";
  if (typeof name === "string") return name;
  return name.en || name.ar || name.ku || "";
}

function confidenceClass(band) {
  if (band === "HIGH") return "bg-emerald-50 text-emerald-900";
  if (band === "MEDIUM") return "bg-sky-50 text-sky-900";
  if (band === "LOW") return "bg-amber-50 text-amber-900";
  if (band === "NEEDS_REVIEW") return "bg-orange-50 text-orange-900";
  return "bg-brown/5 text-brown/60";
}

function kindLabel(t, kind, isParent) {
  if (kind === "leaf" || isParent === false) return t.elryanCategoryLeaf;
  if (kind === "parent" || isParent === true) return t.elryanCategoryParent;
  return t.elryanCategoryKindUnknown;
}

export default function ElryanSmartMapping({ t }) {
  const [mode, setMode] = useState("smart");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [confidence, setConfidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [payload, setPayload] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [pickedCategoryId, setPickedCategoryId] = useState("");
  const [compat, setCompat] = useState(null);
  const [compatBusy, setCompatBusy] = useState(false);

  const [manualQ, setManualQ] = useState("");
  const [manualLeafOnly, setManualLeafOnly] = useState(true);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualOffset, setManualOffset] = useState(0);
  const [manualResult, setManualResult] = useState(null);

  const [review, setReview] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [overwriteAck, setOverwriteAck] = useState(false);

  const selected = (payload?.rows || []).find((row) => row.brownCollectionId === selectedId) || null;

  async function loadPreview() {
    setBusy(true);
    setError("");
    setMessage("");
    setCompat(null);
    setReview(null);
    setOverwriteAck(false);
    try {
      const data = await api.elryanMappingPreview({
        q: q.trim() || undefined,
        status: status || undefined,
        confidence: confidence || undefined,
        limit: 40,
        offset: 0,
      });
      setPayload(data);
      const firstId = data.rows?.[0]?.brownCollectionId || "";
      setSelectedId(firstId);
      setPickedCategoryId("");
    } catch (err) {
      setError(err.message);
      setPayload(null);
    } finally {
      setBusy(false);
    }
  }

  async function runManualSearch(offset = 0) {
    setManualBusy(true);
    setError("");
    try {
      const data = await api.elryanMappingSnapshotSearch({
        q: manualQ.trim() || undefined,
        limit: 25,
        offset,
        leafOnly: manualLeafOnly ? "1" : undefined,
      });
      setManualResult(data);
      setManualOffset(offset);
    } catch (err) {
      setError(err.message);
      setManualResult(null);
    } finally {
      setManualBusy(false);
    }
  }

  async function inspectAttributes(categoryId) {
    if (!categoryId) return;
    setCompatBusy(true);
    setCompat(null);
    try {
      const data = await api.elryanCategoryAttributeCompatibility(categoryId);
      setCompat(data);
    } catch (err) {
      setCompat({ blockers: [err.message] });
    } finally {
      setCompatBusy(false);
    }
  }

  function pickCategory(categoryId) {
    const result = applyElryanCategoryPick(pickedCategoryId, categoryId);
    if (!result.pickedCategoryId) {
      setError(t.elryanSelectCandidate || "Select category");
      return;
    }
    setPickedCategoryId(result.pickedCategoryId);
    if (result.reviewCleared) {
      setReview(null);
      setOverwriteAck(false);
    }
    setMessage("");
    setError("");
  }

  const reviewReady = canReviewElryanMapping(selectedId, pickedCategoryId);
  const pickedManual =
    (manualResult?.categories || []).find((c) =>
      isElryanCategoryPicked(pickedCategoryId, c.categoryId)
    ) || null;

  async function buildReview() {
    if (!reviewReady) {
      setError(t.elryanSelectCollectionAndCategory || "Select a collection and an Elryan category.");
      return;
    }
    setReviewBusy(true);
    setError("");
    setMessage("");
    setOverwriteAck(false);
    try {
      const data = await api.elryanMappingPreviewSave({
        brownCollectionId: selectedId,
        categoryId: pickedCategoryId,
        includeAttributes: true,
      });
      setReview(data);
      if (data.attributes) setCompat(data.attributes);
    } catch (err) {
      setReview(null);
      setError(err.message);
    } finally {
      setReviewBusy(false);
    }
  }

  async function saveMapping() {
    if (!selectedId || !pickedCategoryId || !review) return;
    if (review.requiresOverwriteConfirmation && !overwriteAck) {
      setError(t.elryanOverwriteRequired || "Confirm overwrite of the existing mapping first.");
      return;
    }
    setSaveBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await api.elryanMappingSave({
        brownCollectionId: selectedId,
        categoryId: pickedCategoryId,
        confirm: true,
        overwrite: review.requiresOverwriteConfirmation ? true : undefined,
        source: mode === "manual" ? "manual" : "smart",
      });
      if (!data.readBackConfirmed) {
        setError(t.elryanReadBackFailed || "Saved, but read-back did not match. Refresh and verify.");
      } else {
        setMessage(t.elryanMappingSaveSuccess || "Mapping saved locally. Nothing was sent to Elryan.");
      }
      setReview(null);
      setOverwriteAck(false);
      setPickedCategoryId("");
      await loadPreview();
    } catch (err) {
      setError(err.message || t.elryanMappingSaveFailed || "Save failed.");
    } finally {
      setSaveBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.elryanSmartMappingTitle}
        </p>
        <p className="mt-2 max-w-3xl text-sm text-brown/60">{t.elryanSmartMappingHint}</p>
        <p className="mt-2 text-xs font-semibold text-amber-900">
          {t.elryanSmartMappingExplicitSave ||
            "HIGH-confidence suggestions never auto-save. Review and click Save Mapping."}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={mode === "smart" ? BUTTON : BUTTON_GHOST}
          onClick={() => setMode("smart")}
        >
          {t.elryanModeSmart || "Smart suggestions"}
        </button>
        <button
          type="button"
          className={mode === "manual" ? BUTTON : BUTTON_GHOST}
          onClick={() => setMode("manual")}
        >
          {t.elryanModeManual || "Manual search"}
        </button>
      </div>

      <div className="flex max-w-4xl flex-wrap gap-2">
        <input
          className={`${CONTROL} min-w-[12rem] flex-1`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.search}
        />
        <select className={CONTROL} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t.elryanFilterAllMappings}</option>
          <option value="unmapped">{t.elryanFilterUnmapped}</option>
          <option value="mapped">{t.elryanFilterMapped}</option>
        </select>
        <select className={CONTROL} value={confidence} onChange={(e) => setConfidence(e.target.value)}>
          <option value="">{t.elryanFilterAllConfidence}</option>
          <option value="HIGH">HIGH</option>
          <option value="MEDIUM">MEDIUM</option>
          <option value="LOW">LOW</option>
          <option value="NEEDS_REVIEW">NEEDS_REVIEW</option>
          <option value="NO_MATCH">NO_MATCH</option>
        </select>
        <button type="button" className={BUTTON} disabled={busy} onClick={loadPreview}>
          {busy ? t.loading : t.elryanRunMappingPreview}
        </button>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {message ? <p className="text-sm text-emerald-800">{message}</p> : null}

      {payload?.catalog ? (
        <p className="text-xs text-brown/55">
          {t.elryanCatalogStatus}: {payload.catalog.status} · {payload.catalog.uniqueCount} categories ·
          env {payload.environment || payload.catalog.environment || "staging"} · BrownStore collections{" "}
          {payload.counts?.collections ?? "—"}
          {payload.counts?.mapped != null ? ` · mapped ${payload.counts.mapped}` : ""}
          {payload.counts?.scored != null ? ` · scored ${payload.counts.scored}` : ""}
          {payload.timingMs != null ? ` · ${payload.timingMs}ms` : ""}
          {payload.truncated ? ` · ${t.elryanMappingPreviewTruncated || "partial page"}` : ""}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ul className="max-h-[32rem] space-y-2 overflow-auto rounded-[1.5rem] bg-white p-4 ring-1 ring-brown/10">
          {(payload?.rows || []).map((row) => (
            <li key={row.brownCollectionId}>
              <button
                type="button"
                className={`w-full rounded-2xl px-3 py-2 text-left text-sm hover:bg-cream ${
                  selectedId === row.brownCollectionId ? "bg-cream ring-1 ring-brown/10" : ""
                }`}
                onClick={() => {
                  setSelectedId(row.brownCollectionId);
                  setCompat(null);
                  setReview(null);
                  setOverwriteAck(false);
                  setPickedCategoryId("");
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-brown">{loc(row.brownCollectionName)}</span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${confidenceClass(row.overallConfidence)}`}
                  >
                    {row.overallConfidence}
                  </span>
                </div>
                <span className="mt-1 block text-xs text-brown/45">{row.taxonomyPath}</span>
                <span className="mt-0.5 block text-xs text-brown/40">
                  {row.productCount} {t.products} ·{" "}
                  {row.existingMapping?.configured ? t.elryanFilterMapped : t.elryanFilterUnmapped}
                </span>
              </button>
            </li>
          ))}
          {!payload?.rows?.length ? (
            <li className="text-sm text-brown/45">{t.elryanSmartMappingEmpty}</li>
          ) : null}
        </ul>

        <div className="space-y-4 rounded-[1.5rem] bg-cream/50 p-4 ring-1 ring-brown/10">
          {selected ? (
            <>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-tan">
                  {t.elryanMappingDetails}
                </p>
                <p className="mt-2 font-semibold text-brown">{loc(selected.brownCollectionName)}</p>
                <p className="text-sm text-brown/60">{selected.taxonomyPath}</p>
                <p className="mt-1 text-xs text-brown/50">
                  ID {selected.brownCollectionId} · {selected.productCount} {t.products}
                </p>
                <p className="mt-1 text-xs text-brown/50">
                  {t.elryanCurrentMapping}:{" "}
                  {selected.existingMapping?.values?.categoryId
                    ? `${selected.existingMapping.values.categoryId} · ${selected.existingMapping.values.categoryHierarchy || selected.existingMapping.values.categoryName || ""}`
                    : t.elryanFilterUnmapped}
                </p>
              </div>

              {mode === "smart" ? (
                <ul className="space-y-3">
                  {(selected.candidates || []).map((c) => {
                    const active = isElryanCategoryPicked(pickedCategoryId, c.categoryId);
                    return (
                      <li
                        key={String(c.categoryId)}
                        className={`rounded-xl bg-white p-3 ring-1 ${active ? "ring-brown/30" : "ring-brown/5"}`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold text-brown">{c.categoryName}</p>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${confidenceClass(c.confidence)}`}
                          >
                            {c.confidence} · {c.score}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-brown/50">
                          ID {c.categoryId} · {kindLabel(t, null, c.isParent)}
                          {c.attributeSetId != null ? ` · AS ${c.attributeSetId}` : ""}
                        </p>
                        <p className="mt-1 text-xs text-brown/55">{c.hierarchy}</p>
                        <ul className="mt-2 list-disc ps-4 text-xs text-brown/60">
                          {(c.reasons || []).slice(0, 4).map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                        {c.productEvidence?.length ? (
                          <p className="mt-1 text-xs text-brown/45">
                            {t.elryanProductEvidence}: {c.productEvidence.join(", ")}
                          </p>
                        ) : null}
                        {c.missing?.length ? (
                          <p className="mt-1 text-xs text-amber-800">{c.missing.join(" · ")}</p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={active ? BUTTON : BUTTON_GHOST}
                            onClick={() => pickCategory(c.categoryId)}
                          >
                            {active
                              ? t.elryanCategorySelected || "Selected"
                              : t.elryanSelectCandidate || "Select category"}
                          </button>
                          <button
                            type="button"
                            className={BUTTON_GHOST}
                            disabled={compatBusy}
                            onClick={() => inspectAttributes(c.categoryId)}
                          >
                            {compatBusy ? t.loading : t.elryanInspectAttributes}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="space-y-3 rounded-xl bg-white p-3 ring-1 ring-brown/5">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-tan">
                    {t.elryanManualSearchTitle || "Manual category search"}
                  </p>
                  <p className="text-xs text-brown/55">
                    {t.elryanManualSearchHint ||
                      "Search the full staging snapshot by name, hierarchy, or category ID. Only verified snapshot rows can be saved."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      className={`${CONTROL} min-w-[10rem] flex-1`}
                      value={manualQ}
                      onChange={(e) => setManualQ(e.target.value)}
                      placeholder={t.elryanManualSearchPlaceholder || "Name, hierarchy, or ID"}
                    />
                    <label className="flex items-center gap-2 text-xs font-semibold text-brown/70">
                      <input
                        type="checkbox"
                        checked={manualLeafOnly}
                        onChange={(e) => setManualLeafOnly(e.target.checked)}
                      />
                      {t.elryanLeafOnly || "Leaves preferred"}
                    </label>
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={manualBusy}
                      onClick={() => runManualSearch(0)}
                    >
                      {manualBusy ? t.loading : t.search}
                    </button>
                  </div>
                  <ul className="max-h-64 space-y-2 overflow-auto">
                    {(manualResult?.categories || []).map((c) => {
                      const active = isElryanCategoryPicked(pickedCategoryId, c.categoryId);
                      return (
                        <li key={normalizeElryanCategoryPickId(c.categoryId) || c.categoryName}>
                          <div
                            className={`rounded-xl px-3 py-2 text-left text-xs ring-1 ${
                              active
                                ? "bg-white ring-2 ring-brown shadow-sm"
                                : "bg-cream/40 ring-brown/5 hover:bg-cream"
                            }`}
                          >
                            <button
                              type="button"
                              aria-pressed={active}
                              className="w-full text-left"
                              onClick={() => pickCategory(c.categoryId)}
                            >
                              <span className="flex items-start justify-between gap-2">
                                <span className="font-semibold text-brown">{c.categoryName}</span>
                                {active ? (
                                  <span className="shrink-0 rounded-full bg-brown px-2 py-0.5 text-[10px] font-semibold text-cream">
                                    {t.elryanCategorySelected || "Selected"}
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 block text-brown/50">
                                ID {c.categoryId} · {kindLabel(t, c.kind, c.isParent)} · L{c.level ?? "—"}
                                {c.attributeSetId != null ? ` · AS ${c.attributeSetId}` : ""}
                              </span>
                              <span className="mt-0.5 block text-brown/45">{c.hierarchy}</span>
                            </button>
                            <button
                              type="button"
                              className={`${active ? BUTTON : BUTTON_GHOST} mt-2`}
                              aria-pressed={active}
                              onClick={() => pickCategory(c.categoryId)}
                            >
                              {active
                                ? t.elryanCategorySelected || "Selected"
                                : t.elryanSelectCandidate || "Select category"}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {manualResult ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-brown/55">
                      <span>
                        {manualResult.totalMatching} {t.elryanTotalResults || "results"} · offset{" "}
                        {manualResult.offset}
                      </span>
                      <button
                        type="button"
                        className={BUTTON_GHOST}
                        disabled={manualBusy || manualOffset <= 0}
                        onClick={() => runManualSearch(Math.max(0, manualOffset - 25))}
                      >
                        {t.elryanPrevPage}
                      </button>
                      <button
                        type="button"
                        className={BUTTON_GHOST}
                        disabled={
                          manualBusy ||
                          manualOffset + (manualResult.limit || 25) >= (manualResult.totalMatching || 0)
                        }
                        onClick={() => runManualSearch(manualOffset + (manualResult.limit || 25))}
                      >
                        {t.elryanNextPage}
                      </button>
                    </div>
                  ) : null}
                </div>
              )}

              {pickedCategoryId ? (
                <div className="rounded-xl bg-white p-3 text-xs text-brown/75 ring-2 ring-brown/20">
                  <p className="font-semibold text-brown">
                    {t.elryanCategorySelected || "Selected"}:{" "}
                    {pickedManual?.categoryName ||
                      (selected.candidates || []).find((c) =>
                        isElryanCategoryPicked(pickedCategoryId, c.categoryId)
                      )?.categoryName ||
                      "—"}
                  </p>
                  <p className="mt-1">
                    ID {pickedCategoryId}
                    {pickedManual?.hierarchy ? ` · ${pickedManual.hierarchy}` : ""}
                    {pickedManual?.attributeSetId != null
                      ? ` · AS ${pickedManual.attributeSetId}`
                      : ""}
                  </p>
                  <p className="mt-1 text-brown/50">
                    {t.elryanReviewReadyHint ||
                      "Category selected. Click Review before save — nothing is saved yet."}
                  </p>
                </div>
              ) : null}

              {compat ? (
                <div className="rounded-xl bg-white p-3 text-xs text-brown/70 ring-1 ring-brown/5">
                  <p className="font-semibold text-brown">{t.elryanAttributeCompatibility}</p>
                  <p className="mt-1">
                    {t.elryanAttributeSetLabel}: {compat.attributeSetId || "—"} {compat.attributeSetName || ""}
                  </p>
                  <p className="mt-1">
                    Mandatory:{" "}
                    {(compat.mandatoryAttributes || []).map((a) => a.code || a.name).join(", ") || "—"}
                  </p>
                  <p className="mt-1 text-brown/50">{compat.note}</p>
                  {(compat.blockers || []).map((b) => (
                    <p key={b} className="mt-1 text-amber-900">
                      {b}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={BUTTON}
                  disabled={reviewBusy || !reviewReady}
                  onClick={buildReview}
                >
                  {reviewBusy ? t.loading : t.elryanReviewBeforeSave || "Review before save"}
                </button>
                {!reviewReady ? (
                  <span className="text-xs text-brown/45">
                    {t.elryanSelectCollectionAndCategory ||
                      "Select a collection and an Elryan category."}
                  </span>
                ) : null}
              </div>

              {review ? (
                <div className="space-y-3 rounded-xl bg-white p-4 text-sm ring-1 ring-brown/10">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-tan">
                    {t.elryanSaveConfirmation || "Pre-save confirmation"}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2 text-xs text-brown/75">
                    <div>
                      <p className="font-semibold text-brown">BrownStore</p>
                      <p>
                        {t.category || "Category"}: {loc(review.brownStore?.categoryName)}
                      </p>
                      <p>
                        {t.subCategory || "Subcategory"}: {loc(review.brownStore?.subCategoryName)}
                      </p>
                      <p>
                        {t.collection || "Collection"}: {loc(review.brownStore?.collectionName)}
                      </p>
                      <p>ID: {review.brownStore?.brownCollectionId}</p>
                      <p>
                        {t.products}: {review.brownStore?.productCount}
                      </p>
                    </div>
                    <div>
                      <p className="font-semibold text-brown">Elryan ({review.environment})</p>
                      <p>ID: {review.elryan?.categoryId}</p>
                      <p>{review.elryan?.categoryName}</p>
                      <p>{review.elryan?.categoryHierarchy}</p>
                      <p>
                        {kindLabel(t, review.elryan?.kind, review.elryan?.isParent)} · AS{" "}
                        {review.elryan?.attributeSetId || "—"}
                      </p>
                    </div>
                  </div>

                  {(review.blockers || []).map((b) => (
                    <p key={b} className="text-xs text-red-700">
                      {b}
                    </p>
                  ))}
                  {(review.warnings || []).map((w) => (
                    <p key={w} className="text-xs text-amber-900">
                      {w}
                    </p>
                  ))}
                  {(review.notes || []).map((n) => (
                    <p key={n} className="text-xs text-brown/50">
                      {n}
                    </p>
                  ))}

                  {review.requiresOverwriteConfirmation ? (
                    <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-950 ring-1 ring-amber-700/20">
                      <p className="font-semibold">{t.elryanOverwriteTitle || "Existing mapping will change"}</p>
                      <ul className="mt-2 list-disc ps-4">
                        {(review.changes || []).map((c) => (
                          <li key={c.key}>
                            {c.key}: {c.before || "—"} → {c.after || "—"}
                          </li>
                        ))}
                      </ul>
                      <label className="mt-3 flex items-center gap-2 font-semibold">
                        <input
                          type="checkbox"
                          checked={overwriteAck}
                          onChange={(e) => setOverwriteAck(e.target.checked)}
                        />
                        {t.elryanOverwriteConfirm || "I confirm overwriting the existing mapping"}
                      </label>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className={review.requiresOverwriteConfirmation ? BUTTON_DANGER : BUTTON}
                    disabled={
                      saveBusy ||
                      !review.canSave ||
                      (review.requiresOverwriteConfirmation && !overwriteAck)
                    }
                    onClick={saveMapping}
                  >
                    {saveBusy ? t.loading : t.elryanSaveMapping || "Save Mapping"}
                  </button>
                </div>
              ) : null}

              <p className="text-xs text-brown/50">{t.elryanNoAutoSave}</p>
            </>
          ) : (
            <p className="text-sm text-brown/45">{t.elryanSmartMappingPick}</p>
          )}
        </div>
      </div>
    </div>
  );
}
