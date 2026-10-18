import { useEffect, useState } from "react";
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

export default function CategorySetupPanel({ partnerSlug, t, lang, onNotices }) {
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
