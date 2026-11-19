import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../api";
import ElryanMappingPager from "./ElryanMappingPager";
import {
  mergeVisibleBrandSnapshots,
  mergeWarrantySaveOutcomes,
  removeWarrantyBrand,
  saveSelectedWarrantyBrands,
  sharedWarrantyCounts,
  toggleWarrantyBrand,
  warrantyBatchReview,
  warrantyEmptyDescription,
  warrantyMappingDescription,
  warrantySaveReady,
} from "../../../utils/elryanWarrantyMappingPage";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON = "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST = "rounded-full border border-brown/15 bg-white px-4 py-2.5 text-sm font-semibold text-brown disabled:opacity-50";
const EMPTY_OUTCOMES = { confirmed: [], failed: [], retryBrandIds: [] };

function text(t, key, fallback) {
  return t?.[key] || fallback;
}

function supplied(value, emptyLabel) {
  if (value == null || value === "") return emptyLabel;
  return String(value);
}

function fillCount(template, count) {
  return String(template).replaceAll("{count}", String(count));
}

export default function ElryanWarrantyMapping({ t }) {
  const [page, setPage] = useState(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [tablePage, setTablePage] = useState(1);
  const [tableLimit, setTableLimit] = useState(25);
  const [selectedBrands, setSelectedBrands] = useState(() => new Map());
  const [warrantyCode, setWarrantyCode] = useState("");
  const [confirmCoverage, setConfirmCoverage] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [outcomes, setOutcomes] = useState(EMPTY_OUTCOMES);
  const [busy, setBusy] = useState(false);
  const queryKey = useRef(null);
  const environmentRef = useRef("");
  const requestRef = useRef(0);
  const busyRef = useRef(false);

  function clearConfirmations() {
    setConfirmCoverage(false);
    setConfirmOverwrite(false);
  }

  async function load({ q = appliedSearch, status: nextStatus = status, page: nextPage = tablePage, limit = tableLimit, ticket = requestRef.current } = {}) {
    const data = await api.elryanWarrantyMapping({
      q,
      status: nextStatus === "all" ? "" : nextStatus,
      page: nextPage,
      limit,
    });
    if (ticket !== requestRef.current) return data;
    const nextEnvironment = data.environment === "production" ? "production" : "staging";
    const environmentChanged = Boolean(environmentRef.current) && environmentRef.current !== nextEnvironment;
    if (environmentChanged) {
      setWarrantyCode("");
      setSelectedBrands(new Map());
      setOutcomes(EMPTY_OUTCOMES);
      clearConfirmations();
      setMessage("");
    }
    if (environmentChanged && nextPage !== 1) {
      environmentRef.current = nextEnvironment;
      setTablePage(1);
      return data;
    }
    environmentRef.current = nextEnvironment;
    setPage(data);
    if (!environmentChanged) {
      setSelectedBrands((current) => mergeVisibleBrandSnapshots(current, data.brands || []));
    }
    if (data.warranties?.ok === true && data.warranties.failed !== true) {
      setWarrantyCode((current) => {
        if (!current) return current;
        return (data.warranties.items || []).some((item) => item.code === current) ? current : "";
      });
    }
    if (Number(data.page) && Number(data.page) !== nextPage) setTablePage(Number(data.page));
    return data;
  }

  useEffect(() => {
    const handle = setTimeout(() => setAppliedSearch(search.trim()), 250);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    const key = `${appliedSearch}\0${status}\0${tableLimit}`;
    const reset = queryKey.current !== key;
    queryKey.current = key;
    const nextPage = reset ? 1 : tablePage;
    if (reset && tablePage !== 1) {
      setTablePage(1);
      return;
    }
    const ticket = ++requestRef.current;
    load({ q: appliedSearch, status, page: nextPage, limit: tableLimit, ticket }).catch((err) => {
      if (ticket !== requestRef.current) return;
      setError(err.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedSearch, status, tablePage, tableLimit]);

  const brands = page?.brands || [];
  const warrantyState = page?.warranties || null;
  const catalogOk = warrantyState?.ok === true && warrantyState.failed !== true && warrantyState.empty !== true;
  const environment = page?.environment === "production" ? "production" : page?.environment === "staging" ? "staging" : "";
  const shared = useMemo(() => {
    if (page?.sharedWarrantyCounts) return new Map(Object.entries(page.sharedWarrantyCounts));
    return sharedWarrantyCounts(brands);
  }, [page, brands]);
  const selectedWarranty = (warrantyState?.items || []).find((item) => item.code === warrantyCode) || null;
  const selectedList = useMemo(() => [...selectedBrands.values()], [selectedBrands]);
  const review = warrantyBatchReview({ brands: selectedList, warranty: selectedWarranty });
  const replacements = (review?.brands || []).map((brand) => brand.replaces).filter(Boolean);
  const canSave = warrantySaveReady({
    brandIds: selectedList.map((brand) => brand.brownKey),
    code: warrantyCode,
    confirmCoverage,
    replacements,
    confirmOverwrite,
    catalogOk,
  });
  const confirmedIds = useMemo(
    () => new Set((outcomes.confirmed || []).map((row) => row.brownKey)),
    [outcomes]
  );
  const failedById = useMemo(
    () => new Map((outcomes.failed || []).map((row) => [row.brownKey, row])),
    [outcomes]
  );
  const failedBrands = (outcomes.failed || [])
    .map((row) => selectedBrands.get(row.brownKey))
    .filter(Boolean);
  const retryReplacements = failedBrands
    .map((brand) => {
      const current = String(brand.warranty?.code || "");
      return current && current !== warrantyCode ? current : "";
    })
    .filter(Boolean);
  const retryReady = warrantySaveReady({
    brandIds: failedBrands.map((brand) => brand.brownKey),
    code: warrantyCode,
    confirmCoverage,
    replacements: retryReplacements,
    confirmOverwrite,
    catalogOk,
  });
  const notSupplied = text(t, "elryanWarrantyNotSupplied", "Not supplied");

  function chooseWarranty(code) {
    if (!code || code === warrantyCode) return;
    setWarrantyCode(code);
    setOutcomes(EMPTY_OUTCOMES);
    setMessage("");
    setError("");
    clearConfirmations();
  }

  function toggleBrand(row) {
    const removing = selectedBrands.has(row.brownKey);
    setSelectedBrands((current) => toggleWarrantyBrand(current, row));
    if (removing) {
      setOutcomes((current) => ({
        confirmed: current.confirmed.filter((item) => item.brownKey !== row.brownKey),
        failed: current.failed.filter((item) => item.brownKey !== row.brownKey),
        retryBrandIds: current.retryBrandIds.filter((id) => id !== row.brownKey),
      }));
    }
    setMessage("");
    clearConfirmations();
  }

  function removeBrand(brownKey) {
    setSelectedBrands((current) => removeWarrantyBrand(current, brownKey));
    setOutcomes((current) => ({
      confirmed: current.confirmed.filter((item) => item.brownKey !== brownKey),
      failed: current.failed.filter((item) => item.brownKey !== brownKey),
      retryBrandIds: (current.retryBrandIds || []).filter((id) => id !== brownKey),
    }));
    setMessage("");
    clearConfirmations();
  }

  async function refresh() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function saveBrands(brandRows, { retrying = false } = {}) {
    if (busyRef.current || !selectedWarranty || !brandRows.length) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await saveSelectedWarrantyBrands({
        brands: brandRows,
        warrantyCode: selectedWarranty.code,
        environment: page?.environment,
        confirmOverwrite,
        save: (body) => api.saveElryanWarrantyMapping(body),
      });
      setOutcomes((current) => (retrying ? mergeWarrantySaveOutcomes(current, result) : result));
      clearConfirmations();
      if (result.failed.length === 0) {
        setMessage(text(t, "elryanWarrantyReadBack", "Saved and read back from the database."));
      }
      try {
        await load();
      } catch (err) {
        setError(err.message);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function save(event) {
    event.preventDefault();
    if (!canSave || !selectedWarranty) return;
    saveBrands(selectedList);
  }

  function retryFailed() {
    if (!retryReady) return;
    saveBrands(failedBrands, { retrying: true });
  }

  const counts = page?.counts || {};
  const description = environment
    ? warrantyMappingDescription(
        environment,
        text(
          t,
          "elryanWarrantyMappingHint",
          "Map each BrownStore brand to one official Elryan {environment} warranty. Several brands may share one warranty. Nothing is saved until you review and confirm."
        )
      )
    : "";

  return (
    <section className="elryan-warranty-mapping space-y-6" data-elryan-warranty-page="true" data-elryan-warranty-environment={environment || "pending"}>
      <div>
        <h2 className="font-display text-2xl text-brown">{text(t, "elryanWarrantyMappingTitle", "Warranty Mapping")}</h2>
        {description ? (
          <p className="mt-2 max-w-3xl text-sm text-brown/70" data-elryan-warranty-description="true">
            {description}
          </p>
        ) : null}
        {environment === "production" ? (
          <p className="mt-2 text-sm font-semibold text-brown">
            {text(t, "elryanWarrantyProductionBanner", "Production. Staging warranties are not read or changed here.")}
          </p>
        ) : null}
        {environment === "staging" ? (
          <p className="mt-2 text-sm font-semibold text-brown">
            {text(t, "elryanWarrantyStagingBanner", "Staging. Production warranties are not read or changed here.")}
          </p>
        ) : null}
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

      <WarrantyCatalog
        t={t}
        state={warrantyState}
        items={warrantyState?.items || []}
        shared={shared}
        notSupplied={notSupplied}
        environment={environment}
        selectedCode={warrantyCode}
        onSelect={chooseWarranty}
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-[16rem] flex-1 text-sm font-semibold text-brown">
          {text(t, "elryanWarrantySearchBrands", "Search Brown Store brands")}
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
        <div className="space-y-3">
          <div className="rounded-[1.5rem] bg-white p-4 ring-1 ring-brown/10">
            <p className="text-sm font-semibold text-brown" data-elryan-warranty-selected-count={selectedBrands.size}>
              {fillCount(text(t, "elryanWarrantySelectedCount", "{count} selected"), selectedBrands.size)}
            </p>
            {selectedList.length ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {selectedList.map((brand) => (
                  <li key={brand.brownKey}>
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded-full bg-cream px-3 py-1.5 text-sm font-semibold text-brown"
                      data-elryan-warranty-chip={brand.brownKey}
                      onClick={() => removeBrand(brand.brownKey)}
                    >
                      <span>{brand.brownLabel}</span>
                      <span aria-hidden="true">×</span>
                      <span className="sr-only">{text(t, "elryanWarrantyRemove", "Remove")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-xs text-brown/55">
              {text(
                t,
                "elryanWarrantySelectionKeepsSaved",
                "Removing a brand from this selection does not delete its saved mapping."
              )}
            </p>
          </div>

          {brands.length ? (
            brands.map((row) => {
              const chosen = selectedBrands.has(row.brownKey);
              const failure = failedById.get(row.brownKey);
              const confirmed = confirmedIds.has(row.brownKey);
              return (
                <article
                  key={row.brownKey}
                  data-elryan-warranty-brand={row.brownKey}
                  data-elryan-warranty-brand-selected={chosen ? "true" : "false"}
                  className={`rounded-[1.5rem] bg-white p-4 ring-1 ${chosen ? "ring-brown" : "ring-brown/10"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-display text-xl text-brown">{row.brownLabel}</h3>
                      <p className="mt-1 text-xs font-semibold text-brown/50">
                        {text(t, "elryanWarrantyBrandId", "Brand ID")} {row.brownKey}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={chosen ? BUTTON : GHOST}
                      aria-pressed={chosen}
                      onClick={() => toggleBrand(row)}
                    >
                      {chosen ? (
                        <span>
                          <span aria-hidden="true">✓ </span>
                          {text(t, "elryanWarrantySelected", "Selected")}
                        </span>
                      ) : (
                        text(t, "elryanWarrantySelectAction", "Select")
                      )}
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
                  {confirmed ? (
                    <p className="mt-3 text-sm font-semibold text-green-700" data-elryan-warranty-confirmed={row.brownKey}>
                      {text(t, "elryanWarrantyConfirmed", "Confirmed")}
                    </p>
                  ) : null}
                  {failure ? (
                    <p className="mt-3 text-sm font-semibold text-amber-900" data-elryan-warranty-error={row.brownKey}>
                      {failure.message}
                    </p>
                  ) : null}
                </article>
              );
            })
          ) : (
            <p className="rounded-[1.5rem] bg-white px-4 py-6 text-sm text-brown/60 ring-1 ring-brown/10">
              {text(t, "elryanWarrantyNoBrands", "No BrownStore brands match this search.")}
            </p>
          )}
          <ElryanMappingPager
            t={t}
            page={page?.page || tablePage}
            pages={page?.pages || 1}
            total={page?.total || 0}
            limit={tableLimit}
            busy={busy}
            onPage={setTablePage}
            onLimit={setTableLimit}
          />
        </div>

        <form onSubmit={save} className="h-fit space-y-4 rounded-[1.75rem] bg-white p-5 ring-1 ring-brown/10">
          <h3 className="font-display text-xl text-brown">{text(t, "elryanWarrantySave", "Review & Save")}</h3>
          {review ? (
            <div className="rounded-2xl bg-cream px-4 py-3 text-sm text-brown" data-elryan-warranty-review="true">
              <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                {text(t, "elryanWarrantyReview", "Review")}
              </p>
              <p className="mt-2 font-semibold">{review.name || review.code}</p>
              <p className="mt-1 text-brown/70">
                {text(t, "elryanWarrantyCode", "Warranty code")} {review.code}
                {review.id ? ` · ${review.id}` : ""}
              </p>
              <p className="mt-2 text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                {text(t, "elryanWarrantyCoverage", "Coverage")}
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
              <ul className="mt-3 space-y-2">
                {review.brands.map((brand) => {
                  const failure = failedById.get(brand.brownKey);
                  return (
                    <li key={brand.brownKey} data-elryan-warranty-review-brand={brand.brownKey}>
                      <p className="font-semibold">
                        {brand.brownLabel}
                        <span className="ml-2 text-xs font-semibold text-brown/50">{brand.brownKey}</span>
                      </p>
                      {brand.replaces ? (
                        <p className="mt-1 font-semibold text-amber-900">
                          {text(t, "elryanWarrantyReplaces", "This replaces saved code")} {brand.replaces}
                        </p>
                      ) : null}
                      {confirmedIds.has(brand.brownKey) ? (
                        <p className="mt-1 font-semibold text-green-700">{text(t, "elryanWarrantyConfirmed", "Confirmed")}</p>
                      ) : null}
                      {failure ? <p className="mt-1 font-semibold text-amber-900">{failure.message}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-brown/60">
              {text(
                t,
                "elryanWarrantyReviewEmpty",
                "Choose one official warranty and at least one brand."
              )}
            </p>
          )}

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
                "I confirm this warranty coverage applies to the selected brands' relevant products."
              )}
            </span>
          </label>
          {replacements.length ? (
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
                  "I confirm replacing the saved warranty codes shown for these brands."
                )}
              </span>
            </label>
          ) : null}
          <button type="submit" className={BUTTON} disabled={!canSave || busy}>
            {text(t, "elryanWarrantySave", "Review & Save")}
          </button>
          {failedBrands.length ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-amber-900">
                {text(t, "elryanWarrantyPartialFailure", "These brands were not saved")}
              </p>
              <button type="button" className={GHOST} disabled={!retryReady || busy} onClick={retryFailed}>
                {text(t, "elryanWarrantyRetryFailed", "Retry failed brands")}
              </button>
            </div>
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

function WarrantyCatalog({ t, state, items, shared, notSupplied, environment, selectedCode, onSelect }) {
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
        {state.message ||
          warrantyEmptyDescription(
            environment,
            text(t, "elryanWarrantyEmpty", "The {environment} API returned an empty warranty list. No warranty code was invented.")
          )}
      </div>
    );
  }
  const pagination = state.pagination;
  const selected = items.find((item) => item.code === selectedCode) || null;
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
      {selected ? (
        <div
          className="mt-4 rounded-2xl bg-cream px-4 py-3 text-sm text-brown ring-2 ring-brown"
          data-elryan-warranty-selected={selected.code}
        >
          <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
            <span aria-hidden="true">✓ </span>
            {text(t, "elryanWarrantySelected", "Selected")}
          </p>
          <p className="mt-2 font-display text-xl">{selected.name || notSupplied}</p>
          <p className="mt-1 font-semibold">
            {text(t, "elryanWarrantyCode", "Warranty code")} {selected.code}
            {selected.id ? ` · ${selected.id}` : ""}
          </p>
          <p className="mt-3 text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
            {text(t, "elryanWarrantyCoverage", "Coverage")}
          </p>
          <p className="mt-1">
            {text(t, "elryanWarrantyDuration", "Duration")} {supplied(selected.duration, notSupplied)}
          </p>
          <p className="mt-1">
            {text(t, "elryanWarrantyTerms", "Terms")} {supplied(selected.terms, notSupplied)}
          </p>
          {selected.returnPolicy ? (
            <p className="mt-1">
              {text(t, "elryanWarrantyReturnPolicy", "Return policy")} {selected.returnPolicy}
            </p>
          ) : null}
          {selected.provider ? (
            <p className="mt-1">
              {text(t, "elryanWarrantyProvider", "Provider")} {selected.provider}
            </p>
          ) : null}
          <p className="mt-1">
            {text(t, "elryanWarrantyStatus", "Status")} {supplied(selected.status, notSupplied)}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-brown/60">
          {text(t, "elryanWarrantyChooseWarranty", "Choose one official warranty.")}
        </p>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm text-brown">
          <thead className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
            <tr>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyName", "Warranty name")}</th>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyCode", "Warranty code")}</th>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyDuration", "Duration")}</th>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyTerms", "Terms")}</th>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyStatus", "Status")}</th>
              <th className="py-2 pr-3">{text(t, "elryanWarrantyShared", "Brands")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const chosen = item.code === selectedCode;
              return (
                <tr
                  key={item.code}
                  data-elryan-warranty-option={item.code}
                  data-elryan-warranty-option-selected={chosen ? "true" : "false"}
                  className={chosen ? "border-t border-brown/10 bg-cream" : "border-t border-brown/10"}
                >
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
                  <td className="py-2 pr-3">{shared.get(item.code) || 0}</td>
                  <td className="py-2 text-right">
                    <button type="button" className={chosen ? BUTTON : GHOST} aria-pressed={chosen} onClick={() => onSelect(item.code)}>
                      {chosen ? (
                        <span>
                          <span aria-hidden="true">✓ </span>
                          {text(t, "elryanWarrantySelected", "Selected")}
                        </span>
                      ) : (
                        text(t, "elryanWarrantySelectAction", "Select")
                      )}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
