import { useEffect, useState } from "react";
import { api } from "../../../api";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const BUTTON_GHOST =
  "rounded-full border border-brown/15 bg-white px-4 py-2.5 text-sm font-semibold text-brown disabled:opacity-50";

const EMPTY = {
  kind: "brand",
  brownKey: "",
  brownLabel: "",
  elryanId: "",
  elryanCode: "",
  elryanLabel: "",
};

export default function ElryanAttributeMappings({ t }) {
  const [mappings, setMappings] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [searchAttr, setSearchAttr] = useState("Brand");
  const [remoteSearch, setRemoteSearch] = useState("");
  const [remotePage, setRemotePage] = useState(1);
  const [remoteLimit] = useState(30);
  const [remotePayload, setRemotePayload] = useState(null);
  const [idLookup, setIdLookup] = useState("");
  const [idVerified, setIdVerified] = useState(false);

  async function refresh() {
    const data = await api.elryanValueMappings();
    setMappings(data.mappings || []);
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setIdVerified(false);
  }, [form.elryanId, form.kind]);

  const needsValueId = form.kind === "brand" || form.kind === "color";
  const canSave =
    !busy &&
    form.brownKey.trim() &&
    (form.kind === "warranty"
      ? Boolean(form.elryanCode.trim())
      : Boolean(form.elryanId.trim()) && idVerified);

  async function onSave(event) {
    event.preventDefault();
    if (!canSave) {
      setError(
        t.elryanVerifiedIdRequired ||
          "Brand/colour mapping requires a verified Elryan value id. Names alone are not enough."
      );
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.saveElryanValueMapping(form);
      setForm(EMPTY);
      setIdVerified(false);
      setMessage(t.elryanMappingSaved);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadRemote(page = 1) {
    setBusy(true);
    setError("");
    try {
      const data = await api.elryanAttributeValues(searchAttr, {
        page,
        limit: remoteLimit,
        search: remoteSearch.trim() || undefined,
      });
      setRemotePayload(data);
      setRemotePage(Number(data.page) || page);
      if (data.note) setMessage(data.note);
    } catch (err) {
      setError(err.message);
      setRemotePayload(null);
    } finally {
      setBusy(false);
    }
  }

  async function lookupById() {
    const id = (idLookup.trim() || form.elryanId.trim());
    if (!id) {
      setError(t.elryanValueIdRequired || "Enter an Elryan value id to look up.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    setIdVerified(false);
    try {
      const attribute = form.kind === "color" ? "Color" : "Brand";
      const expectedName =
        form.elryanLabel.trim() || form.brownLabel.trim() || remoteSearch.trim() || undefined;
      const data = await api.elryanAttributeValueVerify({
        attribute,
        valueId: id,
        name: expectedName,
        elryanLabel: expectedName,
      });
      const value = data.value || {};
      if (!data.ok || !value.idVerified || !value.verifiedId) {
        setError(
          t.elryanIdLookupUnverified ||
            "Lookup did not return a verified id. Mapping remains blocked."
        );
        return;
      }
      setForm((prev) => ({
        ...prev,
        elryanId: String(value.verifiedId),
        elryanLabel: String(value.name || prev.elryanLabel || ""),
      }));
      setIdLookup(String(value.verifiedId));
      setIdVerified(true);
      setMessage(
        t.elryanIdLookupOk ||
          "Elryan value id verified against the authenticated Brand/Color list. You may save the mapping."
      );
    } catch (err) {
      setIdVerified(false);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function applyRemoteRow(row) {
    if (row?.idVerified && row.verifiedId) {
      setForm((prev) => ({
        ...prev,
        elryanId: String(row.verifiedId),
        elryanLabel: String(row.name || prev.elryanLabel || ""),
      }));
      setIdVerified(true);
      setError("");
      setMessage(t.elryanVerifiedIdSelected || "Verified Elryan value id selected.");
      return;
    }
    // Name-only: fill searchable label, never invent an id.
    setForm((prev) => ({
      ...prev,
      elryanLabel: String(row?.name || prev.elryanLabel || ""),
      elryanId: "",
    }));
    setIdVerified(false);
    setMessage(
      t.elryanNameOnlySelected ||
        "Name copied for reference. No verified Elryan id was returned — mapping save stays blocked."
    );
  }

  const remoteValues = remotePayload?.values || [];
  const total = remotePayload?.total;
  const page = Number(remotePayload?.page) || remotePage;
  const limit = Number(remotePayload?.limit) || remoteLimit;
  const hasNext = total != null ? page * limit < total : remoteValues.length >= limit;
  const hasPrev = page > 1;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.elryanAttributesTitle}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-brown/60">{t.elryanAttributesHint}</p>
        <p className="mt-2 max-w-2xl text-xs font-semibold text-amber-900">
          {t.elryanBrandIdSafetyHint ||
            "Brand/colour saves require a verified Elryan value id. Search may return names only — never use list positions as ids."}
        </p>
      </div>

      <form
        onSubmit={onSave}
        className="grid max-w-3xl gap-3 rounded-[1.75rem] bg-white p-5 ring-1 ring-brown/10 md:grid-cols-2"
      >
        <div>
          <label className="mb-1 block text-xs font-semibold text-brown/50">{t.elryanMappingKind}</label>
          <select
            className={CONTROL}
            value={form.kind}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, kind: event.target.value, elryanId: "", elryanCode: "" }));
              setIdVerified(false);
            }}
          >
            <option value="brand">Brand</option>
            <option value="color">Colour</option>
            <option value="warranty">Warranty</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brown/50">{t.elryanBrownKey}</label>
          <input
            className={CONTROL}
            value={form.brownKey}
            onChange={(event) => setForm((prev) => ({ ...prev, brownKey: event.target.value }))}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brown/50">{t.elryanBrownLabel}</label>
          <input
            className={CONTROL}
            value={form.brownLabel}
            onChange={(event) => setForm((prev) => ({ ...prev, brownLabel: event.target.value }))}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brown/50">
            {t.elryanRemoteId}{" "}
            {needsValueId ? (
              <span className={idVerified ? "text-emerald-700" : "text-amber-800"}>
                ({idVerified ? t.elryanIdVerified || "verified" : t.elryanIdUnverified || "unverified"})
              </span>
            ) : null}
          </label>
          <input
            className={CONTROL}
            value={form.elryanId}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, elryanId: event.target.value }));
              setIdVerified(false);
            }}
            disabled={form.kind === "warranty"}
            placeholder={t.elryanRemoteIdPlaceholder || "Official Elryan value id only"}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brown/50">{t.elryanWarrantyCode}</label>
          <input
            className={CONTROL}
            value={form.elryanCode}
            onChange={(event) => setForm((prev) => ({ ...prev, elryanCode: event.target.value }))}
            disabled={form.kind !== "warranty"}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brown/50">{t.elryanRemoteLabel}</label>
          <input
            className={CONTROL}
            value={form.elryanLabel}
            onChange={(event) => setForm((prev) => ({ ...prev, elryanLabel: event.target.value }))}
          />
        </div>
        <div className="md:col-span-2 flex flex-wrap gap-2">
          <button type="submit" className={BUTTON} disabled={!canSave}>
            {busy ? t.loading : t.save}
          </button>
          {needsValueId && !idVerified ? (
            <span className="self-center text-xs text-amber-900">
              {t.elryanSaveBlockedNoId || "Save blocked until an Elryan value id is verified."}
            </span>
          ) : null}
        </div>
      </form>

      <div className="max-w-3xl space-y-3 rounded-[1.5rem] bg-cream/40 p-4 ring-1 ring-brown/10">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-tan">
          {t.elryanRemoteSearchTitle || "Remote Elryan values"}
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            className={`${CONTROL} max-w-[10rem]`}
            value={searchAttr}
            onChange={(event) => setSearchAttr(event.target.value)}
          >
            <option value="Brand">Brand</option>
            <option value="Color">Color</option>
          </select>
          <input
            className={`${CONTROL} min-w-[12rem] flex-1`}
            value={remoteSearch}
            onChange={(event) => setRemoteSearch(event.target.value)}
            placeholder={t.elryanRemoteSearchPlaceholder || "Search name (e.g. INGCO)"}
          />
          <button type="button" className={BUTTON} disabled={busy} onClick={() => loadRemote(1)}>
            {busy ? t.loading : t.elryanSearchRemoteValues}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            className={`${CONTROL} min-w-[10rem] flex-1`}
            value={idLookup}
            onChange={(event) => setIdLookup(event.target.value)}
            placeholder={t.elryanLookupIdPlaceholder || "Look up official value id"}
          />
          <button type="button" className={BUTTON_GHOST} disabled={busy} onClick={lookupById}>
            {t.elryanLookupById || "Verify id"}
          </button>
        </div>

        {remotePayload ? (
          <p className="text-xs text-brown/55">
            {t.elryanTotalResults}: {total ?? "—"} · {t.elryanPageLabel} {page} · limit {limit}
            {remotePayload.idsAvailable === false
              ? ` · ${t.elryanIdsUnavailable || "no verified ids in this page"}`
              : remotePayload.verifiedIdCount != null
                ? ` · verified ids ${remotePayload.verifiedIdCount}`
                : ""}
          </p>
        ) : null}

        {remoteValues.length ? (
          <ul className="max-h-80 space-y-2 overflow-auto text-sm">
            {remoteValues.map((row, index) => {
              const key = row.verifiedId || `name:${row.name}:${index}`;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className="w-full rounded-xl bg-white px-3 py-2 text-left hover:ring-1 hover:ring-brown/15"
                    onClick={() => applyRemoteRow(row)}
                  >
                    <span className="font-semibold text-brown">{row.name || "—"}</span>
                    {row.idVerified ? (
                      <span className="ms-2 text-xs text-emerald-800">
                        ID {row.verifiedId} · {t.elryanIdVerified || "verified"}
                      </span>
                    ) : (
                      <span className="ms-2 text-xs text-amber-800">
                        {t.elryanNameOnly || "name only — no id"}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {remotePayload ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={BUTTON_GHOST}
              disabled={busy || !hasPrev}
              onClick={() => loadRemote(Math.max(1, page - 1))}
            >
              {t.elryanPrevPage}
            </button>
            <button
              type="button"
              className={BUTTON_GHOST}
              disabled={busy || !hasNext}
              onClick={() => loadRemote(page + 1)}
            >
              {t.elryanNextPage}
            </button>
          </div>
        ) : null}
      </div>

      <ul className="max-w-3xl space-y-2">
        {mappings.map((row) => (
          <li
            key={`${row.kind}:${row.brownKey}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white px-4 py-3 text-sm ring-1 ring-brown/10"
          >
            <div>
              <p className="font-semibold text-brown">
                {row.kind}: {row.brownLabel || row.brownKey}
              </p>
              <p className="text-xs text-brown/50">
                → {row.elryanLabel || row.elryanCode || row.elryanId}
                {row.elryanId ? ` · id ${row.elryanId}` : ""}
              </p>
            </div>
            <button
              type="button"
              className="text-xs font-semibold text-red-700"
              onClick={async () => {
                await api.deleteElryanValueMapping(row.kind, row.brownKey);
                await refresh();
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
