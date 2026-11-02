import { useEffect, useMemo, useState } from "react";
import { api } from "../../../api";

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
    .join(" → ");
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
  const [activeEnvironment, setActiveEnvironment] = useState("staging");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [exceptions, setExceptions] = useState([]);
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState({});

  async function loadCatalog() {
    const data = await api.elryanCollectionDimensions();
    setCatalog(data.collections || []);
    setActiveEnvironment(data.activeEnvironment || "staging");
    return data;
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
    loadCatalog().catch((err) => setError(err.message));
  }, []);

  const categories = useMemo(() => {
    const map = new Map();
    for (const row of catalog) {
      if (!row.brownCategoryId || map.has(row.brownCategoryId)) continue;
      map.set(row.brownCategoryId, row.brownCategoryName);
    }
    return [...map.entries()];
  }, [catalog]);

  const subcategories = useMemo(() => {
    const map = new Map();
    for (const row of catalog) {
      if (categoryId && row.brownCategoryId !== categoryId) continue;
      if (!row.brownSubCategoryId || map.has(row.brownSubCategoryId)) continue;
      map.set(row.brownSubCategoryId, row.brownSubCategoryName);
    }
    return [...map.entries()];
  }, [catalog, categoryId]);

  const collections = useMemo(() => {
    const query = search.trim().toLowerCase();
    return catalog.filter((row) => {
      if (categoryId && row.brownCategoryId !== categoryId) return false;
      if (subCategoryId && row.brownSubCategoryId !== subCategoryId) return false;
      if (!query) return true;
      const haystack = `${taxonomyPath(row, lang)} ${row.brownCollectionId}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [catalog, categoryId, subCategoryId, search, lang]);

  const selected = collections.find((row) => row.brownCollectionId === collectionId) || catalog.find((row) => row.brownCollectionId === collectionId) || null;
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
            {categories.map(([id, name]) => (
              <option key={id} value={id}>{label(name, lang)}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold text-brown">
          {t.elryanDimSubcategory}
          <select className={`${CONTROL} mt-2`} value={subCategoryId} onChange={(event) => setSubCategoryId(event.target.value)}>
            <option value="">{t.elryanDimAll}</option>
            {subcategories.map(([id, name]) => (
              <option key={id} value={id}>{label(name, lang)}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold text-brown">
          {t.elryanDimCollection}
          <select className={`${CONTROL} mt-2`} value={collectionId} onChange={(event) => chooseCollection(event.target.value)}>
            <option value="">{t.elryanDimNoCollection}</option>
            {collections.map((row) => (
              <option key={row.brownCollectionId} value={row.brownCollectionId}>
                {taxonomyPath(row, lang)} · {row.brownCollectionId}
              </option>
            ))}
          </select>
        </label>
      </div>

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
