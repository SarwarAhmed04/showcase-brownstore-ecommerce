import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import {
  applySaveToCardDraft,
  brownStoreTaxonomyPath,
  cardDraft,
  locName,
  pickCategoryOnCard,
  reviewBrownStorePath,
  searchHitsForCollection,
  toggleElryanPicker,
  unmappedCollectionCount,
} from "../../../utils/elryanCategoryMappingPage";
import {
  ELRYAN_COLLECTION_PAGE_SIZE,
  applyElryanMappingSaveResult,
  buildElryanMappingSaveBody,
  canReviewElryanMapping,
  elryanCollectionPreviewQuery,
  elryanManualSearchQuery,
  isElryanCategoryPicked,
  nextManualSearchOffset,
  nextUnmappedCollectionId,
  pickNextUnmapped,
  planCollectionPageChange,
  resetCollectionPaging,
  resolveDisplayedElryanCategory,
} from "../../../utils/elryanSmartMappingSelect";
import ElryanCatalogBrowse from "./ElryanCatalogBrowse";
import { formatCount, StatusBadge } from "./platformUi";

const BUTTON =
  "rounded-full bg-brown px-4 py-2 text-xs font-semibold text-cream disabled:opacity-50";
const BUTTON_GHOST =
  "rounded-full bg-white px-4 py-2 text-xs font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";
const BUTTON_DANGER =
  "rounded-full border border-amber-700/30 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-950 disabled:opacity-50";

function confidenceClass(band) {
  if (band === "HIGH") return "bg-emerald-50 text-emerald-800";
  if (band === "MEDIUM") return "bg-white text-brown ring-1 ring-brown/10";
  if (band === "LOW" || band === "NEEDS_REVIEW") return "bg-amber-50 text-amber-900";
  return "bg-brown/10 text-brown/55";
}

function kindLabel(t, kind, isParent) {
  if (kind === "leaf" || isParent === false) return t.elryanCategoryLeaf;
  if (kind === "parent" || isParent === true) return t.elryanCategoryParent;
  return t.elryanCategoryKindUnknown;
}

function ProgressLine({ t, payload }) {
  const progress = payload?.progress;
  if (!progress) return null;
  if (progress.exact) {
    return (
      <p className="text-xs font-semibold text-brown/70">
        {t.elryanShowingPrefix || "Showing"} {progress.from}–{progress.to} {t.elryanOfTotal || "of"}{" "}
        {progress.total}
      </p>
    );
  }
  const scannedTo = Number(progress.scannedTo) || 0;
  const scannedFrom = Number(progress.scannedFrom) || 0;
  const from = scannedTo > scannedFrom ? scannedFrom + 1 : 0;
  return (
    <p className="text-xs font-semibold text-brown/70">
      {t.elryanShowingPrefix || "Showing"} {progress.pageMatches ?? 0}{" "}
      {t.elryanMatchPageLabel || "matches on this page"}
      {" · "}
      {t.elryanScannedLabel || "scanned"} {from}–{scannedTo} {t.elryanOfTotal || "of"}{" "}
      {progress.filteredCollections ?? "—"}
    </p>
  );
}

function Stat({ label, value }) {
  return (
    <article className="rounded-2xl bg-cream px-4 py-3">
      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums">{value}</p>
    </article>
  );
}

function CategoryHit({ active, title, meta, detail, onSelect, dataAttr, dataValue, forId }) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        data-elryan-suggestion-for={forId}
        {...{ [dataAttr]: dataValue }}
        onClick={onSelect}
        className={`w-full rounded-xl px-3 py-2 text-start hover:bg-cream ${
          active ? "bg-cream ring-2 ring-brown" : "bg-white"
        }`}
      >
        <span className="font-semibold text-brown">{title || "—"}</span>
        <span className="mt-0.5 block break-words text-xs text-brown/55" dir="ltr">
          {meta}
        </span>
        {detail ? (
          <span className="mt-0.5 block break-words text-xs text-brown/45" dir="ltr">
            {detail}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function hitMeta(t, row) {
  return [
    `${t.elryanCategoryIdLabel || "ID"} ${row.categoryId}`,
    kindLabel(t, row.kind, row.isParent),
    row.attributeSetId != null && row.attributeSetId !== ""
      ? `${t.elryanAttributeSetLabel || "Attribute set"} ${row.attributeSetId}`
      : "",
    row.confidence || "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function ElryanSmartMapping({ t, lang = "en" }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [confidence, setConfidence] = useState("");
  const [busy, setBusy] = useState(true);
  const [payload, setPayload] = useState(null);
  const [pageError, setPageError] = useState("");
  const [pageNotice, setPageNotice] = useState("");
  const [pageOffset, setPageOffset] = useState(0);
  const [offsetHistory, setOffsetHistory] = useState([0]);
  const [drafts, setDrafts] = useState({});
  const [pickerFor, setPickerFor] = useState("");
  const [cursorId, setCursorId] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);

  const [manualQ, setManualQ] = useState("");
  const [manualLeafOnly, setManualLeafOnly] = useState(true);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualOffset, setManualOffset] = useState(0);
  const [manualResult, setManualResult] = useState(null);
  const [manualFor, setManualFor] = useState("");

  const [compat, setCompat] = useState(null);
  const [reviewBusyId, setReviewBusyId] = useState("");
  const [saveBusyId, setSaveBusyId] = useState("");

  const requestSeq = useRef(0);
  const manualSeq = useRef(0);
  const filtersRef = useRef({ q: "", status: "", confidence: "" });
  const pagingRef = useRef({ offset: 0, history: [0] });
  const draftsRef = useRef(drafts);
  const leafRef = useRef(true);
  filtersRef.current = { q: query, status, confidence };
  draftsRef.current = drafts;
  leafRef.current = manualLeafOnly;

  const rows = payload?.rows || [];
  const history = offsetHistory.length ? offsetHistory : [0];
  const historyIndex = history.lastIndexOf(pageOffset);
  const canPrev = historyIndex > 0;

  async function loadCollections({ offset = 0, history: nextHistory = [0], resetDrafts = false } = {}) {
    const seq = ++requestSeq.current;
    const filters = filtersRef.current;
    setBusy(true);
    setPageError("");
    setPageNotice("");
    if (resetDrafts) {
      setDrafts({});
      setPickerFor("");
      setCursorId("");
      setManualResult(null);
      setManualFor("");
    }
    try {
      const data = await api.elryanMappingPreview(
        elryanCollectionPreviewQuery({
          q: filters.q,
          status: filters.status,
          confidence: filters.confidence,
          offset,
          limit: ELRYAN_COLLECTION_PAGE_SIZE,
        })
      );
      if (seq !== requestSeq.current) return null;
      const resolvedOffset = data.offset ?? offset;
      setPayload(data);
      setPageOffset(resolvedOffset);
      setOffsetHistory(nextHistory);
      pagingRef.current = { offset: resolvedOffset, history: nextHistory };
      return data;
    } catch (err) {
      if (seq !== requestSeq.current) return null;
      setPayload(null);
      setPageError(err.message);
      return null;
    } finally {
      if (seq === requestSeq.current) setBusy(false);
    }
  }

  useEffect(() => {
    const reset = resetCollectionPaging();
    loadCollections({
      offset: reset.offset,
      history: reset.history,
      resetDrafts: true,
    });
    // Search text is applied on submit. Status and confidence reload from the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, status, confidence]);

  function updateDraft(collectionId, updater) {
    setDrafts((prev) => {
      const current = { ...cardDraft(prev, collectionId) };
      const next = updater(current);
      return { ...prev, [collectionId]: next };
    });
  }

  function pickCategory(collectionId, category, source) {
    const result = pickCategoryOnCard(draftsRef.current, collectionId, category, source);
    if (!result.picked) {
      const id = String(collectionId || "");
      setDrafts({
        ...result.drafts,
        [id]: {
          ...result.drafts[id],
          error: t.elryanSelectCandidate || "Select category",
        },
      });
    } else {
      setDrafts(result.drafts);
    }
    setCompat(null);
  }

  async function runManualSearch(offset = 0, leafOnly = manualLeafOnly, forId = pickerFor, term = manualQ) {
    const owner = String(forId || "");
    if (!owner) return;
    const seq = ++manualSeq.current;
    setManualBusy(true);
    if (manualFor !== owner) {
      setManualResult(null);
      setManualOffset(0);
    }
    setManualFor(owner);
    try {
      const data = await api.elryanMappingSnapshotSearch(
        elryanManualSearchQuery({
          q: term,
          offset,
          leafOnly,
          limit: 25,
        })
      );
      if (seq !== manualSeq.current) return;
      setManualResult(data);
      setManualOffset(data.offset ?? offset);
      setManualFor(owner);
    } catch (err) {
      if (seq !== manualSeq.current) return;
      setManualResult(null);
      updateDraft(owner, (prev) => ({ ...prev, error: err.message }));
    } finally {
      if (seq === manualSeq.current) setManualBusy(false);
    }
  }

  function openPicker(row) {
    const id = String(row.brownCollectionId || "");
    const next = toggleElryanPicker(pickerFor, id);
    setPickerFor(next);
    if (next) setCursorId(next);
    if (!next) return;
    const term = locName(row.brownCollectionName, lang);
    setManualQ(term);
    if (term) runManualSearch(0, leafRef.current, id, term);
    else {
      setManualResult(null);
      setManualFor(id);
    }
  }

  async function inspectAttributes(collectionId, categoryId) {
    if (!categoryId) return;
    setCompat(null);
    try {
      const data = await api.elryanCategoryAttributeCompatibility(categoryId);
      setCompat({ forId: collectionId, data });
    } catch (err) {
      setCompat({ forId: collectionId, data: { blockers: [err.message] } });
    }
  }

  async function buildReview(collectionId) {
    const current = cardDraft(draftsRef.current, collectionId);
    if (!canReviewElryanMapping(collectionId, current.pickedCategoryId)) {
      updateDraft(collectionId, (prev) => ({
        ...prev,
        error: t.elryanSelectCollectionAndCategory || "Select a collection and an Elryan category.",
      }));
      return;
    }
    setReviewBusyId(collectionId);
    try {
      const data = await api.elryanMappingPreviewSave({
        brownCollectionId: collectionId,
        categoryId: current.pickedCategoryId,
        includeAttributes: true,
      });
      setDrafts((prev) => {
        const latest = cardDraft(prev, collectionId);
        if (!isElryanCategoryPicked(latest.pickedCategoryId, current.pickedCategoryId)) return prev;
        return {
          ...prev,
          [collectionId]: { ...latest, review: data, overwriteAck: false, error: "" },
        };
      });
      if (data.attributes) setCompat({ forId: collectionId, data: data.attributes });
    } catch (err) {
      updateDraft(collectionId, (prev) => ({ ...prev, review: null, error: err.message }));
    } finally {
      setReviewBusyId("");
    }
  }

  async function saveMapping(collectionId) {
    const current = cardDraft(draftsRef.current, collectionId);
    const decision = buildElryanMappingSaveBody({
      brownCollectionId: collectionId,
      categoryId: current.pickedCategoryId,
      review: current.review,
      overwriteAck: current.overwriteAck,
      source: current.pickSource,
    });
    if (!decision.allowed) {
      updateDraft(collectionId, (prev) => ({
        ...prev,
        error:
          decision.reason === "overwrite_required"
            ? t.elryanOverwriteRequired || "Confirm overwrite of the existing mapping first."
            : t.elryanSelectCollectionAndCategory || "Select a collection and an Elryan category.",
      }));
      return;
    }
    setSaveBusyId(collectionId);
    try {
      const data = await api.elryanMappingSave(decision.body);
      const applied = applyElryanMappingSaveResult({
        rows: payload?.rows || [],
        selectedId: collectionId,
        saveResult: data,
        successMessage:
          t.elryanMappingSaveSuccess || "Mapping saved locally. Nothing was sent to Elryan.",
      });
      setPayload((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          rows: applied.rows,
          counts: {
            ...prev.counts,
            mapped: (prev.counts?.mapped || 0) + (applied.mappedDelta || 0),
          },
        };
      });
      setDrafts((prev) =>
        applySaveToCardDraft(prev, applied.selectedId || collectionId, {
          claimedSuccess: applied.claimedSuccess,
          message: applied.message,
          warning: applied.claimedSuccess
            ? ""
            : t.elryanReadBackFailed || "Saved, but read-back did not match. Refresh and verify.",
        })
      );
      setCursorId(String(applied.selectedId || collectionId));
      setPickerFor("");
      setCompat(null);
    } catch (err) {
      updateDraft(collectionId, (prev) => ({
        ...prev,
        error: err.message || t.elryanMappingSaveFailed || "Save failed.",
        message: "",
      }));
    } finally {
      setSaveBusyId("");
    }
  }

  function goPrev() {
    const plan = planCollectionPageChange({
      history: pagingRef.current.history,
      offset: pagingRef.current.offset,
      direction: "prev",
    });
    if (!plan.moved) return;
    loadCollections({ offset: plan.offset, history: plan.history, resetDrafts: false });
  }

  function goNext() {
    const plan = planCollectionPageChange({
      history: pagingRef.current.history,
      offset: pagingRef.current.offset,
      direction: "next",
      nextOffset: payload?.nextOffset,
      hasMore: Boolean(payload?.hasMore),
    });
    if (!plan.moved) return;
    loadCollections({ offset: plan.offset, history: plan.history, resetDrafts: false });
  }

  function focusCollection(id, row) {
    const nextId = String(id || "");
    if (!nextId) return;
    setPickerFor(nextId);
    setCursorId(nextId);
    const term = locName(row?.brownCollectionName, lang);
    setManualQ(term);
    if (term) runManualSearch(0, leafRef.current, nextId, term);
    requestAnimationFrame(() => {
      document.getElementById(`elryan-collection-${nextId}`)?.scrollIntoView({ block: "nearest" });
    });
  }

  async function goNextUnmapped() {
    const local = pickNextUnmapped({
      rows,
      selectedId: pickerFor || cursorId,
      hasMore: Boolean(payload?.hasMore),
    });
    if (local.action === "select") {
      const row = rows.find((item) => item.brownCollectionId === local.brownCollectionId) || null;
      focusCollection(local.brownCollectionId, row);
      return;
    }
    if (local.action !== "load-next") {
      setPageNotice(t.elryanNoNextUnmapped || "No further unmapped collection in this view.");
      return;
    }

    let historyCursor = pagingRef.current.history;
    let currentOffset = pagingRef.current.offset;
    let cursor = payload?.nextOffset;
    let more = true;
    for (let guard = 0; guard < 25 && more; guard += 1) {
      const plan = planCollectionPageChange({
        history: historyCursor,
        offset: currentOffset,
        direction: "next",
        nextOffset: cursor,
        hasMore: true,
      });
      if (!plan.moved) break;
      const data = await loadCollections({
        offset: plan.offset,
        history: plan.history,
        resetDrafts: false,
      });
      if (!data) return;
      historyCursor = plan.history;
      currentOffset = data.offset ?? plan.offset;
      const hit = nextUnmappedCollectionId(data.rows || [], "");
      if (hit) {
        const hitRow = (data.rows || []).find((row) => row.brownCollectionId === hit) || null;
        focusCollection(hit, hitRow);
        return;
      }
      more = Boolean(data.hasMore);
      cursor = data.nextOffset;
    }
    setPageNotice(
      more
        ? t.elryanNextUnmappedContinue || "More collections remain. Click Next unmapped to continue."
        : t.elryanNoNextUnmapped || "No further unmapped collection in this view."
    );
  }

  const counts = payload?.counts || {};
  const unmapped = unmappedCollectionCount(counts);
  const showStat = payload ? (value) => formatCount(value) : () => "—";

  return (
    <div className="elryan-category-mapping space-y-5">
      <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-brown/5 sm:p-6">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.elryanCategoryMappingTitle || "Category Mapping"}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-brown/55">
          {t.elryanCategoryMappingHint || t.elryanSmartMappingHint}
        </p>
        <p className="mt-2 text-xs font-semibold text-amber-900">{t.elryanSmartMappingExplicitSave}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Stat label={t.statTotalCollections} value={showStat(counts.collections)} />
          <Stat label={t.elryanStatMapped || t.elryanFilterMapped} value={showStat(counts.mapped)} />
          <Stat
            label={t.elryanStatUnmapped || t.elryanFilterUnmapped}
            value={unmapped == null ? "—" : formatCount(unmapped)}
          />
        </div>

        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = q.trim();
            if (trimmed === query) {
              const reset = resetCollectionPaging();
              loadCollections({ offset: reset.offset, history: reset.history, resetDrafts: true });
              return;
            }
            setQuery(trimmed);
          }}
        >
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder={t.elryanCollectionSearchPlaceholder || t.categorySearch}
            aria-label={t.elryanCollectionSearchPlaceholder || t.categorySearch}
            className="min-w-[12rem] flex-1 rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm text-brown"
          />
          <button type="submit" className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream">
            {t.categorySearch || t.search}
          </button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-[1.25rem] bg-cream p-1 sm:w-fit">
            {[
              ["", t.filterAll],
              ["mapped", t.elryanFilterMapped],
              ["unmapped", t.elryanFilterUnmapped],
            ].map(([id, text]) => (
              <button
                key={id || "all"}
                type="button"
                onClick={() => setStatus(id)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  status === id ? "bg-white text-brown shadow-sm" : "text-brown/55"
                }`}
              >
                {text}
              </button>
            ))}
          </div>
          <select
            className="rounded-full border border-brown/10 bg-cream px-3 py-1.5 text-xs font-semibold text-brown"
            value={confidence}
            onChange={(event) => setConfidence(event.target.value)}
            aria-label={t.elryanFilterAllConfidence}
          >
            <option value="">{t.elryanFilterAllConfidence}</option>
            <option value="HIGH">HIGH</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="LOW">LOW</option>
            <option value="NEEDS_REVIEW">NEEDS_REVIEW</option>
            <option value="NO_MATCH">NO_MATCH</option>
          </select>
        </div>

        {pageError ? (
          <p className="mt-3 text-sm text-red-700" role="alert">
            {pageError}
          </p>
        ) : null}
        {pageNotice ? <p className="mt-3 text-sm text-brown/70">{pageNotice}</p> : null}
        {payload?.catalog ? (
          <p className="mt-3 text-[11px] text-brown/45">
            {t.elryanCatalogStatus}: {payload.catalog.status} · {payload.catalog.uniqueCount} ·{" "}
            {payload.environment || "staging"}
          </p>
        ) : null}

        <div className="mt-5 space-y-3">
          {rows.map((row) => {
            const id = row.brownCollectionId;
            const draft = cardDraft(drafts, id);
            const mapped = Boolean(row.existingMapping?.configured);
            const taxonomy = brownStoreTaxonomyPath(row, lang);
            const open = pickerFor === id;
            const hits = searchHitsForCollection({
              manualFor,
              collectionId: id,
              categories: manualResult?.categories,
            });
            const chosen = resolveDisplayedElryanCategory({
              pickedCategoryId: draft.pickedCategoryId,
              snapshot: draft.pickedSnapshot,
              candidates: row.candidates || [],
              manualCategories: hits,
            });
            const top = (row.candidates || [])[0] || null;
            const savedValues = row.existingMapping?.values || {};
            const reviewReady = canReviewElryanMapping(id, draft.pickedCategoryId);
            const manualPrev = nextManualSearchOffset({
              offset: manualOffset,
              limit: manualResult?.limit || 25,
              totalMatching: manualResult?.totalMatching || 0,
              direction: "prev",
            });
            const manualNext = nextManualSearchOffset({
              offset: manualOffset,
              limit: manualResult?.limit || 25,
              totalMatching: manualResult?.totalMatching || 0,
              direction: "next",
            });
            const cardCompat = compat?.forId === id ? compat.data : null;

            return (
              <article
                key={id}
                id={`elryan-collection-${id}`}
                data-elryan-collection-card={id}
                data-product-count={row.productCount}
                data-mapping-status={mapped ? "mapped" : "unmapped"}
                className="rounded-2xl bg-cream p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                      {t.elryanBrownStoreLabel || "BrownStore"}
                    </p>
                    <p className="mt-1 break-words text-sm font-semibold text-brown">{taxonomy}</p>
                    <p className="mt-1 text-xs text-brown/50">
                      <span dir="ltr">{t.elryanCategoryIdLabel || "ID"} {id}</span>
                      {" · "}
                      {formatCount(row.productCount)} {t.products}
                    </p>
                    {savedValues.categoryId ? (
                      <p className="mt-2 break-words text-xs text-brown/60" dir="ltr">
                        {t.elryanCurrentMapping}: {savedValues.categoryName || "—"} · {savedValues.categoryId}
                        {savedValues.categoryHierarchy ? ` · ${savedValues.categoryHierarchy}` : ""}
                      </p>
                    ) : null}
                  </div>
                  <StatusBadge kind={mapped ? "ready" : "missing_setup"} t={t}>
                    {mapped ? t.elryanFilterMapped : t.elryanFilterUnmapped}
                  </StatusBadge>
                </div>

                {draft.message ? (
                  <p
                    className="mt-3 rounded-2xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800"
                    role="status"
                  >
                    {draft.message}
                  </p>
                ) : null}
                {draft.error ? (
                  <p className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                    {draft.error}
                  </p>
                ) : null}

                <div className="mt-4 space-y-3">
                  <p className="text-xs font-semibold text-brown/60">{t.elryanCategory || "Elryan Category"}</p>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => openPicker(row)}
                    className={BUTTON_GHOST}
                  >
                    {open && manualBusy && manualFor === id
                      ? t.loading
                      : t.elryanPickCategory || "Search / Select Elryan Category"}
                  </button>

                  {!chosen && top ? (
                    <button
                      type="button"
                      data-elryan-suggestion={String(top.categoryId)}
                      data-elryan-suggestion-for={id}
                      aria-pressed={false}
                      onClick={() => pickCategory(id, top, "smart")}
                      className="w-full rounded-xl bg-white px-3 py-2 text-start ring-1 ring-brown/10"
                    >
                      <span className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                        {t.elryanSuggestedLabel || "Suggested"}
                      </span>
                      <span className="mt-1 block break-words text-sm font-semibold text-brown">
                        {top.categoryName || "—"}
                      </span>
                      <span className="mt-0.5 block break-words text-xs text-brown/55" dir="ltr">
                        {hitMeta(t, top)}
                      </span>
                      {top.hierarchy ? (
                        <span className="mt-0.5 block break-words text-xs text-brown/45" dir="ltr">
                          {top.hierarchy}
                        </span>
                      ) : null}
                    </button>
                  ) : null}

                  {chosen ? (
                    <div className="rounded-xl bg-white p-3 text-xs text-brown/75 ring-2 ring-brown/25">
                      <p className="font-semibold text-brown">
                        {t.elryanCategorySelected || "Selected"}: {chosen.categoryName || "—"}
                      </p>
                      <p className="mt-1 break-words" dir="ltr">
                        {t.elryanCategoryIdLabel || "ID"} {chosen.categoryId}
                      </p>
                      {chosen.hierarchy ? (
                        <p className="mt-1 break-words" dir="ltr">
                          {chosen.hierarchy}
                        </p>
                      ) : null}
                      <p className="mt-1 text-brown/50">
                        {kindLabel(t, chosen.kind, chosen.isParent)}
                        {chosen.attributeSetId != null ? ` · ${t.elryanAttributeSetLabel} ${chosen.attributeSetId}` : ""}
                        {chosen.confidence ? ` · ${chosen.confidence}` : ""}
                      </p>
                      <p className="mt-1 text-brown/50">{t.elryanReviewReadyHint}</p>
                    </div>
                  ) : null}

                  {open ? (
                    <div
                      className="rounded-2xl bg-white p-3 ring-1 ring-brown/10"
                      data-elryan-picker={id}
                    >
                      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                        {t.elryanSuggestionsTitle || "Suggested categories"}
                      </p>
                      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-sm">
                        {(row.candidates || []).map((candidate) => (
                          <CategoryHit
                            key={String(candidate.categoryId)}
                            forId={id}
                            active={isElryanCategoryPicked(draft.pickedCategoryId, candidate.categoryId)}
                            title={candidate.categoryName}
                            meta={hitMeta(t, candidate)}
                            detail={candidate.hierarchy}
                            dataAttr="data-elryan-suggestion"
                            dataValue={String(candidate.categoryId)}
                            onSelect={() => pickCategory(id, candidate, "smart")}
                          />
                        ))}
                        {!row.candidates?.length ? (
                          <li className="px-2 py-2 text-xs text-brown/45">{t.elryanNoSuggestions}</li>
                        ) : null}
                      </ul>

                      <form
                        className="mt-3 flex flex-wrap gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          runManualSearch(0, manualLeafOnly, id, manualQ);
                        }}
                      >
                        <input
                          id={`elryan-category-search-${id}`}
                          value={manualQ}
                          onChange={(event) => setManualQ(event.target.value)}
                          placeholder={t.elryanSearchCategoryPlaceholder}
                          aria-label={t.elryanSearchCategoryPlaceholder}
                          className="min-w-[10rem] flex-1 rounded-full border border-brown/10 bg-cream px-3 py-1.5 text-sm text-brown"
                        />
                        <button type="submit" disabled={manualBusy} className={`${BUTTON} disabled:opacity-50`}>
                          {t.categorySearch || t.search}
                        </button>
                      </form>
                      <label className="mt-2 flex items-center gap-2 text-xs font-semibold text-brown/70">
                        <input
                          type="checkbox"
                          checked={manualLeafOnly}
                          onChange={(event) => {
                            const next = event.target.checked;
                            setManualLeafOnly(next);
                            runManualSearch(0, next, id, manualQ);
                          }}
                        />
                        {t.elryanLeafOnly || "Leaves preferred"}
                      </label>
                      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-sm">
                        {hits.map((hit) => (
                          <CategoryHit
                            key={String(hit.categoryId)}
                            forId={id}
                            active={isElryanCategoryPicked(draft.pickedCategoryId, hit.categoryId)}
                            title={hit.categoryName}
                            meta={hitMeta(t, hit)}
                            detail={hit.hierarchy}
                            dataAttr="data-elryan-search-hit"
                            dataValue={String(hit.categoryId)}
                            onSelect={() => pickCategory(id, hit, "manual")}
                          />
                        ))}
                        {manualResult && manualFor === id && !hits.length ? (
                          <li className="px-2 py-2 text-xs text-brown/45">{t.elryanNoCategoriesYet}</li>
                        ) : null}
                      </ul>
                      {manualResult && manualFor === id ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-brown/55">
                          <span>
                            {manualResult.totalMatching} {t.elryanTotalResults || "results"} ·{" "}
                            {manualResult.offset + 1}–{manualResult.offset + (manualResult.categories?.length || 0)}
                          </span>
                          <button
                            type="button"
                            className={BUTTON_GHOST}
                            disabled={manualBusy || !manualPrev.moved}
                            onClick={() => runManualSearch(manualPrev.offset, manualLeafOnly, id, manualQ)}
                          >
                            {t.pagePrevious}
                          </button>
                          <button
                            type="button"
                            className={BUTTON_GHOST}
                            disabled={manualBusy || !manualNext.moved}
                            onClick={() => runManualSearch(manualNext.offset, manualLeafOnly, id, manualQ)}
                          >
                            {t.pageNext}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={reviewBusyId === id || !reviewReady}
                      onClick={() => buildReview(id)}
                    >
                      {reviewBusyId === id ? t.loading : t.elryanReviewAndSave || "Review & Save"}
                    </button>
                  </div>

                  {draft.review ? (
                    <div
                      className="space-y-3 rounded-xl bg-white p-4 text-sm ring-1 ring-brown/10"
                      data-elryan-review={id}
                    >
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-tan">
                        {t.elryanSaveConfirmation || "Pre-save confirmation"}
                      </p>
                      <div className="text-xs text-brown/80">
                        <p className="font-semibold text-brown">
                          {t.elryanBrownStoreLabel || "BrownStore"}
                        </p>
                        <p className="mt-1 break-words">
                          {reviewBrownStorePath(draft.review.brownStore, lang)}
                        </p>
                        <p className="mt-1">
                          {t.elryanCategoryIdLabel || "ID"} {draft.review.brownStore?.brownCollectionId} · {t.products}{" "}
                          {draft.review.brownStore?.productCount}
                        </p>
                        <p className="mt-3 font-semibold text-brown">{t.elryanCategory || "Elryan Category"}</p>
                        <p className="mt-1 break-words" dir="ltr">
                          {draft.review.elryan?.categoryName}
                        </p>
                        <p className="mt-1 break-words" dir="ltr">
                          {draft.review.elryan?.categoryHierarchy}
                        </p>
                        <p className="mt-1" dir="ltr">
                          {t.elryanCategoryIdLabel || "ID"} {draft.review.elryan?.categoryId} ·{" "}
                          {kindLabel(t, draft.review.elryan?.kind, draft.review.elryan?.isParent)} ·{" "}
                          {t.elryanAttributeSetLabel} {draft.review.elryan?.attributeSetId || "—"} ·{" "}
                          {draft.review.environment}
                        </p>
                      </div>
                      {(draft.review.blockers || []).map((blocker) => (
                        <p key={blocker} className="text-xs text-red-700">
                          {blocker}
                        </p>
                      ))}
                      {(draft.review.warnings || []).map((warning) => (
                        <p key={warning} className="text-xs text-amber-900">
                          {warning}
                        </p>
                      ))}
                      {draft.review.requiresOverwriteConfirmation ? (
                        <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-950 ring-1 ring-amber-700/20">
                          <p className="font-semibold">{t.elryanOverwriteTitle || "Existing mapping will change"}</p>
                          <ul className="mt-2 list-disc ps-4">
                            {(draft.review.changes || []).map((change) => (
                              <li key={change.key}>
                                {change.key}: {change.before || "—"} → {change.after || "—"}
                              </li>
                            ))}
                          </ul>
                          <label className="mt-3 flex items-center gap-2 font-semibold">
                            <input
                              type="checkbox"
                              checked={draft.overwriteAck}
                              onChange={(event) =>
                                updateDraft(id, (prev) => ({ ...prev, overwriteAck: event.target.checked }))
                              }
                            />
                            {t.elryanOverwriteConfirm || "I confirm overwriting the existing mapping"}
                          </label>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        data-elryan-confirm-save={id}
                        className={draft.review.requiresOverwriteConfirmation ? BUTTON_DANGER : BUTTON}
                        disabled={
                          saveBusyId === id ||
                          !draft.review.canSave ||
                          (draft.review.requiresOverwriteConfirmation && !draft.overwriteAck)
                        }
                        onClick={() => saveMapping(id)}
                      >
                        {saveBusyId === id ? t.loading : t.elryanConfirmSave || "Confirm and save"}
                      </button>
                    </div>
                  ) : null}

                  <details className="rounded-xl bg-white p-3 text-xs text-brown/70 ring-1 ring-brown/5">
                    <summary className="cursor-pointer font-semibold text-brown">
                      {t.elryanAdvancedDetails || "Advanced details"}
                    </summary>
                    <div className="mt-2 space-y-2">
                      {(draft.pickedSnapshot?.reasons || []).slice(0, 6).map((reason) => (
                        <p key={reason}>{reason}</p>
                      ))}
                      {draft.pickedSnapshot?.productEvidence?.length ? (
                        <p>
                          {t.elryanProductEvidence}: {draft.pickedSnapshot.productEvidence.join(", ")}
                        </p>
                      ) : null}
                      {(draft.pickedSnapshot?.missing || []).map((item) => (
                        <p key={item} className="text-amber-900">
                          {item}
                        </p>
                      ))}
                      <button
                        type="button"
                        className={BUTTON_GHOST}
                        disabled={!draft.pickedCategoryId}
                        onClick={() => inspectAttributes(id, draft.pickedCategoryId)}
                      >
                        {t.elryanInspectAttributes}
                      </button>
                      {cardCompat ? (
                        <div className="rounded-xl bg-cream p-2">
                          <p className="font-semibold text-brown">{t.elryanAttributeCompatibility}</p>
                          <p className="mt-1">
                            {t.elryanAttributeSetLabel}: {cardCompat.attributeSetId || "—"}{" "}
                            {cardCompat.attributeSetName || ""}
                          </p>
                          <p className="mt-1">
                            {(cardCompat.mandatoryAttributes || []).map((attr) => attr.code || attr.name).join(", ") ||
                              "—"}
                          </p>
                          {(cardCompat.blockers || []).map((blocker) => (
                            <p key={blocker} className="mt-1 text-amber-900">
                              {blocker}
                            </p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </details>

                  <p className="text-xs text-brown/50">{t.elryanNoAutoSave}</p>
                </div>
              </article>
            );
          })}
          {payload && !rows.length ? (
            <p className="text-sm text-brown/50">
              {payload.hasMore
                ? t.elryanScanWindowEmpty || "No matches in this scan window. Use Next to continue."
                : t.elryanSmartMappingEmpty}
            </p>
          ) : null}
        </div>

        {payload ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
            <button
              type="button"
              disabled={busy || !canPrev}
              onClick={goPrev}
              className="rounded-full px-3 py-1.5 font-semibold text-brown/60 disabled:opacity-40"
            >
              {t.pagePrevious}
            </button>
            <ProgressLine t={t} payload={payload} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={BUTTON_GHOST} disabled={busy} onClick={goNextUnmapped}>
                {t.elryanNextUnmapped || "Next unmapped"}
              </button>
              <button
                type="button"
                disabled={busy || !payload.hasMore}
                onClick={goNext}
                className="rounded-full px-3 py-1.5 font-semibold text-brown/60 disabled:opacity-40"
              >
                {t.pageNext}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <details
        className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-brown/5 sm:p-6"
        onToggle={(event) => setCatalogOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm font-semibold text-brown">
          {t.elryanOfficialCatalogAdvanced || "Official Elryan catalog"}
        </summary>
        <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.elryanOfficialCatalogAdvancedHint}</p>
        {catalogOpen ? (
          <div className="mt-4">
            <ElryanCatalogBrowse t={t} embedded />
          </div>
        ) : null}
      </details>
    </div>
  );
}
