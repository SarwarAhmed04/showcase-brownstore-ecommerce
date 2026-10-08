import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import Spinner from "../../components/Spinner";

const EMPTY_SUMMARY = {
  totalCollections: 0,
  mapped: 0,
  autoMapped: 0,
  verified: 0,
  needsReview: 0,
  unmapped: 0,
  lastSyncedAt: null,
};

const FILTERS = [
  ["", "mappingFilterAll"],
  ["auto_mapped", "statusAutoMapped"],
  ["verified", "statusVerified"],
  ["needs_review", "statusNeedsReview"],
  ["unmapped", "statusUnmapped"],
];

const CONTROL =
  "rounded-full border border-brown/10 bg-cream px-3 py-2 text-xs font-semibold text-brown outline-none ring-tan/40 focus:ring-2";

function categoryLabel(category) {
  const primary = category.nameEn || category.alias || category.nameAr || category.externalId;
  if (category.nameAr && category.nameAr !== primary) return `${primary} — ${category.nameAr}`;
  return primary;
}

function statusLabel(t, status) {
  if (status === "auto_mapped") return t.statusAutoMapped;
  if (status === "verified") return t.statusVerified;
  if (status === "needs_review") return t.statusNeedsReview;
  return t.statusUnmapped;
}

function statusClass(status) {
  if (status === "verified") return "bg-brown text-cream";
  if (status === "auto_mapped") return "bg-emerald-50 text-emerald-800";
  if (status === "needs_review") return "bg-amber-50 text-amber-900";
  return "bg-cream text-brown/60";
}

function formatSync(value, lang) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const locale = lang === "ar" ? "ar" : "en";
  return date.toLocaleString(locale);
}

function CategoryPicker({ categories, value, label, path, disabled, onChange, t }) {
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? categories.filter((item) =>
          `${item.nameEn} ${item.nameAr} ${item.alias} ${item.path}`.toLowerCase().includes(q)
        )
      : [];
    const capped = matches.slice(0, 60);
    const selected =
      categories.find((item) => item.externalId === value) ||
      (value
        ? { externalId: value, nameEn: label || value, nameAr: "", alias: "", path: path || "" }
        : null);
    if (selected && !capped.some((item) => item.externalId === selected.externalId)) {
      capped.unshift(selected);
    }
    return capped;
  }, [categories, label, path, query, value]);

  return (
    <div className="grid min-w-[16rem] gap-1.5">
      <input
        value={query}
        disabled={disabled || !categories.length}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={categories.length ? t.mappingSearchCategories : t.mappingNoCategories}
        className={CONTROL}
      />
      <select
        value={value || ""}
        disabled={disabled || !categories.length}
        onChange={(event) => {
          const next = event.target.value;
          if (!next || next === value) return;
          onChange(next);
          setQuery("");
        }}
        className={`${CONTROL} bg-white`}
      >
        <option value="">{t.mappingSelectCategory}</option>
        {options.map((item) => (
          <option key={item.externalId} value={item.externalId}>
            {item.path ? `${categoryLabel(item)} · ${item.path}` : categoryLabel(item)}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function PlatformCategoryMapping({ t, lang }) {
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [mappings, setMappings] = useState([]);
  const [categories, setCategories] = useState([]);
  const [health, setHealth] = useState(null);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  function applyResult(data) {
    if (data?.mapping) {
      setMappings((current) =>
        current.map((row) =>
          row.brownCollectionId === data.mapping.brownCollectionId ? data.mapping : row
        )
      );
    }
    if (data?.summary) setSummary(data.summary);
  }

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    Promise.all([api.miswagMappings(), api.miswagExternalCategories(), api.miswagHealth()])
      .then(([data, cats, nextHealth]) => {
        if (ignore) return;
        setMappings(data.mappings || []);
        setSummary(data.summary || EMPTY_SUMMARY);
        setCategories(cats.categories || []);
        setHealth(nextHealth);
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
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mappings.filter((row) => {
      if (status && row.status !== status) return false;
      if (!q) return true;
      const blob = `${row.hierarchy} ${row.brownCollectionName} ${row.externalCategoryName} ${row.externalPath}`.toLowerCase();
      return blob.includes(q);
    });
  }, [mappings, status, query]);

  async function onSync() {
    setBusy("sync");
    setError("");
    setMessage("");
    try {
      const data = await api.syncMiswagCategories();
      const cats = await api.miswagExternalCategories();
      setCategories(cats.categories || []);
      if (data.summary) setSummary(data.summary);
      setMessage(`${t.mappingSynced} (${Number(data.count) || 0})`);
      setHealth({ ok: true, configured: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function onAuto() {
    setBusy("auto");
    setError("");
    setMessage("");
    try {
      const data = await api.runMiswagAutoMapping();
      const next = await api.miswagMappings();
      setMappings(next.mappings || []);
      setSummary(data.summary || next.summary || EMPTY_SUMMARY);
      setMessage(t.mappingAutoDone);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function onSelect(row, externalCategoryId) {
    const key = `${row.brownCollectionId}:select`;
    setBusy(key);
    setError("");
    setMessage("");
    try {
      applyResult(await api.selectMiswagMapping(row.brownCollectionId, externalCategoryId));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function onVerify(row) {
    const key = `${row.brownCollectionId}:verify`;
    setBusy(key);
    setError("");
    setMessage("");
    try {
      applyResult(await api.verifyMiswagMapping(row.brownCollectionId));
      setMessage(t.mappingVerifiedDone);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function onRerun(row) {
    const key = `${row.brownCollectionId}:rerun`;
    setBusy(key);
    setError("");
    setMessage("");
    try {
      applyResult(await api.rerunMiswagMapping(row.brownCollectionId));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  if (loading) return <Spinner label={t.loading} />;

  const cards = [
    [t.mappingTotal, summary.totalCollections],
    [t.mappingMapped, summary.mapped],
    [t.mappingVerified, summary.verified],
    [t.mappingNeedsReview, summary.needsReview],
    [t.mappingUnmapped, summary.unmapped],
  ];
  const healthText = !health
    ? ""
    : health.configured === false
      ? t.mappingCredentials
      : health.ok
        ? t.mappingHealthOk
        : health.message || t.mappingHealthFail;

  return (
    <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-brown/5 sm:p-6">
      <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
        {t.categoryMapping}
      </p>
      <p className="mt-2 max-w-3xl text-sm text-brown/55">{t.categoryMappingHint}</p>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {cards.map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-cream px-4 py-3">
            <p className="text-[11px] font-semibold text-brown/45">{label}</p>
            <p className="mt-1 font-display text-2xl tabular-nums">{Number(value) || 0}</p>
          </div>
        ))}
      </div>

      <p className="mt-4 text-sm text-brown/55">
        {t.mappingLastSync}: {formatSync(summary.lastSyncedAt, lang) || t.mappingNeverSynced}
      </p>
      {healthText ? (
        <p className={`mt-1 text-sm ${health?.ok ? "text-brown/55" : "text-amber-800"}`}>{healthText}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={onSync}
          className="rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
        >
          {busy === "sync" ? t.loading : t.syncMiswagCategories}
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={onAuto}
          className="rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown disabled:opacity-50"
        >
          {busy === "auto" ? t.loading : t.runAutoMapping}
        </button>
      </div>

      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mt-4 text-sm text-brown/70">{message}</p> : null}

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(([id, labelKey]) => (
            <button
              key={id || "all"}
              type="button"
              onClick={() => setStatus(id)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                status === id ? "bg-brown text-cream" : "bg-cream text-brown/60"
              }`}
            >
              {t[labelKey]}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.mappingSearch}
          className={`${CONTROL} w-full sm:max-w-xs`}
        />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-brown/10 text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
              <th className="px-2 py-3 font-semibold">{t.mappingHierarchy}</th>
              <th className="px-2 py-3 font-semibold">{t.mappingMiswagCategory}</th>
              <th className="px-2 py-3 font-semibold">{t.mappingPath}</th>
              <th className="px-2 py-3 font-semibold">{t.mappingConfidence}</th>
              <th className="px-2 py-3 font-semibold">{t.mappingStatus}</th>
              <th className="px-2 py-3 font-semibold">{t.mappingActions}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const rowBusy = busy.startsWith(row.brownCollectionId);
              return (
                <tr key={row.brownCollectionId} className="border-b border-brown/5 align-top">
                  <td className="px-2 py-3">
                    <p className="font-semibold text-brown">{row.brownCollectionName}</p>
                    <p className="mt-1 text-xs text-brown/45">{row.hierarchy}</p>
                  </td>
                  <td className="px-2 py-3">
                    <CategoryPicker
                      categories={categories}
                      value={row.externalCategoryId}
                      label={row.externalCategoryName}
                      path={row.externalPath}
                      disabled={Boolean(busy)}
                      t={t}
                      onChange={(externalCategoryId) => onSelect(row, externalCategoryId)}
                    />
                  </td>
                  <td className="max-w-[16rem] px-2 py-3 text-xs text-brown/70">
                    {row.externalPath || "—"}
                  </td>
                  <td className="px-2 py-3 font-semibold tabular-nums">{row.confidence}%</td>
                  <td className="px-2 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusClass(row.status)}`}>
                      {statusLabel(t, row.status)}
                    </span>
                  </td>
                  <td className="px-2 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        disabled={Boolean(busy) || !row.externalCategoryId || row.status === "verified"}
                        onClick={() => onVerify(row)}
                        className="rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream disabled:opacity-40"
                      >
                        {rowBusy && busy.endsWith(":verify") ? t.loading : t.mappingVerify}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busy) || row.status === "verified"}
                        onClick={() => onRerun(row)}
                        className="rounded-full bg-cream px-3 py-1.5 text-xs font-semibold text-brown disabled:opacity-40"
                      >
                        {rowBusy && busy.endsWith(":rerun") ? t.loading : t.mappingRerun}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visible.length ? <p className="px-2 py-6 text-sm text-brown/50">{t.mappingEmpty}</p> : null}
      </div>
    </section>
  );
}
