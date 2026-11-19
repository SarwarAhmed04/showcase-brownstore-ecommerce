import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import ElryanMappingPager from "./ElryanMappingPager";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON = "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST = "rounded-full border border-brown/15 bg-white px-4 py-2.5 text-sm font-semibold text-brown disabled:opacity-50";

const EMPTY_FORM = {
  height: "",
  width: "",
  depth: "",
  applyMode: "SUGGEST_REVIEW",
  enabled: false,
  confirm: false,
  confirmAutoApply: false,
};

function label(name, lang) {
  if (!name) return "";
  if (typeof name === "string") return name;
  return name[lang] || name.en || name.ku || name.ar || "";
}

function taxonomyPath(row, lang) {
  return [label(row?.brownCategoryName, lang), label(row?.brownSubCategoryName, lang), label(row?.brownCollectionName, lang)]
    .filter(Boolean)
    .join(" > ");
}

function Stat({ label: statLabel, value }) {
  return (
    <div className="rounded-2xl bg-cream px-4 py-3">
      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{statLabel}</p>
      <p className="mt-1 font-display text-2xl tabular-nums text-brown">{value ?? 0}</p>
    </div>
  );
}

export default function ElryanDimensionsMapping({ t, lang = "en" }) {
  const [catalog, setCatalog] = useState([]);
  const [facets, setFacets] = useState({ categories: [], subcategories: [] });
  const [activeEnvironment, setActiveEnvironment] = useState("staging");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [selectedRow, setSelectedRow] = useState(null);
  const [tablePage, setTablePage] = useState(1);
  const [tableLimit, setTableLimit] = useState(25);
  const [tableTotal, setTableTotal] = useState(0);
  const [tablePages, setTablePages] = useState(1);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [exceptions, setExceptions] = useState([]);
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [collectionDrafts, setCollectionDrafts] = useState({});
  const [rowFeedback, setRowFeedback] = useState({});
  const draftsRef = useRef(collectionDrafts);
  draftsRef.current = collectionDrafts;
  const tableRef = useRef({ page: 1, limit: 25, q: "", categoryId: "", subCategoryId: "" });
  const queryKey = useRef(null);
  const environmentRef = useRef("");
  const catalogTicket = useRef(0);
  const collectionIdRef = useRef("");
  tableRef.current = {
    page: tablePage,
    limit: tableLimit,
    q: appliedSearch,
    categoryId,
    subCategoryId,
  };
  collectionIdRef.current = collectionId;

  async function loadCatalog() {
    const query = tableRef.current;
    const ticket = ++catalogTicket.current;
    const data = await api.elryanCollectionDimensions({
      q: query.q,
      categoryId: query.categoryId,
      subCategoryId: query.subCategoryId,
      page: query.page,
      limit: query.limit,
    });
    if (ticket !== catalogTicket.current) return data;
    const nextEnvironment = data.environment || data.activeEnvironment || "staging";
    if (environmentRef.current && environmentRef.current !== nextEnvironment && query.page !== 1) {
      environmentRef.current = nextEnvironment;
      setActiveEnvironment(nextEnvironment);
      setTablePage(1);
      return data;
    }
    environmentRef.current = nextEnvironment;
    const rows = data.collections || [];
    setCatalog(rows);
    setFacets(data.facets || { categories: [], subcategories: [] });
    setTableTotal(Number(data.total) || 0);
    setTablePages(Number(data.pages) || 1);
    if (Number(data.page) && Number(data.page) !== query.page) setTablePage(Number(data.page));
    setActiveEnvironment(nextEnvironment);
    setSelectedRow((current) => {
      const id = collectionIdRef.current;
      if (!id) return current;
      return rows.find((row) => row.brownCollectionId === id) || current;
    });
    setCollectionDrafts((current) => {
      const next = { ...current };
      for (const row of rows) {
        if (next[row.brownCollectionId]) continue;
        next[row.brownCollectionId] = {
          width: row.rule?.width ?? "",
          height: row.rule?.height ?? "",
          depth: row.rule?.depth ?? "",
        };
      }
      return next;
    });
    return data;
  }

  function dimensionKey(draft) {
    return [draft?.width ?? "", draft?.height ?? "", draft?.depth ?? ""].join("|");
  }

  function changeCollectionDraft(id, draft, patch) {
    setCollectionDrafts((current) => ({
      ...current,
      [id]: { ...draft, ...patch },
    }));
    setRowFeedback((current) => {
      const row = current[id];
      if (!row || row.status === "saving") return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function saveCollection(id, draft) {
    const savedKey = dimensionKey(draft);
    setBusy(true);
    setError("");
    setMessage("");
    setRowFeedback((current) => ({ ...current, [id]: { status: "saving" } }));
    try {
      await api.saveElryanCollectionDimension({
        environment: activeEnvironment,
        brownCollectionId: id,
        width: Number(draft.width),
        height: Number(draft.height),
        depth: Number(draft.depth),
        unit: "cm",
        applyMode: "AUTO_APPLY",
        enabled: true,
        verifiedForCollection: true,
        confirm: true,
        confirmAutoApply: true,
      });
      const unchanged = dimensionKey(draftsRef.current[id]) === savedKey;
      setRowFeedback((current) => {
        const next = { ...current };
        if (unchanged) next[id] = { status: "confirmed" };
        else if (next[id]?.status === "saving") delete next[id];
        return next;
      });
      setMessage(t.elryanDimSaved);
      await loadCatalog();
      if (collectionId === id) await loadDetail(id, 1, reason);
    } catch (err) {
      setRowFeedback((current) => ({ ...current, [id]: { status: "error", message: err.message } }));
    } finally {
      setBusy(false);
    }
  }

  async function loadDetail(id, nextPage = 1, nextReason = reason) {
    if (!id) {
      setDetail(null);
      setExceptions([]);
      return;
    }
    const [nextDetail, nextExceptions] = await Promise.all([
      api.elryanCollectionDimensionDetail(id),
      api.elryanCollectionDimensionExceptions({
        brownCollectionId: id,
        reason: nextReason,
        page: nextPage,
        limit: 25,
      }),
    ]);
    setDetail(nextDetail);
    setExceptions(nextExceptions.rows || []);
    const rule = nextDetail.rule;
    setForm({
      height: rule?.height ?? "",
      width: rule?.width ?? "",
      depth: rule?.depth ?? "",
      applyMode: rule?.applyMode || "SUGGEST_REVIEW",
      enabled: rule?.enabled === true,
      confirm: false,
      confirmAutoApply: false,
    });
  }

  useEffect(() => {
    const handle = setTimeout(() => setAppliedSearch(search.trim()), 250);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    const key = `${appliedSearch}\0${categoryId}\0${subCategoryId}\0${tableLimit}`;
    const reset = queryKey.current !== key;
    queryKey.current = key;
    const nextPage = reset ? 1 : tablePage;
    if (reset && tablePage !== 1) {
      setTablePage(1);
      return;
    }
    tableRef.current = {
      page: nextPage,
      limit: tableLimit,
      q: appliedSearch,
      categoryId,
      subCategoryId,
    };
    loadCatalog().catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedSearch, categoryId, subCategoryId, tablePage, tableLimit]);

  const categories = facets.categories || [];
  const subcategories = (facets.subcategories || []).filter((row) => !categoryId || row.categoryId === categoryId);
  const collections = catalog;

  const selected = collections.find((row) => row.brownCollectionId === collectionId) || (selectedRow?.brownCollectionId === collectionId ? selectedRow : null);
  const collectionOptions = selected && !collections.some((row) => row.brownCollectionId === selected.brownCollectionId)
    ? [selected, ...collections]
    : collections;
  const counts = detail?.counts || {};
  const auto = form.applyMode === "AUTO_APPLY";
  const canSave =
    !busy &&
    collectionId &&
    form.confirm &&
    Number(form.height) > 0 &&
    Number(form.width) > 0 &&
    Number(form.depth) > 0 &&
    (!auto || form.confirmAutoApply);

  async function chooseCollection(id) {
    setCollectionId(id);
    setSelectedRow(collections.find((row) => row.brownCollectionId === id) || null);
    setPage(1);
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await loadDetail(id, 1, reason);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onSave(event) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.saveElryanCollectionDimension({
        environment: "staging",
        brownCollectionId: collectionId,
        height: Number(form.height),
        width: Number(form.width),
        depth: Number(form.depth),
        unit: "cm",
        applyMode: form.applyMode,
        enabled: form.applyMode !== "DISABLED" && form.enabled,
        verifiedForCollection: auto,
        confirm: true,
        confirmAutoApply: auto ? true : false,
      });
      setMessage(t.elryanDimSaved);
      await loadCatalog();
      await loadDetail(collectionId, 1, reason);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeExceptions(nextReason, nextPage) {
    setReason(nextReason);
    setPage(nextPage);
    if (!collectionId) return;
    setBusy(true);
    setError("");
    try {
      const data = await api.elryanCollectionDimensionExceptions({
        brownCollectionId: collectionId,
        reason: nextReason,
        page: nextPage,
        limit: 25,
      });
      setExceptions(data.rows || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function draftFor(row) {
    return drafts[row.productId] || {
      height: row.height || row.suggestion?.height || "",
      width: row.width || row.suggestion?.width || "",
      depth: row.depth || row.suggestion?.depth || "",
      axes: false,
      confirm: false,
    };
  }

  async function saveProduct(row) {
    const draft = draftFor(row);
    if (!draft.confirm || !draft.axes) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.elryanStagingDimensions({
        productId: row.productId,
        sku: row.sku,
        unit: "cm",
        height: Number(draft.height),
        width: Number(draft.width),
        depth: Number(draft.depth),
        axesConfirmed: true,
        confirm: true,
      });
      setMessage(t.elryanDimSaved);
      await loadDetail(collectionId, page, reason);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setExcluded(row, excluded) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.elryanDimensionExclusion({
        environment: "staging",
        productId: row.productId,
        sku: row.sku,
        excluded,
        confirm: true,
      });
      await loadDetail(collectionId, page, reason);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="font-display text-2xl text-brown">{t.elryanDimensionsMappingTitle}</h2>
        <p className="mt-2 max-w-3xl text-sm text-brown/70">{t.elryanDimensionsMappingHint}</p>
        <p className="mt-2 text-sm font-semibold text-brown">
          {activeEnvironment === "production" ? t.elryanDimProductionBanner : t.elryanDimStagingBanner}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="block text-sm font-semibold text-brown">
          {t.elryanDimSearch}
          <input className={`${CONTROL} mt-2`} value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label className="block text-sm font-semibold text-brown">
          {t.elryanDimCategory}
          <select
            className={`${CONTROL} mt-2`}
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
              setSubCategoryId("");
            }}
          >
            <option value="">{t.elryanDimAll}</option>
            {categories.map((row) => (
              <option key={row.id} value={row.id}>{label(row.name, lang)}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold text-brown">
          {t.elryanDimSubcategory}
          <select className={`${CONTROL} mt-2`} value={subCategoryId} onChange={(event) => setSubCategoryId(event.target.value)}>
            <option value="">{t.elryanDimAll}</option>
            {subcategories.map((row) => (
              <option key={row.id} value={row.id}>{label(row.name, lang)}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold text-brown">
          {t.elryanDimCollection}
          <select className={`${CONTROL} mt-2`} value={collectionId} onChange={(event) => chooseCollection(event.target.value)}>
            <option value="">{t.elryanDimNoCollection}</option>
            {collectionOptions.map((row) => (
              <option key={row.brownCollectionId} value={row.brownCollectionId}>
                {taxonomyPath(row, lang)} · {row.brownCollectionId}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-3">
        {collections.map((row) => {
          const draft = collectionDrafts[row.brownCollectionId] || {
            width: row.rule?.width ?? "",
            height: row.rule?.height ?? "",
            depth: row.rule?.depth ?? "",
          };
          const feedback = rowFeedback[row.brownCollectionId] || { status: "" };
          return (
            <article
              key={row.brownCollectionId}
              className="rounded-3xl bg-white p-4 ring-1 ring-brown/10"
              data-brown-collection-id={row.brownCollectionId}
              data-dimension-status={feedback.status || "idle"}
            >
              <p className="text-sm font-semibold text-brown">{taxonomyPath(row, lang)}</p>
              <p className="mt-1 text-xs text-brown/50">
                {row.brownCollectionId} · {t.elryanDimProductCount}: {row.productCount}
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
                <label className="text-sm font-semibold text-brown">
                  {t.elryanDimWidth}
                  <input
                    className={`${CONTROL} mt-2`}
                    inputMode="decimal"
                    value={draft.width}
                    onChange={(event) => changeCollectionDraft(row.brownCollectionId, draft, { width: event.target.value })}
                  />
                </label>
                <label className="text-sm font-semibold text-brown">
                  {t.elryanDimHeight}
                  <input
                    className={`${CONTROL} mt-2`}
                    inputMode="decimal"
                    value={draft.height}
                    onChange={(event) => changeCollectionDraft(row.brownCollectionId, draft, { height: event.target.value })}
                  />
                </label>
                <label className="text-sm font-semibold text-brown">
                  {t.elryanDimDepth}
                  <input
                    className={`${CONTROL} mt-2`}
                    inputMode="decimal"
                    value={draft.depth}
                    onChange={(event) => changeCollectionDraft(row.brownCollectionId, draft, { depth: event.target.value })}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy}
                    onClick={() => saveCollection(row.brownCollectionId, draft)}
                  >
                    {t.elryanDimSave || "Save"}
                  </button>
                  {feedback.status === "saving" ? (
                    <span className="text-sm font-semibold text-brown/70">{t.elryanDimSaving}</span>
                  ) : null}
                  {feedback.status === "confirmed" ? (
                    <span className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
                      {t.elryanValueConfirmed}
                    </span>
                  ) : null}
                </div>
              </div>
              {feedback.status === "error" ? (
                <p className="mt-3 text-sm font-semibold text-red-700" role="alert">{feedback.message}</p>
              ) : null}
            </article>
          );
        })}
      </div>

      <ElryanMappingPager
        t={t}
        page={tablePage}
        pages={tablePages}
        total={tableTotal}
        limit={tableLimit}
        onPage={setTablePage}
        onLimit={setTableLimit}
      />

      {selected ? (
        <div className="rounded-3xl bg-cream/70 px-4 py-4 text-sm text-brown">
          <p><span className="text-brown/50">{t.elryanDimPath}: </span>{taxonomyPath(selected, lang)}</p>
          <p className="mt-1"><span className="text-brown/50">{t.elryanDimCollectionId}: </span>{selected.brownCollectionId}</p>
          <p className="mt-1"><span className="text-brown/50">{t.elryanDimProductCount}: </span>{selected.productCount}</p>
          {selected.ambiguousHierarchy ? <p className="mt-2 text-brown/70">{t.elryanDimAmbiguousHierarchy}</p> : null}
          {!selected.rule ? <p className="mt-2 text-brown/70">{t.elryanDimEmptyRules}</p> : null}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label={t.elryanDimOverrideCount} value={counts.productOverride} />
        <Stat label={t.elryanDimInheritedCount} value={counts.collectionAuto} />
        <Stat label={t.elryanDimSuggestedCount} value={counts.suggested} />
        <Stat label={t.elryanDimMissingCount} value={counts.missing} />
        <Stat label={t.elryanDimInvalidCount} value={counts.invalid} />
      </div>

      <form onSubmit={onSave} className="space-y-4 rounded-3xl border border-brown/10 bg-white p-4">
        <h3 className="font-display text-xl text-brown">{t.elryanDimPreview}</h3>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm font-semibold text-brown">
            {t.elryanDimHeight}
            <input className={`${CONTROL} mt-2`} inputMode="decimal" value={form.height} onChange={(event) => setForm({ ...form, height: event.target.value })} />
          </label>
          <label className="text-sm font-semibold text-brown">
            {t.elryanDimWidth}
            <input className={`${CONTROL} mt-2`} inputMode="decimal" value={form.width} onChange={(event) => setForm({ ...form, width: event.target.value })} />
          </label>
          <label className="text-sm font-semibold text-brown">
            {t.elryanDimDepth}
            <input className={`${CONTROL} mt-2`} inputMode="decimal" value={form.depth} onChange={(event) => setForm({ ...form, depth: event.target.value })} />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm font-semibold text-brown">
            {t.elryanDimApplyMode}
            <select
              className={`${CONTROL} mt-2`}
              value={form.applyMode}
              onChange={(event) => setForm({
                ...form,
                applyMode: event.target.value,
                enabled: event.target.value === "DISABLED" ? false : form.enabled,
                confirmAutoApply: false,
              })}
            >
              <option value="AUTO_APPLY">{t.elryanDimModeAuto}</option>
              <option value="SUGGEST_REVIEW">{t.elryanDimModeSuggest}</option>
              <option value="DISABLED">{t.elryanDimModeDisabled}</option>
            </select>
          </label>
          <label className="mt-7 flex items-center gap-3 text-sm font-semibold text-brown">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={form.applyMode === "DISABLED"}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            {t.elryanDimEnabled}
          </label>
        </div>
        <div className="rounded-2xl bg-cream px-4 py-3 text-sm text-brown/80">
          <p>{taxonomyPath(detail || selected, lang) || "—"}</p>
          <p className="mt-1">{t.elryanDimCollectionId}: {collectionId || "—"}</p>
          <p className="mt-1">
            {form.height || "—"} cm × {form.width || "—"} cm × {form.depth || "—"} cm · {form.applyMode}
            {form.enabled ? ` · ${t.elryanDimEnabled}` : ""}
          </p>
        </div>
        {auto ? <p className="text-sm text-brown/80">{t.elryanDimAutoWarning}</p> : null}
        <label className="flex items-start gap-3 text-sm font-semibold text-brown">
          <input type="checkbox" checked={form.confirm} onChange={(event) => setForm({ ...form, confirm: event.target.checked })} />
          {t.elryanDimConfirm}
        </label>
        {auto ? (
          <label className="flex items-start gap-3 text-sm font-semibold text-brown">
            <input
              type="checkbox"
              checked={form.confirmAutoApply}
              onChange={(event) => setForm({ ...form, confirmAutoApply: event.target.checked })}
            />
            {t.elryanDimAutoConfirm}
          </label>
        ) : null}
        <button className={BUTTON} type="submit" disabled={!canSave}>{t.elryanDimSave}</button>
      </form>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-xl text-brown">{t.elryanDimExceptions}</h3>
          <select className={CONTROL} value={reason} onChange={(event) => changeExceptions(event.target.value, 1)}>
            <option value="">{t.elryanDimAll}</option>
            <option value="differs">{t.elryanDimDiffers}</option>
            <option value="missing">{t.elryanDimMissingCount}</option>
            <option value="disabled">{t.elryanDimModeDisabled}</option>
            <option value="ambiguous">{t.elryanDimAmbiguous}</option>
            <option value="invalid">{t.elryanDimInvalidCount}</option>
            <option value="excluded">{t.elryanDimExcluded}</option>
            <option value="suggested">{t.elryanDimSuggestedCount}</option>
          </select>
        </div>
        <p className="text-sm text-brown/60">
          {t.elryanDimDiffers}: {counts.differs ?? 0} · {t.elryanDimExcluded}: {counts.excluded ?? 0} · {t.elryanDimAmbiguous}: {counts.ambiguous ?? 0}
        </p>
        {exceptions.length ? (
          <ul className="space-y-3">
            {exceptions.map((row) => {
              const draft = draftFor(row);
              return (
                <li key={row.productId} className="rounded-3xl border border-brown/10 bg-white p-4 text-sm text-brown">
                  <p className="font-semibold">{label(row.name, lang) || row.sku}</p>
                  <p className="mt-1 text-brown/60">{t.elryanDimSku}: {row.sku} · {row.productId}</p>
                  <p className="mt-1">{t.elryanDimSource}: {row.source} · {t.elryanDimReason}: {row.exceptionKind}</p>
                  <div className="mt-3 grid gap-2 md:grid-cols-3">
                    <input className={CONTROL} inputMode="decimal" value={draft.height} placeholder={t.elryanDimHeight} onChange={(event) => setDrafts({ ...drafts, [row.productId]: { ...draft, height: event.target.value } })} />
                    <input className={CONTROL} inputMode="decimal" value={draft.width} placeholder={t.elryanDimWidth} onChange={(event) => setDrafts({ ...drafts, [row.productId]: { ...draft, width: event.target.value } })} />
                    <input className={CONTROL} inputMode="decimal" value={draft.depth} placeholder={t.elryanDimDepth} onChange={(event) => setDrafts({ ...drafts, [row.productId]: { ...draft, depth: event.target.value } })} />
                  </div>
                  <label className="mt-3 flex items-center gap-2 font-semibold">
                    <input type="checkbox" checked={draft.axes} onChange={(event) => setDrafts({ ...drafts, [row.productId]: { ...draft, axes: event.target.checked } })} />
                    {t.elryanDimAxes}
                  </label>
                  <label className="mt-2 flex items-center gap-2 font-semibold">
                    <input type="checkbox" checked={draft.confirm} onChange={(event) => setDrafts({ ...drafts, [row.productId]: { ...draft, confirm: event.target.checked } })} />
                    {t.elryanDimProductConfirm}
                  </label>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" className={BUTTON} disabled={busy || !draft.confirm || !draft.axes} onClick={() => saveProduct(row)}>
                      {t.elryanDimSaveProduct}
                    </button>
                    <button type="button" className={GHOST} disabled={busy} onClick={() => setExcluded(row, !row.excluded)}>
                      {row.excluded ? t.elryanDimInclude : t.elryanDimExclude}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-brown/55">{t.elryanDimNoExceptions}</p>
        )}
        <div className="flex gap-2">
          <button type="button" className={GHOST} disabled={busy || page <= 1} onClick={() => changeExceptions(reason, page - 1)}>←</button>
          <button type="button" className={GHOST} disabled={busy || exceptions.length < 25} onClick={() => changeExceptions(reason, page + 1)}>→</button>
        </div>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {message ? <p className="text-sm text-emerald-800">{message}</p> : null}
    </section>
  );
}
