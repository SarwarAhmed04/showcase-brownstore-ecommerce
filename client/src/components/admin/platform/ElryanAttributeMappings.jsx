import { useEffect, useMemo, useState } from "react";
import { api } from "../../../api";

const CONTROL =
  "w-full rounded-2xl border border-brown/10 bg-cream px-3 py-2 text-sm text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";

function matches(row, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${row.brownLabel} ${row.brownKey} ${row.mapping?.elryanLabel || ""} ${row.mapping?.elryanId || ""}`
    .toLowerCase()
    .includes(needle);
}

function PairMapper({ t, kind, title, hint, elryanAttribute, brownHeading, elryanHeading }) {
  const [page, setPage] = useState(null);
  const [brownQuery, setBrownQuery] = useState("");
  const [elryanQuery, setElryanQuery] = useState("");
  const [elryanPage, setElryanPage] = useState(1);
  const [catalog, setCatalog] = useState(null);
  const [brownKey, setBrownKey] = useState("");
  const [elryanId, setElryanId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadPairs() {
    const data = await api.elryanPairMapping(kind);
    setPage(data);
    return data;
  }

  async function loadCatalog(pageNumber = 1, query = elryanQuery) {
    const data = await api.elryanAttributeValues(elryanAttribute, {
      page: pageNumber,
      limit: 30,
      search: query.trim() || undefined,
    });
    setCatalog(data);
    setElryanPage(Number(data.page) || pageNumber);
  }

  useEffect(() => {
    loadPairs().catch((err) => setError(err.message));
    loadCatalog(1, "").catch((err) => setError(err.message));
  }, [kind]);

  const options = page?.options || [];
  const visible = useMemo(() => options.filter((row) => matches(row, brownQuery)), [options, brownQuery]);
  const selected = options.find((row) => row.brownKey === brownKey) || null;
  const values = catalog?.values || [];
  const selectedValue = values.find((row) => String(row.verifiedId) === elryanId) || null;
  const total = Number(catalog?.total) || 0;
  const limit = Number(catalog?.limit) || 30;
  const hasPrev = elryanPage > 1;
  const hasNext = elryanPage * limit < total;

  function chooseBrown(nextKey) {
    const row = options.find((item) => item.brownKey === nextKey) || null;
    setBrownKey(nextKey);
    setElryanId(row?.mapping?.elryanId || "");
    setMessage("");
    setError("");
  }

  async function searchElryan(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await loadCatalog(1, elryanQuery);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function moveCatalog(nextPage) {
    setBusy(true);
    setError("");
    try {
      await loadCatalog(nextPage, elryanQuery);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!selected || !selectedValue?.verifiedId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.saveElryanValueMapping({
        kind,
        environment: page?.environment,
        brownKey: selected.brownKey,
        brownLabel: selected.brownLabel,
        elryanId: String(selectedValue.verifiedId),
        elryanLabel: String(selectedValue.name || ""),
      });
      setMessage(t.elryanMappingSaved || "Mapping saved.");
      const data = await loadPairs();
      const saved = (data.options || []).find((row) => row.brownKey === selected.brownKey);
      setElryanId(saved?.mapping?.elryanId || String(selectedValue.verifiedId));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-[1.75rem] bg-white p-5 ring-1 ring-brown/10">
      <div>
        <h3 className="font-display text-xl text-brown">{title}</h3>
        <p className="mt-2 max-w-3xl text-sm text-brown/65">{hint}</p>
        <p className="mt-2 text-xs font-semibold text-brown/50">
          {page?.environment === "production" ? "Production" : "Staging"}
        </p>
      </div>
      {error ? <p className="text-sm font-semibold text-amber-900">{error}</p> : null}
      {message ? <p className="text-sm font-semibold text-brown">{message}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <label className="block text-sm font-semibold text-brown">
            {brownHeading}
            <input
              className={`${CONTROL} mt-2`}
              value={brownQuery}
              onChange={(event) => setBrownQuery(event.target.value)}
            />
          </label>
          <div className="mt-3 max-h-80 space-y-2 overflow-auto">
            {visible.map((row) => (
              <button
                key={row.brownKey}
                type="button"
                onClick={() => chooseBrown(row.brownKey)}
                className={`block w-full rounded-2xl px-3 py-2 text-left text-sm ${
                  row.brownKey === brownKey ? "bg-brown text-cream" : "bg-cream text-brown"
                }`}
              >
                <span className="font-semibold">{row.brownLabel}</span>
                <span className="mt-1 block text-xs opacity-80">
                  {row.brownKey}
                  {row.mapping ? ` · ${row.mapping.elryanLabel || row.mapping.elryanId} · ${row.mapping.elryanId}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <form onSubmit={searchElryan}>
            <label className="block text-sm font-semibold text-brown">
              {elryanHeading}
              <input
                className={`${CONTROL} mt-2`}
                value={elryanQuery}
                onChange={(event) => setElryanQuery(event.target.value)}
              />
            </label>
            <button type="submit" className={`${BUTTON} mt-2`} disabled={busy}>
              {t.categorySearch || "Search"}
            </button>
          </form>
          <div className="mt-3 max-h-80 space-y-2 overflow-auto">
            {values.map((row) => (
              <button
                key={row.verifiedId}
                type="button"
                onClick={() => setElryanId(String(row.verifiedId))}
                className={`block w-full rounded-2xl px-3 py-2 text-left text-sm ${
                  String(row.verifiedId) === elryanId ? "bg-brown text-cream" : "bg-cream text-brown"
                }`}
              >
                <span className="font-semibold">{row.name}</span>
                <span className="mt-1 block text-xs opacity-80">{row.verifiedId}</span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className={BUTTON} disabled={busy || !hasPrev} onClick={() => moveCatalog(elryanPage - 1)}>
              {t.elryanPrevious || "Previous"}
            </button>
            <button type="button" className={BUTTON} disabled={busy || !hasNext} onClick={() => moveCatalog(elryanPage + 1)}>
              {t.elryanNext || "Next"}
            </button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-brown">
          {selected ? selected.brownLabel : "—"} ↔ {selectedValue?.name || selected?.mapping?.elryanLabel || "—"}
          {selected?.mapping?.elryanId ? ` · ${selected.mapping.elryanId}` : ""}
        </p>
        <button type="button" className={BUTTON} disabled={busy || !selected || !selectedValue?.verifiedId} onClick={save}>
          {t.elryanMappingSaved ? "Save" : "Save"}
        </button>
      </div>
    </section>
  );
}

export default function ElryanAttributeMappings({ t }) {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">{t.elryanAttributesTitle}</p>
        <p className="mt-2 max-w-3xl text-sm text-brown/60">
          {t.elryanAttributesHint ||
            "Choose an Elryan value and a BrownStore value, then save the verified id for this environment."}
        </p>
      </div>
      <PairMapper
        t={t}
        kind="color"
        title={t.elryanColourMappingTitle || "Colour mapping"}
        hint={t.elryanColourMappingHint || "Search both catalogues. Example: Elryan Black ↔ BrownStore black."}
        elryanAttribute="Color"
        brownHeading={t.elryanBrownStoreColour || "BrownStore colour"}
        elryanHeading={t.elryanElryanColour || "Elryan colour"}
      />
      <PairMapper
        t={t}
        kind="brand"
        title={t.elryanBrandMappingTitle || "Brand mapping"}
        hint={t.elryanBrandMappingHint || "Search both catalogues. Example: Elryan Kenwood ↔ BrownStore Kenwood."}
        elryanAttribute="Brand"
        brownHeading={t.elryanBrownStoreBrand || "BrownStore brand"}
        elryanHeading={t.elryanElryanBrand || "Elryan brand"}
      />
    </div>
  );
}
