import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import ElryanMappingPager from "./ElryanMappingPager";
import {
  elryanCatalogPageWindow,
  elryanValueAttribute,
  elryanValueRowStatus,
  mergeElryanValueDrafts,
} from "../../../utils/elryanValueMappingPage";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON = "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";

function selectedText(id, label, placeholder) {
  const name = String(label || "").trim();
  const valueId = String(id || "").trim();
  if (name && valueId) return `${name} · ${valueId}`;
  return name || valueId || placeholder;
}

function CatalogSelect({ attribute, selectedId, selectedLabel, onSelect, disabled, t }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(30);
  const [total, setTotal] = useState(0);
  const [values, setValues] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef(null);
  const requestRef = useRef(0);

  async function load(nextPage, nextQuery, ticket) {
    setBusy(true);
    setError("");
    try {
      const data = await api.elryanAttributeValues(attribute, {
        page: nextPage,
        limit: 30,
        search: String(nextQuery || "").trim() || undefined,
      });
      if (ticket !== requestRef.current) return;
      setValues(Array.isArray(data.values) ? data.values.filter((row) => row?.verifiedId) : []);
      setPage(Number(data.page) || nextPage);
      setLimit(Number(data.limit) || 30);
      setTotal(Number(data.total) || 0);
    } catch (err) {
      if (ticket !== requestRef.current) return;
      setValues([]);
      setTotal(0);
      setError(err.message);
    } finally {
      if (ticket === requestRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return undefined;
    const ticket = ++requestRef.current;
    const handle = setTimeout(() => {
      load(1, query, ticket);
    }, 200);
    return () => clearTimeout(handle);
  }, [open, query, attribute]);

  useEffect(() => {
    if (!open) return undefined;
    function onPointer(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const window = elryanCatalogPageWindow({ page, limit, total });

  function move(nextPage) {
    const ticket = ++requestRef.current;
    load(nextPage, query, ticket);
  }

  return (
    <div ref={rootRef} className="relative">
      <label className="block text-[11px] font-semibold tracking-wide text-brown/45 uppercase md:sr-only">
        {t.elryanValueElryan}
      </label>
      <input
        className={`${CONTROL} mt-1 md:mt-0`}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        placeholder={t.elryanValueSearchPlaceholder}
        value={open ? query : selectedText(selectedId, selectedLabel, "")}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
      />
      {open ? (
        <div className="absolute z-20 mt-2 w-full rounded-2xl bg-white p-2 shadow-lg ring-1 ring-brown/10">
          <div role="listbox" className="max-h-60 space-y-1 overflow-auto">
            {values.map((row) => {
              const id = String(row.verifiedId);
              const active = id === String(selectedId || "");
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`block w-full rounded-xl px-3 py-2 text-start text-sm ${
                    active ? "bg-brown text-cream" : "text-brown hover:bg-cream"
                  }`}
                  onClick={() => {
                    onSelect({ verifiedId: id, name: String(row.name || "") });
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span className="font-semibold">{row.name}</span>
                  <span className="mt-0.5 block text-xs opacity-80" dir="ltr">{id}</span>
                </button>
              );
            })}
            {!busy && !values.length ? (
              <p className="px-3 py-2 text-sm text-brown/55">{error || t.elryanValueNoMatches}</p>
            ) : null}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button type="button" className={BUTTON} disabled={busy || !window.hasPrevious} onClick={() => move(page - 1)}>
              {t.elryanValuePrevious}
            </button>
            <button type="button" className={BUTTON} disabled={busy || !window.hasNext} onClick={() => move(page + 1)}>
              {t.elryanValueNext}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function ElryanValueMapping({ t, kind }) {
  const attribute = elryanValueAttribute(kind);
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [environment, setEnvironment] = useState("staging");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [savingKey, setSavingKey] = useState("");
  const loadTicket = useRef(0);
  const queryKey = useRef(null);
  const environmentRef = useRef("");
  const kindRef = useRef(kind);
  const brand = kind === "brand";

  async function load({ replace = false, ticket = loadTicket.current, page: nextPage = page, limit: nextLimit = limit, q = appliedQuery } = {}) {
    const data = await api.elryanPairMapping(kind, { q, page: nextPage, limit: nextLimit });
    if (ticket !== loadTicket.current) return data;
    const nextEnvironment = data.environment === "production" ? "production" : "staging";
    if (environmentRef.current && environmentRef.current !== nextEnvironment && nextPage !== 1) {
      environmentRef.current = nextEnvironment;
      setEnvironment(nextEnvironment);
      setPage(1);
      return data;
    }
    environmentRef.current = nextEnvironment;
    const options = data.options || [];
    setRows(options);
    setEnvironment(nextEnvironment);
    setTotal(Number(data.total) || 0);
    setPages(Number(data.pages) || 1);
    if (Number(data.page) && Number(data.page) !== nextPage) setPage(Number(data.page));
    setDrafts((current) => mergeElryanValueDrafts(replace ? {} : current, options));
    setLoadError("");
    setLoaded(true);
    return data;
  }

  useEffect(() => {
    const handle = setTimeout(() => setAppliedQuery(query.trim()), 250);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    const kindChanged = kindRef.current !== kind;
    kindRef.current = kind;
    if (kindChanged) {
      setDrafts({});
      setQuery("");
      environmentRef.current = "";
      if (appliedQuery !== "") setAppliedQuery("");
      if (page !== 1) setPage(1);
      if (limit !== 25) setLimit(25);
      if (appliedQuery !== "" || page !== 1 || limit !== 25) return;
    }
    const key = `${kind}\0${appliedQuery}\0${limit}`;
    const reset = queryKey.current !== key;
    queryKey.current = key;
    const nextPage = reset ? 1 : page;
    if (reset && page !== 1) {
      setPage(1);
      return;
    }
    const ticket = ++loadTicket.current;
    load({
      replace: kindChanged,
      ticket,
      page: nextPage,
      limit,
      q: kindChanged ? "" : appliedQuery,
    }).catch((err) => {
      if (ticket !== loadTicket.current) return;
      setLoadError(err.message);
      setLoaded(true);
    });
    // load reads the latest page through its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, appliedQuery, page, limit]);
  const title = brand ? t.elryanBrandMappingTitle : t.elryanColourMappingTitle;
  const hint = brand ? t.elryanBrandMappingHint : t.elryanColourMappingHint;
  const brownHeading = brand ? t.elryanValueBrownBrand : t.elryanValueBrownColour;
  const empty = brand ? t.elryanValueEmptyBrands : t.elryanValueEmptyColours;

  function choose(row, value) {
    setDrafts((current) => {
      const previous = current[row.brownKey] || {};
      return {
        ...current,
        [row.brownKey]: {
          ...previous,
          elryanId: String(value.verifiedId || ""),
          elryanLabel: String(value.name || ""),
          saveError: "",
        },
      };
    });
  }

  async function save(row) {
    const draft = drafts[row.brownKey];
    const elryanId = String(draft?.elryanId || "").trim();
    if (!elryanId || savingKey) return;
    setSavingKey(row.brownKey);
    setDrafts((current) => ({
      ...current,
      [row.brownKey]: { ...current[row.brownKey], saveError: "" },
    }));
    try {
      await api.saveElryanValueMapping({
        kind,
        environment,
        brownKey: row.brownKey,
        brownLabel: row.brownLabel,
        elryanId,
        elryanLabel: String(draft?.elryanLabel || ""),
      });
      await load({ ticket: loadTicket.current });
    } catch (err) {
      setDrafts((current) => ({
        ...current,
        [row.brownKey]: {
          ...(current[row.brownKey] || draft),
          elryanId,
          elryanLabel: String(draft?.elryanLabel || ""),
          saveError: err.message || t.elryanValueSaveFailed,
        },
      }));
    } finally {
      setSavingKey("");
    }
  }

  return (
    <section className="space-y-6" data-elryan-value-mapping={kind} data-elryan-environment={environment}>
      <div>
        <h2 className="font-display text-2xl text-brown">{title}</h2>
        <p className="mt-2 max-w-3xl text-sm text-brown/70">{hint}</p>
        <p className="mt-2 text-sm font-semibold text-brown">
          {environment === "production" ? t.elryanValueProductionBanner : t.elryanValueStagingBanner}
        </p>
      </div>

      <label className="block max-w-md text-sm font-semibold text-brown">
        {t.elryanValueFilter}
        <input className={`${CONTROL} mt-2`} value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>

      {loadError ? <p className="text-sm font-semibold text-red-700">{loadError}</p> : null}

      <div className="hidden gap-3 px-4 text-[11px] font-semibold tracking-wide text-brown/45 uppercase md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_minmax(9rem,0.8fr)]">
        <span>{brownHeading}</span>
        <span>{t.elryanValueElryan}</span>
        <span>{t.elryanValueSave}</span>
        <span>{t.elryanValueStatus}</span>
      </div>

      <ElryanMappingPager
        t={t}
        page={page}
        pages={pages}
        total={total}
        limit={limit}
        onPage={setPage}
        onLimit={setLimit}
      />

      <div className="space-y-3">
        {rows.map((row) => {
          const draft = drafts[row.brownKey] || {
            elryanId: row.mapping?.elryanId || "",
            elryanLabel: row.mapping?.elryanLabel || "",
            saveError: "",
          };
          const status = elryanValueRowStatus({
            savedId: row.mapping?.elryanId || "",
            draftId: draft.elryanId,
            saveError: draft.saveError,
          });
          const saving = savingKey === row.brownKey;
          return (
            <article
              key={row.brownKey}
              className="rounded-3xl bg-white p-4 ring-1 ring-brown/10"
              data-brown-key={row.brownKey}
              data-mapping-status={status.kind}
            >
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_minmax(9rem,0.8fr)] md:items-center">
                <div>
                  <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase md:sr-only">{brownHeading}</p>
                  <p className="text-sm font-semibold text-brown">{row.brownLabel}</p>
                  <p className="mt-1 text-xs text-brown/50" dir="ltr">{row.brownKey}</p>
                </div>
                <CatalogSelect
                  attribute={attribute}
                  selectedId={draft.elryanId}
                  selectedLabel={draft.elryanLabel}
                  disabled={Boolean(savingKey)}
                  t={t}
                  onSelect={(value) => choose(row, value)}
                />
                <button
                  type="button"
                  className={BUTTON}
                  disabled={Boolean(savingKey) || !String(draft.elryanId || "").trim()}
                  onClick={() => save(row)}
                >
                  {t.elryanValueSave}
                </button>
                <div>
                  <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase md:sr-only">{t.elryanValueStatus}</p>
                  {status.kind === "confirmed" ? (
                    <span className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
                      {t.elryanValueConfirmed}
                    </span>
                  ) : null}
                  {status.kind === "unsaved" ? (
                    <span className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">
                      {t.elryanValueUnsaved}
                    </span>
                  ) : null}
                  {status.kind === "error" ? (
                    <p className="text-sm font-semibold text-red-700" role="alert">{status.message}</p>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
        {loaded && !loadError && !rows.length ? <p className="text-sm text-brown/55">{empty}</p> : null}
      </div>
    </section>
  );
}
