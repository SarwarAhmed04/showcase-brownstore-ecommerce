import { useEffect, useMemo, useState } from "react";
import { api } from "../../../api";
import {
  filterWarrantyBrands,
  officialWarrantiesForSearch,
  sharedWarrantyCounts,
  warrantyReview,
  warrantySaveReady,
} from "../../../utils/elryanWarrantyMappingPage";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON = "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST = "rounded-full border border-brown/15 bg-white px-4 py-2.5 text-sm font-semibold text-brown disabled:opacity-50";

function text(t, key, fallback) {
  return t?.[key] || fallback;
}

function supplied(value, emptyLabel) {
  if (value == null || value === "") return emptyLabel;
  return String(value);
}

export default function ElryanWarrantyMapping({ t }) {
  const [page, setPage] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [brandId, setBrandId] = useState("");
  const [warrantyCode, setWarrantyCode] = useState("");
  const [confirmCoverage, setConfirmCoverage] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [readBack, setReadBack] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const data = await api.elryanWarrantyMapping();
    setPage(data);
    return data;
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  const brands = page?.brands || [];
  const warrantyState = page?.warranties || null;
  const catalogOk = warrantyState?.ok === true && warrantyState.failed !== true && warrantyState.empty !== true;
  const visibleBrands = useMemo(
    () => filterWarrantyBrands(brands, { q: search, status }),
    [brands, search, status]
  );
  const official = useMemo(
    () => officialWarrantiesForSearch(warrantyState?.items || [], search),
    [warrantyState, search]
  );
  const shared = useMemo(() => sharedWarrantyCounts(brands), [brands]);
  const selected = brands.find((row) => row.brownKey === brandId) || null;
  const selectedWarranty = (warrantyState?.items || []).find((item) => item.code === warrantyCode) || null;
  const review = warrantyReview({ brand: selected, warranty: selectedWarranty });
  const needsOverwrite = Boolean(review?.replaces);
  const canSave = warrantySaveReady({
    brandId,
    code: warrantyCode,
    confirmCoverage,
    needsOverwrite,
    confirmOverwrite,
    catalogOk,
  });
  const notSupplied = text(t, "elryanWarrantyNotSupplied", "Not supplied");

  function chooseBrand(nextId) {
    const row = brands.find((item) => item.brownKey === nextId) || null;
    setBrandId(nextId);
    setWarrantyCode(row?.warranty?.verified ? row.warranty.code : "");
    setConfirmCoverage(false);
    setConfirmOverwrite(false);
    setReadBack(null);
    setMessage("");
    setError("");
  }

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    if (!canSave || !selected || !selectedWarranty) return;
    setBusy(true);
    setError("");
    setMessage("");
    setReadBack(null);
    try {
      const result = await api.saveElryanWarrantyMapping({
        brownKey: selected.brownKey,
        elryanCode: selectedWarranty.code,
        confirmCoverage: true,
        confirmOverwrite: confirmOverwrite === true,
      });
      if (result?.readBack?.ok !== true || result.readBack.elryanCode !== selectedWarranty.code) {
        setError(text(t, "elryanWarrantyReadBackFailed", "The database read-back did not match the warranty you confirmed."));
        return;
      }
      setReadBack(result.readBack);
      setMessage(text(t, "elryanWarrantyReadBack", "Saved and read back from the database."));
      setConfirmCoverage(false);
      setConfirmOverwrite(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const counts = page?.counts || {};

  return (
    <section className="elryan-warranty-mapping space-y-6" data-elryan-warranty-page="true">
      <div>
        <h2 className="font-display text-2xl text-brown">{text(t, "elryanWarrantyMappingTitle", "Warranty Mapping")}</h2>
        <p className="mt-2 max-w-3xl text-sm text-brown/70">
          {text(
            t,
            "elryanWarrantyMappingHint",
            "Map each BrownStore brand to one official Elryan Staging warranty. Several brands may share one warranty. Nothing is saved until you review and confirm."
          )}
        </p>
        <p className="mt-2 text-sm font-semibold text-brown">
          {text(t, "elryanWarrantyStagingBanner", "Staging only. Production warranties and mappings are not read or changed here.")}
        </p>
        <p className="mt-2 max-w-3xl text-xs font-semibold text-brown/60">
          {text(
            t,
            "elryanWarrantyNoNameMatch",
            "A similar name does not assign a warranty. Choose an official warranty and confirm it."
          )}
        </p>
      </div>

      {error ? <p className="rounded-2xl bg-cream px-4 py-3 text-sm font-semibold text-amber-900">{error}</p> : null}
      {message ? <p className="rounded-2xl bg-cream px-4 py-3 text-sm font-semibold text-brown">{message}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={text(t, "elryanWarrantyBrands", "Brands")} value={counts.brands ?? 0} />
        <Stat label={text(t, "elryanWarrantyFilterMapped", "Mapped")} value={counts.mapped ?? 0} />
        <Stat label={text(t, "elryanWarrantyFilterUnmapped", "Unmapped")} value={counts.unmapped ?? 0} />
        <Stat label={text(t, "elryanWarrantyOfficial", "Official Elryan warranties")} value={counts.warranties ?? 0} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-[16rem] flex-1 text-sm font-semibold text-brown">
          {text(t, "elryanWarrantySearch", "Search by brand or warranty")}
          <input
            className={`${CONTROL} mt-2`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {[
            ["all", text(t, "elryanWarrantyFilterAll", "All")],
            ["mapped", text(t, "elryanWarrantyFilterMapped", "Mapped")],
            ["unmapped", text(t, "elryanWarrantyFilterUnmapped", "Unmapped")],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={status === id ? BUTTON : GHOST}
              onClick={() => setStatus(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className={GHOST} disabled={busy} onClick={refresh}>
          {text(t, "elryanWarrantyRefresh", "Refresh warranties")}
        </button>
      </div>

      <WarrantyCatalog t={t} state={warrantyState} items={official} shared={shared} notSupplied={notSupplied} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
        <div className="space-y-3">
          {visibleBrands.length ? (
            visibleBrands.map((row) => (
              <article
                key={row.brownKey}
                data-elryan-warranty-brand={row.brownKey}
                className={`rounded-[1.5rem] bg-white p-4 ring-1 ${
                  row.brownKey === brandId ? "ring-brown" : "ring-brown/10"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-display text-xl text-brown">{row.brownLabel}</h3>
                    <p className="mt-1 text-xs font-semibold text-brown/50">
                      {text(t, "elryanWarrantyBrandId", "Brand ID")} {row.brownKey}
                    </p>
                  </div>
                  <button type="button" className={GHOST} onClick={() => chooseBrand(row.brownKey)}>
                    {text(t, "elryanWarrantyEdit", "Edit mapping")}
                  </button>
                </div>
                <dl className="mt-3 grid gap-2 text-sm text-brown/70 sm:grid-cols-3">
                  <div>
                    <dt className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                      {text(t, "elryanDimProductCount", "Products")}
                    </dt>
                    <dd className="mt-1 font-semibold text-brown">{row.productCount}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                      {text(t, "elryanWarrantyBrandMapping", "Elryan brand mapping")}
                    </dt>
                    <dd className="mt-1 font-semibold text-brown">
                      {row.brandMapping?.mapped
                        ? `${row.brandMapping.elryanLabel || row.brandMapping.elryanId} · ${row.brandMapping.elryanId}`
                        : text(t, "elryanWarrantyUnmapped", "Unmapped")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                      {text(t, "elryanWarrantyCurrent", "Current warranty")}
                    </dt>
                    <dd className="mt-1 font-semibold text-brown">
                      {row.warranty?.code
                        ? `${row.warranty.label || row.warranty.code} · ${row.warranty.code}`
                        : text(t, "elryanWarrantyUnmapped", "Unmapped")}
                      {row.warranty?.code && row.warranty.verified === false
                        ? ` · ${text(t, "elryanWarrantyCodeMissing", "Not in the current official list")}`
                        : ""}
                    </dd>
                  </div>
                </dl>
              </article>
            ))
          ) : (
            <p className="rounded-[1.5rem] bg-white px-4 py-6 text-sm text-brown/60 ring-1 ring-brown/10">
              {text(t, "elryanWarrantyNoBrands", "No BrownStore brands match this search.")}
            </p>
          )}
        </div>

        <form onSubmit={save} className="h-fit space-y-4 rounded-[1.75rem] bg-white p-5 ring-1 ring-brown/10">
          <h3 className="font-display text-xl text-brown">{text(t, "elryanWarrantyEdit", "Edit mapping")}</h3>
          <label className="block text-sm font-semibold text-brown">
            {text(t, "elryanWarrantySelectBrand", "BrownStore brand")}
            <select
              className={`${CONTROL} mt-2`}
              value={brandId}
              onChange={(event) => chooseBrand(event.target.value)}
            >
              <option value="">{text(t, "elryanWarrantySelectBrandPlaceholder", "Select a brand")}</option>
              {brands.map((row) => (
                <option key={row.brownKey} value={row.brownKey}>
                  {row.brownLabel}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <p className="text-xs font-semibold text-brown/50">
              {text(t, "elryanWarrantyBrandId", "Brand ID")} {selected.brownKey}
            </p>
          ) : null}
          <label className="block text-sm font-semibold text-brown">
            {text(t, "elryanWarrantySelectWarranty", "Official warranty")}
            <select
              className={`${CONTROL} mt-2`}
              value={warrantyCode}
              disabled={!catalogOk}
              onChange={(event) => {
                setWarrantyCode(event.target.value);
                setConfirmCoverage(false);
                setConfirmOverwrite(false);
                setReadBack(null);
              }}
            >
              <option value="">{text(t, "elryanWarrantySelectWarrantyPlaceholder", "Select an official warranty")}</option>
              {(warrantyState?.items || []).map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name || item.code} · {item.code}
                </option>
              ))}
            </select>
          </label>

          {review ? (
            <div className="rounded-2xl bg-cream px-4 py-3 text-sm text-brown">
              <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                {text(t, "elryanWarrantyReview", "Review")}
              </p>
              <p className="mt-2 font-semibold">
                {review.brownLabel} → {review.name || review.code}
              </p>
              <p className="mt-1 text-brown/70">
                {text(t, "elryanWarrantyCode", "Warranty code")} {review.code}
                {review.id ? ` · ${review.id}` : ""}
              </p>
              <p className="mt-1 text-brown/70">
                {text(t, "elryanWarrantyDuration", "Duration")} {supplied(review.duration, notSupplied)}
              </p>
              <p className="mt-1 text-brown/70">
                {text(t, "elryanWarrantyTerms", "Terms")} {supplied(review.terms, notSupplied)}
              </p>
              {review.returnPolicy ? (
                <p className="mt-1 text-brown/70">
                  {text(t, "elryanWarrantyReturnPolicy", "Return policy")} {review.returnPolicy}
                </p>
              ) : null}
              {review.provider ? (
                <p className="mt-1 text-brown/70">
                  {text(t, "elryanWarrantyProvider", "Provider")} {review.provider}
                </p>
              ) : null}
              <p className="mt-1 text-brown/70">
                {text(t, "elryanWarrantyStatus", "Status")} {supplied(review.status, notSupplied)}
              </p>
              {review.replaces ? (
                <p className="mt-2 font-semibold text-amber-900">
                  {text(t, "elryanWarrantyReplaces", "This replaces saved code")} {review.replaces}
                </p>
              ) : null}
            </div>
          ) : null}

          <label className="flex items-start gap-3 text-sm font-semibold text-brown">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmCoverage}
              onChange={(event) => setConfirmCoverage(event.target.checked)}
            />
            <span>
              {text(
                t,
                "elryanWarrantyConfirmCoverage",
                "I confirm this warranty coverage applies to this brand's relevant products."
              )}
            </span>
          </label>
          {needsOverwrite ? (
            <label className="flex items-start gap-3 text-sm font-semibold text-brown">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmOverwrite}
                onChange={(event) => setConfirmOverwrite(event.target.checked)}
              />
              <span>
                {text(
                  t,
                  "elryanWarrantyConfirmOverwrite",
                  "I confirm replacing the warranty already saved for this brand."
                )}
              </span>
            </label>
          ) : null}
          <button type="submit" className={BUTTON} disabled={!canSave || busy}>
            {text(t, "elryanWarrantySave", "Review & Save")}
          </button>
          {readBack?.ok ? (
            <p className="text-xs font-semibold text-brown/60">
              {text(t, "elryanWarrantyReadBackDetail", "Database read-back")} {readBack.brownKey} · {readBack.elryanCode}
            </p>
          ) : null}
          <p className="text-xs text-brown/50">
            {page?.writes?.productWritesEnabled
              ? text(t, "elryanWarrantyWritesOn", "Product write flags are enabled. This page still does not send products.")
              : text(t, "elryanWarrantyWritesOff", "Product writes stay off. This page does not send products.")}
          </p>
        </form>
      </div>
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl bg-cream px-4 py-3">
      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums text-brown">{value}</p>
    </div>
  );
}

function WarrantyCatalog({ t, state, items, shared, notSupplied }) {
  if (!state) return null;
  if (state.failed) {
    return (
      <div className="rounded-[1.5rem] bg-cream px-4 py-4 text-sm font-semibold text-amber-900">
        <p>{text(t, "elryanWarrantyFailed", "The warranty list could not be loaded.")}</p>
        <p className="mt-2 font-medium">{state.message}</p>
        {state.httpStatus ? <p className="mt-1">HTTP {state.httpStatus}</p> : null}
      </div>
    );
  }
  if (state.empty) {
    return (
      <div className="rounded-[1.5rem] bg-cream px-4 py-4 text-sm font-semibold text-brown">
        {state.message || text(t, "elryanWarrantyEmpty", "The Staging API returned an empty warranty list. No warranty code was invented.")}
      </div>
    );
  }
  const pagination = state.pagination;
  return (
    <div className="rounded-[1.5rem] bg-white p-4 ring-1 ring-brown/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-xl text-brown">{text(t, "elryanWarrantyOfficial", "Official Elryan warranties")}</h3>
        {pagination ? (
          <p className="text-xs font-semibold text-brown/50">
            {pagination.mode === "paged"
              ? `${pagination.pagesFetched} pages · ${pagination.total ?? items.length}`
              : text(t, "elryanWarrantySingleResponse", "Returned in one response. Pagination meta was not supplied.")}
          </p>
        ) : null}
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm text-brown">
          <thead className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
            <tr>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyName", "Warranty name")}</th>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyCode", "Warranty code")}</th>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyDuration", "Duration")}</th>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyTerms", "Terms")}</th>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyStatus", "Status")}</th>
              <th className="py-2">{text(t, "elryanWarrantyShared", "Brands")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.code} className="border-t border-brown/10">
                <td className="py-2 pr-3 font-semibold">{item.name || notSupplied}</td>
                <td className="py-2 pr-3">
                  {item.code}
                  {item.id ? <span className="mt-1 block text-xs text-brown/50">{item.id}</span> : null}
                </td>
                <td className="py-2 pr-3">{supplied(item.duration, notSupplied)}</td>
                <td className="py-2 pr-3">
                  <div>{supplied(item.terms, notSupplied)}</div>
                  {item.returnPolicy ? <div className="mt-1 text-brown/70">{item.returnPolicy}</div> : null}
                  {item.provider ? <div className="mt-1 text-xs text-brown/50">{item.provider}</div> : null}
                </td>
                <td className="py-2 pr-3">{supplied(item.status, notSupplied)}</td>
                <td className="py-2">{shared.get(item.code) || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
