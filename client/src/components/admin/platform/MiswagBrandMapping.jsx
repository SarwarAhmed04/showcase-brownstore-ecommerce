import { useEffect, useState } from "react";
import { api } from "../../../api";
import { formatCount, StatusBadge } from "./platformUi";

function statusLabel(status, t) {
  if (status === "manual") return t.miswagMappingManual || "Manual";
  if (status === "auto") return t.miswagMappingAuto || "Auto";
  return t.miswagMappingNeedsReview || "Needs review";
}

function statusKind(status) {
  if (status === "manual") return "ready";
  if (status === "auto") return "ready";
  return "missing_setup";
}

export default function MiswagBrandMapping({ t }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState("");
  const [drafts, setDrafts] = useState({});
  const [pickerFor, setPickerFor] = useState("");
  const [brandQuery, setBrandQuery] = useState("");
  const [brandHits, setBrandHits] = useState([]);
  const [finding, setFinding] = useState(false);

  useEffect(() => {
    let ignore = false;
    setError("");
    api
      .miswagMappingBrands({ q: query, status, page, limit: 20 })
      .then((next) => {
        if (ignore) return;
        setData(next);
        const nextDrafts = {};
        for (const row of next.rows || []) {
          nextDrafts[row.id] = row.miswag?.id || "";
        }
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
    const next = await api.miswagMappingBrands({ q: query, status, page, limit: 20 });
    setData(next);
    const nextDrafts = {};
    for (const row of next.rows || []) nextDrafts[row.id] = row.miswag?.id || "";
    setDrafts(nextDrafts);
  }

  async function save(row, payload) {
    setSaving(row.id);
    setError("");
    setMessage("");
    try {
      await api.saveMiswagMappingBrand(row.brownKey, {
        brownLabel: row.brownLabel,
        miswagId: payload.miswagId,
        miswagLabel: payload.miswagLabel || "",
      });
      setMessage(t.miswagBrandMappingSaved || t.mappingSaved);
      setPickerFor("");
      setBrandHits([]);
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
      await api.resetMiswagMappingBrand(row.brownKey);
      setMessage(t.miswagMappingReset || "Reset to automatic matching");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving("");
    }
  }

  async function findBrands(rowId, searchTerm = brandQuery) {
    setFinding(true);
    setError("");
    setPickerFor(rowId);
    try {
      const result = await api.miswagFindBrands(searchTerm, 20);
      setBrandHits(result.brands || []);
      if (!(result.brands || []).length) setError(t.miswagNoBrands);
    } catch (err) {
      setError(err.message);
      setBrandHits([]);
    } finally {
      setFinding(false);
    }
  }

  const counts = data?.counts || {};

  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
      <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
        {t.miswagBrandMapping || "Brand Mapping"}
      </p>
      <p className="mt-2 max-w-2xl text-sm text-brown/55">
        {t.miswagBrandMappingHint ||
          "Match BrownStore brands to Miswag brand ids. Manual mappings always win over automatic exact-name matches."}
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [t.miswagTotalUniqueBrands || "Total Unique Brands", counts.total],
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
          placeholder={t.miswagBrandSearchPlaceholder || t.categorySearch}
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
                <p className="text-sm font-semibold text-brown">{row.brownLabel}</p>
                <p className="mt-1 text-xs text-brown/50" dir="ltr">
                  {row.brownKey} · {formatCount(row.productCount)} {t.products}
                </p>
                {row.miswag?.id ? (
                  <p className="mt-2 text-xs text-brown/60" dir="ltr">
                    {row.miswag.name || "—"} · id {row.miswag.id}
                  </p>
                ) : null}
              </div>
              <StatusBadge kind={statusKind(row.status)} t={t}>
                {statusLabel(row.status, t)}
              </StatusBadge>
            </div>

            <div className="mt-4 space-y-3">
              <label className="block text-xs font-semibold text-brown/60">
                {t.miswagTempBrandId || "Miswag brand id"}
                <input
                  dir="ltr"
                  value={drafts[row.id] || ""}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [row.id]: event.target.value }))
                  }
                  placeholder="e.g. 42"
                  className="mt-1 w-full rounded-xl border border-brown/10 bg-white px-3 py-2 text-sm font-medium text-brown"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={saving === row.id || !String(drafts[row.id] || "").trim()}
                  onClick={() => save(row, { miswagId: drafts[row.id] })}
                  className="rounded-full bg-brown px-4 py-2 text-xs font-semibold text-cream disabled:opacity-50"
                >
                  {row.mapped ? t.updateSetup : t.saveSetup}
                </button>
                <button
                  type="button"
                  disabled={finding && pickerFor === row.id}
                  onClick={() => {
                    setBrandQuery(row.brownLabel);
                    findBrands(row.id, row.brownLabel);
                  }}
                  className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50"
                >
                  {finding && pickerFor === row.id ? t.loading : t.miswagFindBrand}
                </button>
                {row.mapped ? (
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
            </div>

            {pickerFor === row.id ? (
              <div className="mt-3 rounded-2xl bg-white p-3 ring-1 ring-brown/10">
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    findBrands(row.id);
                  }}
                >
                  <input
                    value={brandQuery}
                    onChange={(event) => setBrandQuery(event.target.value)}
                    placeholder={t.miswagBrandSearchPlaceholder}
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
                  {brandHits.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        dir="ltr"
                        onClick={() =>
                          save(row, {
                            miswagId: hit.id,
                            miswagLabel: hit.name || hit.alias || "",
                          })
                        }
                        className="w-full rounded-xl px-3 py-2 text-start hover:bg-cream"
                      >
                        <span className="font-semibold text-brown">{hit.name || hit.id}</span>
                        <span className="mt-0.5 block text-xs text-brown/55">
                          id {hit.id}
                          {hit.alias ? ` · ${hit.alias}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                  {!brandHits.length ? (
                    <li className="px-2 py-2 text-xs text-brown/45">{t.miswagNoBrands}</li>
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
  );
}
