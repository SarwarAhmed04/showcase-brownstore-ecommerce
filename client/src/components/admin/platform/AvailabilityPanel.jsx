import { useEffect, useState } from "react";
import { api } from "../../../api";
import { tName } from "../../../i18n";
import { formatCount, Pager, reasonLabel, StatusBadge } from "./platformUi";

const CONTROL =
  "rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";

const SCOPES = [
  ["category", "scopeCategories"],
  ["subcategory", "scopeSubcategories"],
  ["collection", "scopeCollections"],
  ["brand", "scopeBrands"],
  ["vendor", "scopeVendors"],
  ["product", "products"],
];

export default function AvailabilityPanel({ partnerSlug, t, lang }) {
  const [scope, setScope] = useState("category");
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const listKey = `${partnerSlug}|${scope}|${status}|${q}|${page}`;

  function load() {
    return api
      .platformAvailability(partnerSlug, { scope, status, q, page, limit: 20 })
      .then((next) => {
        setData(next);
        setSelected([]);
      });
  }

  useEffect(() => {
    let ignore = false;
    const timer = setTimeout(() => {
      api
        .platformAvailability(partnerSlug, { scope, status, q, page, limit: 20 })
        .then((next) => {
          if (ignore) return;
          setData(next);
          setSelected([]);
        })
        .catch((err) => {
          if (!ignore) setError(err.message);
        });
    }, 200);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [listKey, partnerSlug, scope, status, q, page]);

  function rowName(row) {
    return tName(row.name, lang) || row.sku || row.id;
  }

  async function applyChange(body) {
    const count = body.allMatching ? Number(data?.pagination?.total) || 0 : (body.targetIds || []).length;
    const large = body.allMatching || count >= 25;
    const prompt = (large ? t.bulkConfirmLarge : t.bulkConfirm).replace("{count}", formatCount(count));
    if (large && !window.confirm(prompt)) return;
    if (!large && count > 1 && !window.confirm(prompt)) return;
    setBusy(true);
    setError("");
    try {
      await api.setPlatformAvailability(partnerSlug, { ...body, confirm: true, q, status });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const rows = data?.rows || [];
  const pageIds = rows.map((row) => row.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));

  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
      <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">{t.availabilityTab}</p>
      <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.availabilityHint}</p>
      <div className="mt-4 flex flex-wrap gap-1 rounded-[1.25rem] bg-cream p-1">
        {SCOPES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setScope(id);
              setPage(1);
              setSelected([]);
              setQ("");
            }}
            className={`rounded-full px-3 py-2 text-xs font-semibold ${
              scope === id ? "bg-brown text-cream" : "text-brown/60"
            }`}
          >
            {t[label]}
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(event) => {
            setPage(1);
            setQ(event.target.value);
          }}
          placeholder={t.search}
          className={`${CONTROL} min-w-0 flex-1`}
        />
        {[
          ["all", t.eligibilityAll],
          ["active", t.activeOnly],
          ["inactive", t.inactiveOnly],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setStatus(id);
              setPage(1);
            }}
            className={`rounded-full px-3 py-2 text-xs font-semibold ${
              status === id ? "bg-brown text-cream" : "bg-cream text-brown/60"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2 text-sm font-semibold text-brown/70">
          <input
            type="checkbox"
            checked={allPageSelected}
            onChange={(event) => setSelected(event.target.checked ? pageIds : [])}
          />
          {t.selectPage}
        </label>
        <button
          type="button"
          disabled={busy || !selected.length}
          onClick={() => applyChange({ scope, targetIds: selected, isActive: true })}
          className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 disabled:opacity-40"
        >
          {t.bulkActivate}
        </button>
        <button
          type="button"
          disabled={busy || !selected.length}
          onClick={() => applyChange({ scope, targetIds: selected, isActive: false })}
          className="rounded-full bg-brown/10 px-3 py-1.5 text-xs font-semibold text-brown disabled:opacity-40"
        >
          {t.bulkDeactivate}
        </button>
        <button
          type="button"
          disabled={busy || !data?.pagination?.total}
          onClick={() => applyChange({ scope, allMatching: true, isActive: true })}
          className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 disabled:opacity-40"
        >
          {t.bulkMatchingOn}
        </button>
        <button
          type="button"
          disabled={busy || !data?.pagination?.total}
          onClick={() => applyChange({ scope, allMatching: true, isActive: false })}
          className="rounded-full bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-800 disabled:opacity-40"
        >
          {t.bulkMatching}
        </button>
      </div>
      <div className="mt-2 divide-y divide-brown/5">
        {rows.map((row) => {
          const blocked = row.eligibility && !row.eligibility.eligible;
          return (
            <article key={row.id} className="flex items-center gap-3 py-3">
              <input
                type="checkbox"
                checked={selected.includes(row.id)}
                onChange={(event) => {
                  setSelected((current) =>
                    event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id)
                  );
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-medium">{rowName(row)}</p>
                  <StatusBadge kind={row.isActive ? "active" : "inactive"} t={t} />
                  {blocked ? <StatusBadge kind="blocked" t={t} /> : null}
                </div>
                <p className="mt-1 text-xs text-brown/45">
                  {formatCount(row.productCount)} {t.products}
                  {row.sku ? ` · ${row.sku}` : ""}
                </p>
                {blocked ? (
                  <p className="mt-1 text-xs text-red-800">
                    {(row.eligibility.reasons || []).map((reason) => reasonLabel(t, reason)).join(" · ")}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => applyChange({ scope, targetIds: [row.id], isActive: !row.isActive })}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                  row.isActive ? "bg-emerald-50 text-emerald-800" : "bg-brown/10 text-brown/55"
                }`}
              >
                {row.isActive ? t.commissionActive : t.commissionInactive}
              </button>
            </article>
          );
        })}
        {data && !rows.length ? <p className="py-6 text-sm text-brown/45">{t.noProducts}</p> : null}
      </div>
      <Pager page={data?.pagination?.page || page} pages={data?.pagination?.pages || 1} onPage={setPage} />
    </section>
  );
}
