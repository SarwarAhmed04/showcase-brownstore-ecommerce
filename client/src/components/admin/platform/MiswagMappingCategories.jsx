import { useEffect, useState } from "react";
import { api } from "../../../api";
import { formatCount, StatusBadge } from "./platformUi";
import MiswagBrandMapping from "./MiswagBrandMapping";
import MiswagColorMapping from "./MiswagColorMapping";

function label(name, lang) {
  if (!name) return "";
  if (typeof name === "string") return name;
  return name[lang] || name.en || name.ku || name.ar || "";
}

function LargeProductToggle({ on, disabled, onToggle, labelText }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-semibold text-brown/60">{labelText}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={labelText}
        data-on={on ? "true" : "false"}
        disabled={disabled}
        onClick={onToggle}
        className={`miswag-large-toggle inline-flex h-11 items-center gap-2 rounded-full py-1 pe-3 ps-1 text-xs font-bold tracking-wide ring-1 transition disabled:opacity-50 ${
          on
            ? "bg-emerald-600 text-white ring-emerald-700"
            : "bg-white text-brown ring-brown/15"
        }`}
      >
        <span
          className="relative h-6 w-11 shrink-0 rounded-full"
          style={{ background: on ? "rgba(255,255,255,0.28)" : "#a1a1aa" }}
        >
          <span
            className="absolute top-0.5 h-5 w-5 rounded-full shadow"
            style={{
              background: "#ffffff",
              insetInlineStart: on ? "1.35rem" : "0.125rem",
            }}
          />
        </span>
        {on ? "ON" : "OFF"}
      </button>
    </div>
  );
}

export default function MiswagMappingCategories({ t, lang, onNotices }) {
  const [tab, setTab] = useState("categories");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState("");
  const [drafts, setDrafts] = useState({});
  const [largeDrafts, setLargeDrafts] = useState({});
  const [pickerFor, setPickerFor] = useState("");
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryHits, setCategoryHits] = useState([]);
  const [finding, setFinding] = useState(false);

  useEffect(() => {
    if (tab !== "categories") return undefined;
    let ignore = false;
    setError("");
    api
      .miswagMappingCategories({ q: query, status, page, limit: 20 })
      .then((next) => {
        if (ignore) return;
        setData(next);
        const nextDrafts = {};
        const nextLarge = {};
        for (const row of next.rows || []) {
          nextDrafts[row.id] = row.miswag?.categoryId || "";
          nextLarge[row.id] = row.isLarge === true;
        }
        setDrafts(nextDrafts);
        setLargeDrafts(nextLarge);
        onNotices?.(Number(next.noticeCount) || 0);
      })
      .catch((err) => {
        if (!ignore) setError(err.message);
      });
    return () => {
      ignore = true;
    };
  }, [tab, query, status, page, onNotices]);

  async function save(row, payload) {
    setSaving(row.id);
    setError("");
    setMessage("");
    try {
      const result = await api.saveMiswagMappingCategory(row.id, payload);
      setData((current) => {
        if (!current) return current;
        const mapped = Boolean(result.mapped);
        const mappedDelta = mapped && !row.mapped ? 1 : !mapped && row.mapped ? -1 : 0;
        return {
          ...current,
          noticeCount: result.noticeCount ?? current.noticeCount,
          counts: {
            ...current.counts,
            mapped: Math.max(0, (current.counts?.mapped || 0) + mappedDelta),
            missing: Math.max(0, (current.counts?.missing || 0) - mappedDelta),
            newCollectionAlerts: result.noticeCount ?? current.counts?.newCollectionAlerts,
          },
          notices: (current.notices || []).filter((notice) => notice.targetId !== row.id),
          rows: current.rows.map((item) =>
            item.id === row.id
              ? {
                  ...item,
                  mapped,
                  status: mapped ? "mapped" : "missing",
                  isLarge: result.isLarge === true,
                  miswag: result.miswag || null,
                  values: result.values || item.values,
                }
              : item
          ),
        };
      });
      setDrafts((current) => ({ ...current, [row.id]: result.miswag?.categoryId || "" }));
      setLargeDrafts((current) => ({ ...current, [row.id]: result.isLarge === true }));
      onNotices?.(Number(result.noticeCount) || 0);
      setMessage(t.mappingSaved);
      setPickerFor("");
      setCategoryHits([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving("");
    }
  }

  async function findCategories(rowId, searchTerm = categoryQuery) {
    setFinding(true);
    setError("");
    setPickerFor(rowId);
    try {
      const result = await api.miswagFindCategories(searchTerm, 20);
      setCategoryHits(result.categories || []);
      if (!(result.categories || []).length) setError(t.miswagNoCategories);
    } catch (err) {
      setError(err.message);
      setCategoryHits([]);
    } finally {
      setFinding(false);
    }
  }

  const counts = data?.counts || {};
  const notices = data?.notices || [];
  const noticeCount = Number(data?.noticeCount) || 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1 rounded-[1.25rem] bg-cream p-1 sm:w-fit">
        {[
          ["categories", t.miswagCategoryMappingTab || "Category Mapping"],
          ["brands", t.miswagBrandMappingTab || "Brand Mapping"],
          ["colors", t.miswagColorMappingTab || "Color Mapping"],
        ].map(([id, text]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-full px-4 py-2 text-xs font-semibold ${
              tab === id ? "bg-white text-brown shadow-sm" : "text-brown/55"
            }`}
          >
            {text}
          </button>
        ))}
      </div>

      {tab === "brands" ? <MiswagBrandMapping t={t} /> : null}
      {tab === "colors" ? <MiswagColorMapping t={t} /> : null}

      {tab === "categories" && noticeCount > 0 ? (
        <section className="rounded-3xl bg-amber-50 p-5 text-amber-950 ring-1 ring-amber-200">
          <p className="font-semibold">
            {String(t.miswagNewCollectionNoticeTitle || "").replace("{count}", formatCount(noticeCount))}
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {notices.map((notice) => (
              <li key={notice.id}>
                <span className="font-semibold">{t.miswagNewCollectionNeedsMapping}</span>
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

      {tab === "categories" ? (
      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.miswagMappingCategories}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.miswagMappingCategoriesHint}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <article className="rounded-2xl bg-cream px-4 py-3">
            <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
              {t.statTotalCollections}
            </p>
            <p className="mt-1 font-display text-2xl tabular-nums">{formatCount(counts.total)}</p>
          </article>
          <article className="rounded-2xl bg-cream px-4 py-3">
            <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{t.mapped}</p>
            <p className="mt-1 font-display text-2xl tabular-nums">{formatCount(counts.mapped)}</p>
          </article>
          <article className="rounded-2xl bg-cream px-4 py-3">
            <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
              {t.miswagMissingMapping}
            </p>
            <p className="mt-1 font-display text-2xl tabular-nums">{formatCount(counts.missing)}</p>
          </article>
          <article className="rounded-2xl bg-cream px-4 py-3">
            <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
              {t.miswagNewCollectionAlerts}
            </p>
            <p className="mt-1 font-display text-2xl tabular-nums">
              {formatCount(counts.newCollectionAlerts)}
            </p>
          </article>
        </div>

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
            ["mapped", t.mapped],
            ["missing", t.miswagMissingMapping],
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
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-brown">{row.path || label(row.name, lang)}</p>
                  <p className="mt-1 text-xs text-brown/50">
                    {formatCount(row.productCount)} {t.products}
                  </p>
                  {row.miswag?.categoryId ? (
                    <p className="mt-2 text-xs text-brown/60" dir="ltr">
                      {row.miswag.categoryName || "—"} · {row.miswag.categoryId}
                      {row.miswag.categoryLevel ? ` · ${row.miswag.categoryLevel}` : ""}
                      {row.miswag.categoryPath ? ` · ${row.miswag.categoryPath}` : ""}
                    </p>
                  ) : null}
                </div>
                <StatusBadge kind={row.mapped ? "ready" : "missing_setup"} t={t}>
                  {row.mapped ? t.mapped : t.miswagMissingMapping}
                </StatusBadge>
              </div>

              <div className="mt-4 space-y-3">
                <label className="block text-xs font-semibold text-brown/60">
                  {t.miswagCategoryIdManual}
                  <input
                    dir="ltr"
                    value={drafts[row.id] || ""}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [row.id]: event.target.value }))
                    }
                    placeholder="L3-... or L4-..."
                    className="mt-1 w-full rounded-xl border border-brown/10 bg-white px-3 py-2 text-sm font-medium text-brown"
                  />
                </label>
                <LargeProductToggle
                  on={largeDrafts[row.id] === true}
                  disabled={saving === row.id}
                  labelText={t.miswagLargeProduct || "Large Product"}
                  onToggle={() =>
                    setLargeDrafts((current) => ({
                      ...current,
                      [row.id]: current[row.id] !== true,
                    }))
                  }
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={saving === row.id || !String(drafts[row.id] || "").trim()}
                    onClick={() =>
                      save(row, {
                        categoryId: drafts[row.id],
                        isLarge: largeDrafts[row.id] === true,
                      })
                    }
                    className="rounded-full bg-brown px-4 py-2 text-xs font-semibold text-cream disabled:opacity-50"
                  >
                    {row.mapped ? t.updateSetup : t.saveSetup}
                  </button>
                  <button
                    type="button"
                    disabled={finding && pickerFor === row.id}
                    onClick={() => {
                      const term = label(row.name, lang);
                      setPickerFor(row.id);
                      setCategoryQuery(term);
                      findCategories(row.id, term);
                    }}
                    className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50"
                  >
                    {finding && pickerFor === row.id ? t.loading : t.miswagPickCategory}
                  </button>
                </div>
              </div>

              {pickerFor === row.id ? (
                <div className="mt-3 rounded-2xl bg-white p-3 ring-1 ring-brown/10">
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      findCategories(row.id);
                    }}
                  >
                    <input
                      value={categoryQuery}
                      onChange={(event) => setCategoryQuery(event.target.value)}
                      placeholder={t.miswagSearchMiswagCategories}
                      className="min-w-[10rem] flex-1 rounded-full border border-brown/10 bg-cream px-3 py-1.5 text-sm"
                    />
                    <button
                      type="submit"
                      disabled={finding}
                      className="rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream disabled:opacity-50"
                    >
                      {t.categorySearch}
                    </button>
                  </form>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-sm">
                    {categoryHits.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          dir="ltr"
                          onClick={() =>
                            save(row, {
                              categoryId: hit.id,
                              categoryName: hit.name || hit.nameEn || hit.nameAr,
                              categoryPath: hit.path,
                              categoryLevel: hit.level,
                              isLarge: largeDrafts[row.id] === true,
                            })
                          }
                          className="w-full rounded-xl px-3 py-2 text-start hover:bg-cream"
                        >
                          <span className="font-semibold text-brown">{hit.name || hit.id}</span>
                          <span className="mt-0.5 block text-xs text-brown/55">
                            {hit.id}
                            {hit.level ? ` · ${hit.level}` : ""}
                            {hit.path ? ` · ${hit.path}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                    {!categoryHits.length ? (
                      <li className="px-2 py-2 text-xs text-brown/45">{t.miswagNoCategories}</li>
                    ) : null}
                  </ul>
                </div>
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
      ) : null}
    </div>
  );
}
