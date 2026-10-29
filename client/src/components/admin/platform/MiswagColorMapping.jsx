import { useEffect, useState } from "react";
import { api } from "../../../api";
import { formatCount, StatusBadge } from "./platformUi";

function statusLabel(status, t) {
  if (status === "manual") return t.miswagMappingManual || "Manual";
  if (status === "auto") return t.miswagMappingAuto || "Auto";
  return t.miswagMappingNeedsReview || "Needs review";
}

function statusKind(status) {
  if (status === "manual" || status === "auto") return "ready";
  return "missing_setup";
}

export default function MiswagColorMapping({ t }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState("");
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    let ignore = false;
    setError("");
    api
      .miswagMappingColors({ q: query, status, page, limit: 20 })
      .then((next) => {
        if (ignore) return;
        setData(next);
        const nextDrafts = {};
        for (const row of next.rows || []) nextDrafts[row.id] = row.miswag?.hex || "";
        setDrafts(nextDrafts);
      })
      .catch((err) => {
        if (!ignore) setError(err.message);
      });
    return () => {
      ignore = true;
    };
  }, [query, status, page]);

  async function refresh() {
    const next = await api.miswagMappingColors({ q: query, status, page, limit: 20 });
    setData(next);
    const nextDrafts = {};
    for (const row of next.rows || []) nextDrafts[row.id] = row.miswag?.hex || "";
    setDrafts(nextDrafts);
  }

  async function save(row) {
    setSaving(row.id);
    setError("");
    setMessage("");
    try {
      await api.saveMiswagMappingColor(row.brownKey, {
        brownLabel: row.brownLabel,
        hex: drafts[row.id],
      });
      setMessage(t.miswagColorMappingSaved || t.mappingSaved);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving("");
    }
  }

  async function reset(row) {
    setSaving(row.id);
    setError("");
    setMessage("");
    try {
      await api.resetMiswagMappingColor(row.brownKey);
      setMessage(t.miswagMappingResetAuto || "Reset to automatic matching");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving("");
    }
  }

  const counts = data?.counts || {};

  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
      <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
        {t.miswagColorMapping || "Color Mapping"}
      </p>
      <p className="mt-2 max-w-2xl text-sm text-brown/55">
        {t.miswagColorMappingHint ||
          "Original BrownStore color names are kept. Verified colors such as Black, White, Red, Blue, and Green get a HEX automatically. Other names, including Black + White, need one manual HEX. Manual mappings override automatic matches."}
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [t.miswagTotalUniqueColors || "Total Unique Colors", counts.total],
          [t.miswagMappingManual || "Manual", counts.manual],
          [t.miswagMappingAuto || "Auto", counts.auto],
          [t.miswagMappingNeedsReview || "Needs review", counts.needs_review],
        ].map(([label, value]) => (
          <article key={label} className="rounded-2xl bg-cream px-4 py-3">
            <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
            <p className="mt-1 font-display text-2xl tabular-nums">{formatCount(value)}</p>
          </article>
        ))}
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
          placeholder={t.miswagColorSearch || "Search colors"}
          className="min-w-[12rem] flex-1 rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm"
        />
        <button type="submit" className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream">
          {t.categorySearch}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-1 rounded-[1.25rem] bg-cream p-1 sm:w-fit">
        {[
          ["all", t.filterAll],
          ["manual", t.miswagMappingManual || "Manual"],
          ["auto", t.miswagMappingAuto || "Auto"],
          ["needs_review", t.miswagMappingNeedsReview || "Needs review"],
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
                <p className="text-sm font-semibold text-brown" dir="auto">
                  {row.brownLabel}
                </p>
                <p className="mt-1 text-xs text-brown/50" dir="ltr">
                  {formatCount(row.productCount)} {t.products}
                </p>
                {row.miswag?.hex ? (
                  <p className="mt-2 flex items-center gap-2 text-xs text-brown/60" dir="ltr">
                    <span
                      className="inline-block h-3 w-3 rounded-full ring-1 ring-brown/15"
                      style={{ background: row.miswag.hex }}
                    />
                    {row.miswag.hex}
                  </p>
                ) : null}
              </div>
              <StatusBadge kind={statusKind(row.status)} t={t}>
                {statusLabel(row.status, t)}
              </StatusBadge>
            </div>

            <div className="mt-4">
              <label className="block text-xs font-semibold text-brown/60">
                {t.miswagColorHex || "HEX"}
                <input
                  dir="ltr"
                  value={drafts[row.id] || ""}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [row.id]: event.target.value }))
                  }
                  placeholder="#RRGGBB"
                  className="mt-1 w-full rounded-xl border border-brown/10 bg-white px-3 py-2 text-sm font-medium text-brown"
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={saving === row.id || !String(drafts[row.id] || "").trim()}
                onClick={() => save(row)}
                className="rounded-full bg-brown px-4 py-2 text-xs font-semibold text-cream disabled:opacity-50"
              >
                {row.status === "manual" ? t.updateSetup : t.saveSetup}
              </button>
              {row.status === "manual" ? (
                <button
                  type="button"
                  disabled={saving === row.id}
                  onClick={() => reset(row)}
                  className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-brown/70 ring-1 ring-brown/10 disabled:opacity-50"
                >
                  {t.miswagMappingResetAuto || "Reset to Auto"}
                </button>
              ) : null}
            </div>
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
  );
}
