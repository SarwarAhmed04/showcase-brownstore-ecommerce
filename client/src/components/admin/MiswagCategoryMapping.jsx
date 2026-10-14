import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { tName } from "../../i18n";
import AdminModal from "./AdminModal";
import Spinner from "../Spinner";

const BUTTON = "rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream disabled:opacity-50";
const GHOST = "rounded-full bg-white px-4 py-2 text-sm font-semibold text-brown ring-1 ring-brown/10 disabled:opacity-50";

function formatWhen(value, never) {
  if (!value) return never;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return never;
  return date.toLocaleString();
}

function hierarchy(row, lang) {
  return [row.brownCategoryName, row.brownSubCategoryName, row.brownCollectionName]
    .map((name) => tName(name, lang))
    .filter(Boolean)
    .join(" / ");
}

function statusLabel(t, status) {
  if (status === "auto_mapped") return t.miswagAutoMapped;
  if (status === "verified") return t.miswagVerified;
  if (status === "needs_review") return t.miswagNeedsReview;
  return t.miswagUnmapped;
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-brown/5">
      <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl text-brown">{value}</p>
    </div>
  );
}

export default function MiswagCategoryMapping({ t, lang }) {
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState({ mappings: [], pagination: { page: 1, pages: 1, total: 0 } });
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const searchTimer = useRef(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState(null);
  const [choices, setChoices] = useState([]);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    Promise.all([
      api.miswagSellerMappingSummary(),
      api.miswagSellerMappings({ status, q, page, limit: 25 }),
    ])
      .then(([nextSummary, nextRows]) => {
        if (ignore) return;
        setSummary(nextSummary);
        setRows(nextRows);
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
  }, [status, q, page, reload]);

  useEffect(() => {
    if (!editor) return undefined;
    let ignore = false;
    const timer = setTimeout(() => {
      api
        .miswagSearchCategories(editor.q)
        .then((data) => {
          if (!ignore) setChoices(data.categories || []);
        })
        .catch((err) => {
          if (!ignore) setError(err.message);
        });
    }, 250);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [editor]);

  async function run(action, success) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      setMessage(success(result));
      setReload((value) => value + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const parsed = JSON.parse(await file.text());
      const result = await api.miswagImportCategories(parsed);
      setMessage(`${t.miswagCategoriesImported} ${result.fetched}`);
      setReload((value) => value + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const diagnostics = summary?.diagnostics || rows.diagnostics || {};
  const filters = [
    ["", t.miswagFilterAll],
    ["mapped", t.miswagMapped],
    ["auto_mapped", t.miswagAutoMapped],
    ["verified", t.miswagVerified],
    ["needs_review", t.miswagNeedsReview],
    ["unmapped", t.miswagUnmapped],
  ];

  return (
    <section className="min-w-0">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t.miswagCollections} value={summary?.collections ?? "—"} />
        <Stat label={t.miswagMapped} value={summary?.mapped ?? "—"} />
        <Stat label={t.miswagAutoMapped} value={summary?.autoMapped ?? "—"} />
        <Stat label={t.miswagVerified} value={summary?.verified ?? "—"} />
        <Stat label={t.miswagNeedsReview} value={summary?.needsReview ?? "—"} />
        <Stat label={t.miswagUnmapped} value={summary?.unmapped ?? "—"} />
        <Stat label={t.miswagCategories} value={summary?.miswagCategories ?? "—"} />
        <Stat label={t.miswagLastCategorySync} value={formatWhen(summary?.lastCategorySync, t.miswagNever)} />
        <Stat label={t.miswagTotalProducts} value={diagnostics.totalProducts ?? "—"} />
        <Stat label={t.miswagProductsWithCollection} value={diagnostics.productsWithCollection ?? "—"} />
        <Stat label={t.miswagDistinctCollections} value={diagnostics.distinctCollections ?? "—"} />
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={busy} onClick={() => run(() => api.miswagSellerHealth(), () => t.miswagConnectionOk)}>
          {t.miswagTestConnection}
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => run(() => api.miswagSyncCategories(), (result) => `${t.miswagCategoriesSynced} ${result.fetched}`)}>
          {t.miswagSyncCategories}
        </button>
        <label className={`${GHOST} cursor-pointer ${busy ? "opacity-50" : ""}`}>
          {t.miswagImportCategories}
          <input type="file" accept="application/json,.json" className="hidden" disabled={busy} onChange={importFile} />
        </label>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => run(() => api.miswagRunMapping(), () => t.miswagMappingFinished)}>
          {t.miswagRunMapping}
        </button>
      </div>
      <p className="mt-3 text-sm text-brown/50">{t.miswagImportHint}</p>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mt-3 text-sm text-brown/70">{message}</p> : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {filters.map(([id, label]) => (
          <button
            key={id || "all"}
            type="button"
            onClick={() => {
              setStatus(id);
              setPage(1);
            }}
            className={status === id ? BUTTON : GHOST}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        value={search}
        onChange={(event) => {
          const value = event.target.value;
          setSearch(value);
          clearTimeout(searchTimer.current);
          searchTimer.current = setTimeout(() => {
            setPage(1);
            setQ(value.trim());
          }, 250);
        }}
        placeholder={t.miswagSearchMappings}
        className="mt-4 w-full rounded-full border border-brown/10 bg-white px-4 py-2.5 text-sm text-brown outline-none"
      />

      {loading ? (
        <div className="mt-8 flex justify-center"><Spinner /></div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-3xl bg-white shadow-sm ring-1 ring-brown/5">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="text-xs tracking-wide text-brown/45 uppercase">
              <tr>
                <th className="px-4 py-3">{t.miswagHierarchy}</th>
                <th className="px-4 py-3">{t.miswagProductCount}</th>
                <th className="px-4 py-3">{t.miswagSuggestedCategory}</th>
                <th className="px-4 py-3">{t.miswagPath}</th>
                <th className="px-4 py-3">{t.miswagConfidence}</th>
                <th className="px-4 py-3">{t.miswagStatus}</th>
                <th className="px-4 py-3">{t.miswagActions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.mappings?.length ? rows.mappings.map((row) => (
                <tr key={row.brownCollectionId} className="border-t border-brown/5 align-top">
                  <td className="px-4 py-3">{hierarchy(row, lang)}</td>
                  <td className="px-4 py-3">{row.productCount}</td>
                  <td className="px-4 py-3">{row.externalCategoryName || "—"}</td>
                  <td className="px-4 py-3">{row.externalPath || "—"}</td>
                  <td className="px-4 py-3">{row.confidence || 0}</td>
                  <td className="px-4 py-3">{statusLabel(t, row.status)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={GHOST} onClick={() => setEditor({ row, q: "", selected: row.externalCategoryId || "" })}>
                        {row.externalCategoryId ? t.miswagChange : t.miswagReview}
                      </button>
                      <button
                        type="button"
                        className={GHOST}
                        disabled={busy || !row.externalCategoryId || row.status === "verified"}
                        onClick={() => run(() => api.miswagSellerVerifyMapping(row.brownCollectionId), () => t.miswagMappingVerified)}
                      >
                        {t.miswagVerify}
                      </button>
                      <button
                        type="button"
                        className={GHOST}
                        disabled={busy}
                        onClick={() => run(
                          () => api.miswagRunCollectionMapping(row.brownCollectionId),
                          (result) => (result.skippedVerified ? t.miswagVerifiedLocked : t.miswagMappingFinished)
                        )}
                      >
                        {t.miswagRerun}
                      </button>
                    </div>
                  </td>
                </tr>
              )) : (
                <tr><td className="px-4 py-6 text-brown/50" colSpan={7}>{t.miswagNoMappings}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between text-sm">
        <button type="button" className={GHOST} disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t.miswagPrev}</button>
        <span>{page} / {rows.pagination?.pages || 1}</span>
        <button type="button" className={GHOST} disabled={page >= (rows.pagination?.pages || 1)} onClick={() => setPage((value) => value + 1)}>{t.miswagNext}</button>
      </div>

      {editor ? (
        <AdminModal onClose={() => setEditor(null)}>
          <div className="w-full max-w-lg rounded-3xl bg-cream p-6">
            <h3 className="font-display text-2xl">{t.miswagManualTitle}</h3>
            <p className="mt-2 text-sm text-brown/55">{hierarchy(editor.row, lang)}</p>
            <input
              value={editor.q}
              onChange={(event) => setEditor({ ...editor, q: event.target.value })}
              placeholder={t.miswagSearchCategories}
              className="mt-4 w-full rounded-full border border-brown/10 bg-white px-4 py-2.5 text-sm"
            />
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
              {choices.length ? choices.map((category) => (
                <button
                  key={category.externalId}
                  type="button"
                  onClick={() => setEditor({ ...editor, selected: category.externalId })}
                  className={`block w-full rounded-2xl px-3 py-2 text-left text-sm ${editor.selected === category.externalId ? "bg-brown text-cream" : "bg-white text-brown"}`}
                >
                  <span className="font-semibold">{category.nameEn || category.nameAr || category.alias}</span>
                  <span className="mt-1 block text-xs opacity-70">{category.path || category.externalId}</span>
                </button>
              )) : <p className="text-sm text-brown/50">{t.miswagNoCategories}</p>}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className={GHOST}
                disabled={busy || !editor.selected}
                onClick={() => run(async () => {
                  await api.miswagAssignMapping(editor.row.brownCollectionId, { externalCategoryId: editor.selected });
                  setEditor(null);
                }, () => t.miswagMappingSaved)}
              >
                {t.miswagSaveMapping}
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy || !editor.selected}
                onClick={() => run(async () => {
                  await api.miswagAssignMapping(editor.row.brownCollectionId, {
                    externalCategoryId: editor.selected,
                    verify: true,
                  });
                  setEditor(null);
                }, () => t.miswagMappingVerified)}
              >
                {t.miswagSaveAndVerify}
              </button>
            </div>
          </div>
        </AdminModal>
      ) : null}
    </section>
  );
}
