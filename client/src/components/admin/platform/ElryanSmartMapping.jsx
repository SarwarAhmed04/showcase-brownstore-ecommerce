import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import {
  applySaveToCardDraft,
  brownStoreTaxonomyPath,
  cardDraft,
  elryanCategoryRowStatus,
  pickCategoryOnCard,
  searchHitsForCollection,
  unmappedCollectionCount,
} from "../../../utils/elryanCategoryMappingPage";
import ElryanMappingPager from "./ElryanMappingPager";
import {
  applyElryanMappingSaveResult,
  buildElryanMappingSaveBody,
  acceptElryanAttributeResponse,
  canReviewElryanMapping,
  elryanCollectionPreviewQuery,
  isElryanConfirmedLeaf,
  elryanCategorySelectorQuery,
  isElryanCategoryPicked,
  nextManualSearchOffset,
  nextUnmappedCollectionId,
  pickNextUnmapped,
  planCollectionPageChange,
  resetCollectionPaging,
  resolveDisplayedElryanCategory,
} from "../../../utils/elryanSmartMappingSelect";
import ElryanCatalogBrowse from "./ElryanCatalogBrowse";
import { elryanCatalogEnvironmentLabel } from "../../../utils/elryanCatalogStatusUi";
import { formatCount } from "./platformUi";

const BUTTON =
  "rounded-full bg-brown px-4 py-2 text-xs font-semibold text-cream disabled:opacity-50";
const BUTTON_GHOST =
  "rounded-full bg-white px-4 py-2 text-xs font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

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

function elryanChoiceLabel(category) {
  const hierarchy = String(category?.hierarchy || category?.categoryHierarchy || "").trim();
  const name = String(category?.categoryName || "").trim();
  return hierarchy || name;
}

function ElryanLeafSelect({
  id,
  open,
  query,
  busy,
  hits,
  searchError,
  scope,
  canGoBack,
  selectedLabel,
  disabled,
  t,
  onOpen,
  onQuery,
  onSelect,
  onExpand,
  onBrowseAll,
  onBack,
  pageLabel,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
}) {
  const searching = String(query || "").trim().length > 0;
  const emptyMessage = searchError
    ? searchError
    : searching
      ? t.elryanCategoryNoMatches || "No Elryan categories match this search."
      : scope === "children"
        ? t.elryanCategoryBranchEmpty || "No subcategories in this Elryan category."
        : t.elryanNoCategoriesYet;
  return (
    <div id={`elryan-leaf-select-${id}`} className="relative min-w-0" data-elryan-picker={id}>
      <label className="mb-1 block text-[11px] font-semibold tracking-wide text-brown/45 uppercase lg:sr-only">
        {t.elryanCategory || "Elryan category"}
      </label>
      <input
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={`elryan-leaf-list-${id}`}
        autoComplete="off"
        disabled={disabled}
        placeholder={t.elryanSearchCategoryPlaceholder}
        aria-label={t.elryanSearchCategoryPlaceholder}
        value={open ? query : selectedLabel}
        onPointerDown={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        onFocus={onOpen}
        onChange={(event) => onQuery(event.target.value)}
        className="w-full rounded-full border border-brown/10 bg-white px-4 py-2 text-sm font-medium text-brown outline-none ring-tan/40 focus:ring-2 disabled:opacity-50"
      />
      {open ? (
        <div className="mt-2 w-full rounded-2xl bg-white p-2 shadow-lg ring-1 ring-brown/10">
          <ul
            id={`elryan-leaf-list-${id}`}
            role="listbox"
            data-elryan-active-results={id}
            className="max-h-60 space-y-1 overflow-auto"
          >
            {!searching ? (
              <li>
                <button
                  type="button"
                  data-elryan-browse-all={id}
                  onClick={onBrowseAll}
                  className="block w-full rounded-xl px-3 py-2 text-start text-sm font-semibold text-brown hover:bg-cream"
                >
                  {t.elryanBrowseAllCategories || "Browse all Elryan categories"}
                </button>
              </li>
            ) : null}
            {canGoBack && !searching ? (
              <li>
                <button
                  type="button"
                  data-elryan-browse-back={id}
                  onClick={onBack}
                  className="block w-full rounded-xl px-3 py-2 text-start text-sm font-semibold text-brown/70 hover:bg-cream"
                >
                  {t.elryanBrowseBack || "Back"}
                </button>
              </li>
            ) : null}
            {hits.map((hit) => {
              const leaf = isElryanConfirmedLeaf(hit);
              const label = elryanChoiceLabel(hit);
              return (
                <li key={String(hit.categoryId)}>
                  <button
                    type="button"
                    role="option"
                    data-elryan-search-hit={leaf ? String(hit.categoryId) : undefined}
                    data-elryan-expand={leaf ? undefined : String(hit.categoryId)}
                    onClick={() => (leaf ? onSelect(hit) : onExpand(hit))}
                    className="block w-full rounded-xl px-3 py-2 text-start text-sm text-brown hover:bg-cream"
                  >
                    <span className="block break-words font-semibold" dir="auto">
                      {label || "—"}
                    </span>
                    <span className="mt-0.5 block text-xs text-brown/50" dir="ltr">
                      {`${t.elryanCategoryIdLabel || "ID"} ${hit.categoryId}`}
                      {leaf ? "" : ` · ${t.elryanExpandCategory || "Expand"}`}
                    </span>
                  </button>
                </li>
              );
            })}
            {!busy && !hits.length ? (
              <li className="px-3 py-2 text-sm text-brown/55">
                <p>{emptyMessage}</p>
                {searching ? (
                  <button
                    type="button"
                    data-elryan-return-browse={id}
                    onClick={onBrowseAll}
                    className="mt-2 font-semibold text-brown underline"
                  >
                    {t.elryanBrowseAllCategories || "Browse all Elryan categories"}
                  </button>
                ) : null}
              </li>
            ) : null}
            {busy ? <li className="px-3 py-2 text-sm text-brown/55">{t.loading}</li> : null}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-brown/55">
            <button type="button" className={BUTTON_GHOST} disabled={prevDisabled} onClick={onPrev}>
              {t.pagePrevious}
            </button>
            <span dir="ltr">{pageLabel}</span>
            <button type="button" className={BUTTON_GHOST} disabled={nextDisabled} onClick={onNext}>
              {t.pageNext}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
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
  const [pageSize, setPageSize] = useState(25);
  const [offsetHistory, setOffsetHistory] = useState([0]);
  const [drafts, setDrafts] = useState({});
  const [pickerFor, setPickerFor] = useState("");
  const [cursorId, setCursorId] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);

  const [manualQ, setManualQ] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualOffset, setManualOffset] = useState(0);
  const [manualResult, setManualResult] = useState(null);
  const [manualError, setManualError] = useState("");
  const [manualFor, setManualFor] = useState("");
  const [manualScope, setManualScope] = useState("roots");
  const [browseParentId, setBrowseParentId] = useState("");
  const [browseTrail, setBrowseTrail] = useState([]);

  const [compat, setCompat] = useState(null);
  const [reviewBusyId, setReviewBusyId] = useState("");
  const [saveBusyId, setSaveBusyId] = useState("");

  const requestSeq = useRef(0);
  const searchTimer = useRef(null);
  const pageSizeRef = useRef(25);
  const filterKeyRef = useRef(null);
  const environmentRef = useRef("");
  pageSizeRef.current = pageSize;
  const manualSeq = useRef(0);
  const pickerRef = useRef("");
  const compatSeq = useRef(0);
  const compatRequest = useRef({ generation: 0, categoryId: "" });
  const filtersRef = useRef({ q: "", status: "", confidence: "" });
  const pagingRef = useRef({ offset: 0, history: [0] });
  const draftsRef = useRef(drafts);
  filtersRef.current = { q: query, status, confidence };
  draftsRef.current = drafts;

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
      pickerRef.current = "";
      setPickerFor("");
      setCursorId("");
      setManualResult(null);
      setManualFor("");
      setManualScope("roots");
      setBrowseParentId("");
      setBrowseTrail([]);
    }
    try {
      const data = await api.elryanMappingPreview(
        elryanCollectionPreviewQuery({
          q: filters.q,
          status: filters.status,
          confidence: filters.confidence,
          offset,
          limit: pageSizeRef.current,
        })
      );
      if (seq !== requestSeq.current) return null;
      const nextEnvironment = data.environment === "production" ? "production" : data.environment || "";
      if (environmentRef.current && nextEnvironment && environmentRef.current !== nextEnvironment && offset !== 0) {
        environmentRef.current = nextEnvironment;
        loadCollections({ offset: 0, history: [0], resetDrafts: false });
        return data;
      }
      if (nextEnvironment) environmentRef.current = nextEnvironment;
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
    const key = `${query}\0${status}\0${confidence}`;
    const filtersChanged = filterKeyRef.current !== key;
    filterKeyRef.current = key;
    const reset = resetCollectionPaging();
    loadCollections({
      offset: reset.offset,
      history: reset.history,
      resetDrafts: filtersChanged,
    });
    // Search text is applied on submit. Status, confidence, and page size reload from the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, status, confidence, pageSize]);

  useEffect(() => {
    if (!pickerFor) return undefined;
    function onPointer(event) {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-elryan-picker]")) return;
      pickerRef.current = "";
      setPickerFor("");
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [pickerFor]);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

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
    pickerRef.current = "";
    setPickerFor("");
  }

  function loadLeafAttributes(collectionId, category) {
    const categoryId = String(category?.categoryId ?? category?.id ?? "").trim();
    const generation = ++compatSeq.current;
    compatRequest.current = { generation, categoryId };
    if (!isElryanConfirmedLeaf(category) || !categoryId) {
      setCompat(null);
      return;
    }
    setCompat({
      forId: String(collectionId || ""),
      categoryId,
      generation,
      loading: true,
      data: null,
    });
    api
      .elryanCategoryAttributeCompatibility(categoryId)
      .then((data) => {
        const active = compatRequest.current;
        if (
          !acceptElryanAttributeResponse({
            generation,
            categoryId,
            activeGeneration: active.generation,
            activeCategoryId: active.categoryId,
          })
        ) {
          return;
        }
        setCompat({
          forId: String(collectionId || ""),
          categoryId,
          generation,
          loading: false,
          data,
        });
      })
      .catch((err) => {
        if (generation !== compatSeq.current) return;
        setCompat({
          forId: String(collectionId || ""),
          categoryId,
          generation,
          loading: false,
          data: { blockers: [err.message] },
        });
      });
  }

  async function runManualSearch(offset = 0, forId = pickerFor, term = manualQ, parentId = "") {
    const owner = String(forId || "");
    if (!owner) return;
    const seq = ++manualSeq.current;
    const needle = String(term || "").trim();
    const parent = needle ? "" : String(parentId || "").trim();
    setManualBusy(true);
    setManualError("");
    setManualScope(needle ? "search" : parent && parent !== "0" ? "children" : "roots");
    if (manualFor !== owner) {
      setManualResult(null);
      setManualOffset(0);
    }
    setManualFor(owner);
    try {
      const data = await api.elryanMappingSnapshotSearch(
        elryanCategorySelectorQuery({
          q: needle,
          offset,
          parentId: parent,
          limit: 25,
        })
      );
      if (seq !== manualSeq.current) return;
      setManualResult(data);
      setManualOffset(data.offset ?? offset);
      setManualScope(data.scope || (needle ? "search" : parent ? "children" : "roots"));
      setManualFor(owner);
    } catch (err) {
      if (seq !== manualSeq.current) return;
      setManualResult(null);
      setManualError(err.message || "");
    } finally {
      if (seq === manualSeq.current) setManualBusy(false);
    }
  }

  function openPicker(row) {
    const id = String(row.brownCollectionId || "");
    if (!id) return;
    setCursorId(id);
    if (pickerRef.current === id) return;
    pickerRef.current = id;
    clearTimeout(searchTimer.current);
    setPickerFor(id);
    setManualQ("");
    setBrowseParentId("");
    setBrowseTrail([]);
    runManualSearch(0, id, "", "");
  }

  function queueLeafSearch(id, term) {
    pickerRef.current = id;
    setManualQ(term);
    setPickerFor(id);
    const needle = String(term || "").trim();
    if (!needle) {
      setBrowseParentId("");
      setBrowseTrail([]);
    }
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      runManualSearch(0, id, term, "");
    }, 200);
  }

  function browseAllCategories(id) {
    clearTimeout(searchTimer.current);
    setManualQ("");
    setBrowseParentId("");
    setBrowseTrail([]);
    pickerRef.current = id;
    setPickerFor(id);
    runManualSearch(0, id, "", "");
  }

  function expandCategory(id, hit) {
    const parentId = String(hit?.categoryId || "").trim();
    if (!parentId) return;
    clearTimeout(searchTimer.current);
    setManualQ("");
    setBrowseParentId(parentId);
    setBrowseTrail((trail) => [...trail, { categoryId: parentId, categoryName: hit.categoryName || "", hierarchy: hit.hierarchy || "" }]);
    pickerRef.current = id;
    setPickerFor(id);
    runManualSearch(0, id, "", parentId);
  }

  function browseBack(id) {
    clearTimeout(searchTimer.current);
    const next = browseTrail.slice(0, -1);
    const parentId = next.length ? String(next[next.length - 1].categoryId || "") : "";
    setBrowseTrail(next);
    setBrowseParentId(parentId);
    setManualQ("");
    pickerRef.current = id;
    setPickerFor(id);
    runManualSearch(0, id, "", parentId);
  }

  function inspectAttributes(collectionId, category) {
    loadLeafAttributes(collectionId, category);
  }

  async function buildReview(collectionId) {
    const current = cardDraft(draftsRef.current, collectionId);
    if (!canReviewElryanMapping(collectionId, current.pickedCategoryId)) {
      updateDraft(collectionId, (prev) => ({
        ...prev,
        error: t.elryanSelectCollectionAndCategory || "Select a collection and an Elryan category.",
      }));
      return null;
    }
    setReviewBusyId(collectionId);
    try {
      const data = await api.elryanMappingPreviewSave({
        brownCollectionId: collectionId,
        categoryId: current.pickedCategoryId,
        includeAttributes: false,
      });
      setDrafts((prev) => {
        const latest = cardDraft(prev, collectionId);
        if (!isElryanCategoryPicked(latest.pickedCategoryId, current.pickedCategoryId)) return prev;
        return {
          ...prev,
          [collectionId]: { ...latest, review: data, overwriteAck: false, error: "" },
        };
      });
      if (
        data.attributes &&
        acceptElryanAttributeResponse({
          generation: compatRequest.current.generation,
          categoryId: current.pickedCategoryId,
          activeGeneration: compatRequest.current.generation,
          activeCategoryId: compatRequest.current.categoryId,
        })
      ) {
        setCompat({
          forId: collectionId,
          categoryId: String(current.pickedCategoryId),
          generation: compatRequest.current.generation,
          loading: false,
          data: data.attributes,
        });
      }
      return data;
    } catch (err) {
      updateDraft(collectionId, (prev) => ({ ...prev, review: null, error: err.message }));
      return null;
    } finally {
      setReviewBusyId("");
    }
  }

  async function saveMapping(collectionId) {
    const current = cardDraft(draftsRef.current, collectionId);
    if (!isElryanConfirmedLeaf(current.pickedSnapshot)) {
      updateDraft(collectionId, (prev) => ({
        ...prev,
        error: t.elryanSelectCandidate || "Select category",
      }));
      return;
    }
    setSaveBusyId(collectionId);
    try {
      const review = await buildReview(collectionId);
      const latest = cardDraft(draftsRef.current, collectionId);
      if (!review || !isElryanCategoryPicked(latest.pickedCategoryId, current.pickedCategoryId)) return;
      const decision = buildElryanMappingSaveBody({
        brownCollectionId: collectionId,
        categoryId: latest.pickedCategoryId,
        review,
        overwriteAck: review.requiresOverwriteConfirmation === true,
        source: latest.pickSource,
      });
      if (!decision.allowed) {
        updateDraft(collectionId, (prev) => ({
          ...prev,
          error:
            decision.reason === "blocked"
              ? (review.blockers || []).join(" ") || t.elryanSelectCandidate || "Select category"
              : decision.reason === "overwrite_required"
                ? t.elryanOverwriteRequired || "Confirm overwrite of the existing mapping first."
                : t.elryanSelectCollectionAndCategory || "Select a collection and an Elryan category.",
        }));
        return;
      }
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
      pickerRef.current = "";
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

  function goToPage(next) {
    if (payload?.totalMatchingExact === false) {
      if (next < historyIndex + 1) goPrev();
      else goNext();
      return;
    }
    const offset = (Math.max(1, next) - 1) * pageSizeRef.current;
    loadCollections({ offset, history: [offset], resetDrafts: false });
  }

  function focusCollection(id, row) {
    const nextId = String(id || "");
    if (!nextId) return;
    openPicker(row || { brownCollectionId: nextId });
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
        {payload?.environment ? (
          <p className="mt-3 text-sm font-semibold text-brown">
            {payload.environment === "production" ? t.elryanValueProductionBanner : t.elryanValueStagingBanner}
          </p>
        ) : null}
        <p className="mt-3 text-sm text-brown/60">
          {t.statTotalCollections}: {showStat(counts.collections)} · {t.elryanStatMapped || t.elryanFilterMapped}:{" "}
          {showStat(counts.mapped)} · {t.elryanStatUnmapped || t.elryanFilterUnmapped}:{" "}
          {unmapped == null ? "—" : formatCount(unmapped)}
        </p>

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

        <div className="mt-5 space-y-3">
          {rows.map((row) => {
            const id = row.brownCollectionId;
            const draft = cardDraft(drafts, id);
            const mapped = Boolean(row.existingMapping?.configured);
            const taxonomy = brownStoreTaxonomyPath(row, lang, " > ");
            const open = pickerFor === id;
            const hits = searchHitsForCollection({
              manualFor,
              collectionId: id,
              categories: manualResult?.categories,
            });
            const savedValues = row.existingMapping?.values || {};
            const savedId = String(savedValues.categoryId || "");
            const selectedId = String(draft.pickedCategoryId || savedId);
            const selectedLabel = draft.pickedCategoryId
              ? elryanChoiceLabel(draft.pickedSnapshot)
              : elryanChoiceLabel({
                  hierarchy: savedValues.categoryHierarchy,
                  categoryName: savedValues.categoryName,
                });
            const rowState = elryanCategoryRowStatus({
              savedId,
              selectedId,
              error: draft.error,
            });
            const chosen = resolveDisplayedElryanCategory({
              pickedCategoryId: selectedId,
              snapshot: draft.pickedSnapshot || {
                categoryId: savedId,
                categoryName: savedValues.categoryName,
                hierarchy: savedValues.categoryHierarchy,
              },
              candidates: row.candidates || [],
              manualCategories: hits,
            });
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
            const cardCompat =
              compat?.forId === id && String(compat.categoryId || "") === String(draft.pickedCategoryId || "")
                ? compat
                : null;
            const saving = saveBusyId === id;

            return (
              <article
                key={id}
                id={`elryan-collection-${id}`}
                data-elryan-collection-card={id}
                data-product-count={row.productCount}
                data-mapping-status={mapped ? "mapped" : "unmapped"}
                className="rounded-2xl bg-cream px-3 py-3 sm:px-4"
              >
                <div className="grid items-center gap-3 lg:grid-cols-[minmax(0,1.05fr)_minmax(14rem,1.2fr)_auto_auto]">
                  <div className="min-w-0">
                    <p className="mb-1 text-[11px] font-semibold tracking-wide text-brown/45 uppercase lg:sr-only">
                      {t.elryanBrownStoreLabel || "BrownStore"}
                    </p>
                    <p className="break-words text-sm font-semibold text-brown" dir="auto">
                      {taxonomy}
                    </p>
                  </div>
                  <ElryanLeafSelect
                    id={id}
                    open={open}
                    query={manualQ}
                    busy={manualBusy && manualFor === id}
                    hits={open ? hits : []}
                    searchError={manualFor === id ? manualError : ""}
                    scope={manualFor === id ? manualScope : "roots"}
                    canGoBack={manualFor === id && browseTrail.length > 0}
                    selectedLabel={selectedLabel}
                    disabled={saving}
                    t={t}
                    onOpen={() => openPicker(row)}
                    onQuery={(value) => queueLeafSearch(id, value)}
                    onSelect={(hit) => pickCategory(id, hit, "manual")}
                    onExpand={(hit) => expandCategory(id, hit)}
                    onBrowseAll={() => browseAllCategories(id)}
                    onBack={() => browseBack(id)}
                    pageLabel={
                      manualResult && manualFor === id
                        ? `${manualResult.offset + 1}–${manualResult.offset + (manualResult.categories?.length || 0)}`
                        : ""
                    }
                    prevDisabled={manualBusy || manualFor !== id || !manualPrev.moved}
                    nextDisabled={manualBusy || manualFor !== id || !manualNext.moved}
                    onPrev={() => runManualSearch(manualPrev.offset, id, manualQ, browseParentId)}
                    onNext={() => runManualSearch(manualNext.offset, id, manualQ, browseParentId)}
                  />
                  <button
                    type="button"
                    data-elryan-confirm-save={id}
                    className={BUTTON}
                    disabled={
                      saving ||
                      selectedId === savedId ||
                      !isElryanConfirmedLeaf(draft.pickedSnapshot) ||
                      (draft.review && !draft.review.canSave)
                    }
                    onClick={() => saveMapping(id)}
                  >
                    {saving ? t.elryanCategorySaving || "Saving..." : t.elryanValueSave || "Save"}
                  </button>
                  <div className="min-w-[8.5rem]">
                    {saving ? (
                      <span className="text-xs font-semibold text-brown/60">{t.elryanCategorySaving || "Saving..."}</span>
                    ) : null}
                    {!saving && rowState === "confirmed" ? (
                      <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
                        {t.elryanValueConfirmed}
                      </span>
                    ) : null}
                    {!saving && rowState === "unsaved" ? (
                      <span className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">
                        {t.elryanValueUnsaved}
                      </span>
                    ) : null}
                  </div>
                </div>
                {draft.error ? (
                  <p className="mt-2 text-sm text-red-700" role="alert">
                    {draft.error}
                  </p>
                ) : null}
                <details className="mt-2 text-xs text-brown/70">
                  <summary className="cursor-pointer font-semibold text-brown/70">
                    {t.elryanAdvancedDetails || "Advanced details"}
                  </summary>
                  <div className="mt-2 space-y-2 rounded-xl bg-white p-3 ring-1 ring-brown/5">
                    <p dir="ltr">
                      {t.elryanCategoryIdLabel || "ID"} {id}
                      {" · "}
                      {formatCount(row.productCount)} {t.products}
                    </p>
                    {chosen?.categoryId ? (
                      <p dir="ltr">
                        {t.elryanCurrentMapping}: {chosen.categoryName || selectedLabel || "—"}
                        {" · "}
                        {t.elryanCategoryIdLabel || "ID"} {chosen.categoryId}
                        {chosen.hierarchy ? ` · ${chosen.hierarchy}` : ""}
                        {chosen.confidence ? ` · ${chosen.confidence}` : ""}
                        {chosen.attributeSetId != null ? ` · ${t.elryanAttributeSetLabel} ${chosen.attributeSetId}` : ""}
                      </p>
                    ) : null}
                    {savedId && selectedId !== savedId ? <p>{t.elryanOverwriteConfirm}</p> : null}
                    <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                      {t.elryanSuggestionsTitle || "Suggested categories"}
                    </p>
                    <ul className="space-y-1">
                      {(row.candidates || []).map((candidate) => (
                        <li key={String(candidate.categoryId)}>
                          <button
                            type="button"
                            data-elryan-suggestion={String(candidate.categoryId)}
                            data-elryan-suggestion-for={id}
                            disabled={!isElryanConfirmedLeaf(candidate)}
                            className="w-full rounded-xl px-2 py-1.5 text-start hover:bg-cream disabled:opacity-40"
                            onClick={() => {
                              if (!isElryanConfirmedLeaf(candidate)) return;
                              pickCategory(id, candidate, "smart");
                            }}
                          >
                            <span className="font-semibold text-brown">{elryanChoiceLabel(candidate) || "—"}</span>
                            <span className="mt-0.5 block text-brown/50" dir="ltr">
                              {hitMeta(t, candidate)}
                            </span>
                          </button>
                        </li>
                      ))}
                      {!row.candidates?.length ? <li className="text-brown/45">{t.elryanNoSuggestions}</li> : null}
                    </ul>
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
                      onClick={() => inspectAttributes(id, draft.pickedSnapshot)}
                    >
                      {t.elryanInspectAttributes}
                    </button>
                    {cardCompat ? (
                      <div data-elryan-attributes={id}>
                        <p className="font-semibold text-brown">{t.elryanAttributeCompatibility}</p>
                        {cardCompat.loading ? <p className="mt-1">{t.loading}</p> : null}
                        <p className="mt-1" dir="ltr">
                          {t.elryanAttributeSetLabel}: {cardCompat.data?.attributeSetId || "—"}{" "}
                          {cardCompat.data?.attributeSetName || ""}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </details>
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
          <div className="mt-4 space-y-3">
            <ProgressLine t={t} payload={payload} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <ElryanMappingPager
                t={t}
                page={
                  payload.totalMatchingExact === false
                    ? historyIndex + 1
                    : Math.floor((payload.offset || 0) / (Number(payload.limit) || pageSize)) + 1
                }
                pages={
                  payload.totalMatchingExact === false
                    ? 1
                    : Math.max(1, Math.ceil((payload.totalMatching || 0) / (Number(payload.limit) || pageSize)))
                }
                total={payload.totalMatchingExact === false ? payload.counts?.filtered || 0 : payload.totalMatching || 0}
                limit={pageSize}
                busy={busy}
                numbered={payload.totalMatchingExact !== false}
                hasPrevious={payload.totalMatchingExact === false ? canPrev : undefined}
                hasNext={payload.totalMatchingExact === false ? Boolean(payload.hasMore) : undefined}
                onPage={goToPage}
                onLimit={setPageSize}
              />
              <button type="button" className={BUTTON_GHOST} disabled={busy} onClick={goNextUnmapped}>
                {t.elryanNextUnmapped || "Next unmapped"}
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
        {payload?.catalog ? (
          <p className="mt-2 text-[11px] text-brown/45">
            {t.elryanCatalogStatus}: {elryanCatalogEnvironmentLabel(payload.catalog) || payload.environment} ·{" "}
            {payload.catalog.status} · {payload.catalog.uniqueCount}
          </p>
        ) : null}
        {catalogOpen ? (
          <div className="mt-4">
            <ElryanCatalogBrowse t={t} embedded />
          </div>
        ) : null}
      </details>
    </div>
  );
}
