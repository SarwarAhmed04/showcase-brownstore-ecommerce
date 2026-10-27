import { useEffect, useMemo, useState } from "react";
import {
  applyCategoryChange,
  applySubcategoryChange,
  categoryOptions,
  giniMappingStatus,
  subcategoryOptions,
  summarizeGiniStatuses,
} from "@gini-category-tree";
import { api } from "../../../api";
import { formatCount, StatusBadge } from "./platformUi";

function label(name, lang) {
  if (!name) return "";
  if (typeof name === "string") return name;
  return name[lang] || name.en || name.ku || name.ar || "";
}

function pathText(row, lang) {
  return [label(row.categoryName, lang), label(row.subCategoryName, lang), label(row.name, lang)]
    .filter(Boolean)
    .join(" → ");
}

const SCOPE_KEY = {
  category: "taxonomyScopeCategory",
  subcategory: "taxonomyScopeSubcategory",
  collection: "taxonomyScopeCollection",
};

const PAGE_SIZE = 20;
const STATUS_CLASS = {
  configured: "bg-emerald-50 text-emerald-800",
  missing: "bg-amber-50 text-amber-900",
  invalid: "bg-red-50 text-red-800",
  inactive: "bg-amber-50 text-amber-950",
};
const STATUS_LABEL = {
  configured: "giniConfigured",
  missing: "giniMissingMapping",
  invalid: "giniInvalidMapping",
  inactive: "giniInactiveMapping",
};

async function loadGiniCollections(partnerSlug) {
  const first = await api.categorySetup(partnerSlug, { page: 1, limit: 1000, status: "all" });
  const pages = Number(first.pagination?.pages) || 1;
  let rows = first.rows || [];
  for (let page = 2; page <= pages; page += 1) {
    const next = await api.categorySetup(partnerSlug, { page, limit: 1000, status: "all" });
    rows = rows.concat(next.rows || []);
  }
  return { ...first, rows };
}

function GiniCategorySetup({ partnerSlug, t, lang, onNotices, onOpenConnection }) {
  const [rows, setRows] = useState([]);
  const [categories, setCategories] = useState([]);
  const [treeReady, setTreeReady] = useState(false);
  const [connectionRequired, setConnectionRequired] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [notices, setNotices] = useState([]);
  const [noticeCount, setNoticeCount] = useState(0);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError("");
    Promise.all([
      loadGiniCollections(partnerSlug),
      api.giniCategories().then(
        (data) => ({ ok: true, data }),
        (err) => ({ ok: false, err })
      ),
    ])
      .then(([setup, live]) => {
        if (ignore) return;
        const loaded = setup.rows || [];
        setRows(loaded);
        const values = {};
        for (const row of loaded) values[row.id] = { ...(row.values || {}) };
        setDrafts(values);
        setNotices(setup.notices || []);
        setNoticeCount(Number(setup.noticeCount) || 0);
        onNotices?.(Number(setup.noticeCount) || 0);
        if (live.ok) {
          setCategories(Array.isArray(live.data.categories) ? live.data.categories : []);
          setTreeReady(true);
          setConnectionRequired(false);
          setCategoryError("");
        } else if (live.err?.code === "connection_required" || live.err?.status === 409) {
          setConnectionRequired(true);
          setTreeReady(false);
          setCategories([]);
        } else {
          setCategoryError(live.err?.message || t.giniCategoriesFailed);
          setTreeReady(false);
        }
      })
      .catch((err) => {
        if (!ignore) setError(err.message);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [partnerSlug, onNotices, t.giniCategoriesFailed]);

  const classified = useMemo(() => {
    if (!treeReady) return rows.map((row) => ({ ...row, mappingStatus: "" }));
    return rows.map((row) => ({ ...row, mappingStatus: giniMappingStatus(row.values, categories) }));
  }, [rows, categories, treeReady]);

  const counts = useMemo(
    () => summarizeGiniStatuses(classified.map((row) => row.mappingStatus).filter(Boolean), classified.length),
    [classified]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return classified.filter((row) => {
      if (status !== "all" && row.mappingStatus !== status) return false;
      if (!needle) return true;
      const saved = Object.values(row.values || {}).join(" ");
      return `${pathText(row, lang)} ${saved}`.toLowerCase().includes(needle);
    });
  }, [classified, query, status, lang]);

  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  async function refreshCategories() {
    setRefreshing(true);
    setMessage("");
    try {
      const next = await api.giniCategories({ refresh: true });
      setCategories(Array.isArray(next.categories) ? next.categories : []);
      setTreeReady(true);
      setConnectionRequired(false);
      setCategoryError("");
    } catch (err) {
      if (err?.code === "connection_required" || err?.status === 409) {
        setConnectionRequired(true);
        setTreeReady(false);
        setCategories([]);
        setStatus("all");
      } else {
        setCategoryError(err.message || t.giniCategoriesFailed);
      }
    } finally {
      setRefreshing(false);
    }
  }

  async function save(row) {
    const draft = drafts[row.id] || {};
    if (giniMappingStatus(draft, categories) !== "configured") return;
    setSaving(row.id);
    setError("");
    setMessage("");
    try {
      const result = await api.saveCategorySetup(partnerSlug, row.id, { values: draft });
      const values = result.setup?.values || draft;
      setRows((current) => current.map((item) => (item.id === row.id ? { ...item, values, configured: true } : item)));
      setDrafts((current) => ({ ...current, [row.id]: { ...values } }));
      onNotices?.(Number(result.setup?.noticeCount) || 0);
      setNoticeCount(Number(result.setup?.noticeCount) || 0);
      setMessage(t.mappingSaved);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving("");
    }
  }

  return (
    <div className="space-y-5">
      {noticeCount > 0 ? (
        <section className="rounded-3xl bg-amber-50 p-5 text-amber-950 ring-1 ring-amber-200">
          <p className="font-semibold">
            {String(t.taxonomyNoticeTitle || "").replace("{count}", formatCount(noticeCount))}
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {notices.map((notice) => (
              <li key={notice.id}>
                <span className="font-semibold">{t[SCOPE_KEY[notice.scope]] || notice.scope}</span>
                {" · "}
                {notice.path || notice.name}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {connectionRequired ? (
        <section className="rounded-3xl bg-amber-50 p-5 text-amber-950 ring-1 ring-amber-200">
          <p className="font-semibold">{t.giniConnectFirst}</p>
          <button
            type="button"
            onClick={onOpenConnection}
            className="mt-3 rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream"
          >
            {t.giniOpenConnection}
          </button>
        </section>
      ) : null}

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">{t.categoryMapping}</p>
            <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.giniMappingHint}</p>
          </div>
          {!connectionRequired ? (
            <button
              type="button"
              onClick={refreshCategories}
              disabled={refreshing}
              className="rounded-full bg-cream px-4 py-2 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50"
            >
              {refreshing ? t.loading : t.giniRefreshCategories}
            </button>
          ) : null}
        </div>

        {treeReady ? (
          <p className="mt-4 text-sm text-brown/60">
            {t.giniTotalCollections}: {formatCount(counts.total)} · {t.giniConfigured}: {formatCount(counts.configured)} ·{" "}
            {t.giniMissingMapping}: {formatCount(counts.missing)} · {t.giniInvalidMapping}: {formatCount(counts.invalid)} ·{" "}
            {t.giniInactiveMapping}: {formatCount(counts.inactive)}
          </p>
        ) : null}

        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setQuery(q.trim());
          }}
        >
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder={t.categorySearch}
            className="min-w-[12rem] flex-1 rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm text-brown"
          />
          <button type="submit" className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream">
            {t.categorySearch}
          </button>
        </form>

        {treeReady ? (
          <div className="mt-3 flex flex-wrap gap-1 rounded-[1.25rem] bg-cream p-1 sm:w-fit">
            {[
              ["all", t.filterAll],
              ["configured", t.giniConfigured],
              ["missing", t.giniMissingMapping],
              ["invalid", t.giniInvalidMapping],
              ["inactive", t.giniInactiveMapping],
            ].map(([id, text]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setStatus(id);
                  setPage(1);
                }}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  status === id ? "bg-white text-brown shadow-sm" : "text-brown/55"
                }`}
              >
                {text}
              </button>
            ))}
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        {categoryError ? <p className="mt-3 text-sm text-red-700">{categoryError}</p> : null}
        {message ? <p className="mt-3 text-sm text-emerald-800">{message}</p> : null}
        {loading ? <p className="mt-4 text-sm text-brown/45">{t.loading}</p> : null}

        <div className="mt-5 space-y-3">
          {pageRows.map((row) => {
            const draft = drafts[row.id] || {};
            const categoriesForRow = categoryOptions(categories, draft.categoryId);
            const subcategoriesForRow = subcategoryOptions(categories, draft.categoryId, draft.subcategoryId);
            const draftStatus = treeReady ? giniMappingStatus(draft, categories) : "";
            const canSave = draftStatus === "configured";
            const showInactiveWarning = row.mappingStatus === "inactive" || draftStatus === "inactive";
            return (
              <article key={row.id} className="rounded-2xl bg-cream p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-brown">{pathText(row, lang)}</p>
                    <p className="mt-1 text-xs text-brown/50">
                      {t.products}: {formatCount(row.productCount)}
                    </p>
                  </div>
                  {row.mappingStatus ? (
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_CLASS[row.mappingStatus] || ""}`}>
                      {t[STATUS_LABEL[row.mappingStatus]] || row.mappingStatus}
                    </span>
                  ) : null}
                </div>
                {showInactiveWarning ? (
                  <p className="mt-3 text-xs font-semibold text-amber-950">{t.giniInactiveOrInvalid}</p>
                ) : null}
                {treeReady ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs font-semibold text-brown/60">
                      {t.giniCategoryLabel}
                      <select
                        value={String(draft.categoryId || "")}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [row.id]: applyCategoryChange(categories, event.target.value),
                          }))
                        }
                        className="filter-select mt-1 w-full rounded-xl border border-brown/10 bg-white px-3 py-2 text-sm font-medium text-brown"
                      >
                        <option value="">{t.giniChooseCategory}</option>
                        {categoriesForRow.map((category) => (
                          <option key={String(category.id)} value={String(category.id)} disabled={Boolean(category.legacy)}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs font-semibold text-brown/60">
                      {t.giniSubcategoryLabel}
                      <select
                        value={String(draft.subcategoryId || "")}
                        disabled={!draft.categoryId}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [row.id]: applySubcategoryChange(categories, current[row.id], event.target.value),
                          }))
                        }
                        className="filter-select mt-1 w-full rounded-xl border border-brown/10 bg-white px-3 py-2 text-sm font-medium text-brown disabled:opacity-50"
                      >
                        <option value="">{t.giniChooseSubcategory}</option>
                        {subcategoriesForRow.map((subcategory) => (
                          <option key={String(subcategory.id)} value={String(subcategory.id)} disabled={Boolean(subcategory.legacy)}>
                            {subcategory.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
                {treeReady ? (
                  <button
                    type="button"
                    disabled={!canSave || saving === row.id}
                    onClick={() => save(row)}
                    className="mt-4 rounded-full bg-brown px-4 py-2 text-xs font-semibold text-cream disabled:opacity-50"
                  >
                    {row.mappingStatus === "configured" ? t.updateSetup : t.saveSetup}
                  </button>
                ) : null}
              </article>
            );
          })}
          {!loading && !pageRows.length ? <p className="text-sm text-brown/50">{t.noMappings}</p> : null}
        </div>
        {pages > 1 ? (
          <div className="mt-4 flex items-center justify-between text-sm">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="rounded-full px-3 py-1.5 font-semibold text-brown/60 disabled:opacity-40"
            >
              {t.pagePrevious}
            </button>
            <span className="text-brown/50">
              {safePage} / {pages}
            </span>
            <button
              type="button"
              disabled={safePage >= pages}
              onClick={() => setPage((current) => current + 1)}
              className="rounded-full px-3 py-1.5 font-semibold text-brown/60 disabled:opacity-40"
            >
              {t.pageNext}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ManualCategorySetup({ partnerSlug, t, lang, onNotices }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState("");

  useEffect(() => {
    let ignore = false;
    setError("");
    api
      .categorySetup(partnerSlug, { q: query, status, page, limit: 20 })
      .then((next) => {
        if (ignore) return;
        setData(next);
        const values = {};
        for (const row of next.rows || []) values[row.id] = { ...(row.values || {}) };
        setDrafts(values);
        onNotices?.(Number(next.noticeCount) || 0);
      })
      .catch((err) => {
        if (!ignore) setError(err.message);
      });
    return () => {
      ignore = true;
    };
  }, [partnerSlug, query, status, page, onNotices]);

  async function save(row) {
    setSaving(row.id);
    setError("");
    setMessage("");
    try {
      const result = await api.saveCategorySetup(partnerSlug, row.id, { values: drafts[row.id] || {} });
      setData((current) => {
        if (!current) return current;
        const configured = Boolean(result.setup?.configured);
        return {
          ...current,
          noticeCount: result.setup?.noticeCount ?? current.noticeCount,
          rows: current.rows.map((item) =>
            item.id === row.id
              ? {
                  ...item,
                  configured,
                  status: configured ? "configured" : "missing",
                  values: result.setup?.values || item.values,
                }
              : item
          ),
        };
      });
      onNotices?.(Number(result.setup?.noticeCount) || 0);
      setMessage(t.mappingSaved);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving("");
    }
  }

  const fields = data?.fields || [];
  const notices = data?.notices || [];
  const noticeCount = Number(data?.noticeCount) || 0;
  const counts = data?.counts || {};

  return (
    <div className="space-y-5">
      {noticeCount > 0 ? (
        <section className="rounded-3xl bg-amber-50 p-5 text-amber-950 ring-1 ring-amber-200">
          <p className="font-semibold">
            {String(t.taxonomyNoticeTitle || "").replace("{count}", formatCount(noticeCount))}
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {notices.map((notice) => (
              <li key={notice.id}>
                <span className="font-semibold">{t[SCOPE_KEY[notice.scope]] || notice.scope}</span>
                {" · "}
                {notice.path || notice.name}
                {notice.firstSeenAt ? (
                  <span className="text-amber-900/70">
                    {" · "}
                    {t.firstDetected} {new Date(notice.firstSeenAt).toLocaleString()}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">{t.categoryMapping}</p>
        <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.mappingHint}</p>
        {data && data.schemaReady === false ? (
          <p className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-950">{t.taxonomyFieldsPending}</p>
        ) : null}
        <p className="mt-4 text-sm text-brown/60">
          {t.statTotalCollections} {formatCount(counts.total)} · {t.mapped} {formatCount(counts.configured)} · {t.unmapped}{" "}
          {formatCount(counts.missing)}
        </p>
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setQuery(q.trim());
          }}
        >
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder={t.categorySearch}
            className="min-w-[12rem] flex-1 rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm"
          />
          <button type="submit" className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream">
            {t.categorySearch}
          </button>
        </form>
        <div className="mt-3 flex flex-wrap gap-1 rounded-[1.25rem] bg-cream p-1 sm:w-fit">
          {[
            ["all", t.filterAll],
            ["configured", t.mapped],
            ["missing", t.unmapped],
          ].map(([id, text]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setStatus(id);
                setPage(1);
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                status === id ? "bg-white text-brown shadow-sm" : "text-brown/55"
              }`}
            >
              {text}
            </button>
          ))}
        </div>
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        {message ? <p className="mt-3 text-sm text-emerald-800">{message}</p> : null}

        <div className="mt-5 space-y-3">
          {(data?.rows || []).map((row) => (
            <article key={row.id} className="rounded-2xl bg-cream p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-brown">{pathText(row, lang)}</p>
                  <p className="mt-1 text-xs text-brown/50">
                    {formatCount(row.productCount)} {t.products}
                  </p>
                </div>
                {row.status === "unavailable" ? null : (
                  <StatusBadge kind={row.configured ? "ready" : "missing_setup"} t={t}>
                    {row.configured ? t.mapped : t.unmapped}
                  </StatusBadge>
                )}
              </div>
              {fields.length ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {fields.map((field) => (
                    <label key={field.key} className="block text-xs font-semibold text-brown/60">
                      {field.label}
                      <input
                        dir="auto"
                        value={drafts[row.id]?.[field.key] || ""}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [row.id]: { ...(current[row.id] || {}), [field.key]: event.target.value },
                          }))
                        }
                        className="mt-1 w-full rounded-xl border border-brown/10 bg-white px-3 py-2 text-sm font-medium text-brown"
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              {fields.length ? (
                <button
                  type="button"
                  disabled={saving === row.id}
                  onClick={() => save(row)}
                  className="mt-4 rounded-full bg-brown px-4 py-2 text-xs font-semibold text-cream disabled:opacity-50"
                >
                  {row.configured ? t.updateSetup : t.saveSetup}
                </button>
              ) : null}
            </article>
          ))}
          {data && !data.rows?.length ? <p className="text-sm text-brown/50">{t.noMappings}</p> : null}
        </div>
        {data?.pagination?.pages > 1 ? (
          <div className="mt-4 flex items-center justify-between text-sm">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="rounded-full px-3 py-1.5 font-semibold text-brown/60 disabled:opacity-40"
            >
              {t.pagePrevious}
            </button>
            <span className="text-brown/50">
              {page} / {data.pagination.pages}
            </span>
            <button
              type="button"
              disabled={page >= data.pagination.pages}
              onClick={() => setPage((current) => current + 1)}
              className="rounded-full px-3 py-1.5 font-semibold text-brown/60 disabled:opacity-40"
            >
              {t.pageNext}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default function CategorySetupPanel(props) {
  if (props.partnerSlug === "gini") return <GiniCategorySetup {...props} />;
  return <ManualCategorySetup {...props} />;
}
