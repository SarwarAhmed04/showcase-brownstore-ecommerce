import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import {
  elryanCategoryDisplayName,
  elryanCategoryParentKind,
  formatElryanChildrenLoadError,
  resolveElryanCategoryId,
  shouldFetchElryanCategoryChildren,
} from "../../../utils/elryanCategoryBrowse";
import {
  elryanCatalogStatusSummary,
  normalizeElryanCatalogWarnings,
} from "../../../utils/elryanCatalogStatusUi";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const BUTTON =
  "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";
const BUTTON_GHOST =
  "rounded-full border border-brown/15 bg-white px-4 py-2.5 text-sm font-semibold text-brown disabled:opacity-50";
const PAGE_SIZE = 50;

function kindLabel(kind, t) {
  if (kind === "leaf") return t.elryanCategoryLeaf;
  if (kind === "parent") return t.elryanCategoryParent;
  return t.elryanCategoryKindUnknown;
}

function CategoryMeta({ row, t }) {
  const id = resolveElryanCategoryId(row);
  const name = elryanCategoryDisplayName(row) || (id != null ? String(id) : "—");
  const kind = elryanCategoryParentKind(row);
  const hierarchy = row?.hierarchy != null && row.hierarchy !== "" ? String(row.hierarchy) : "";
  const level = row?.level != null && row.level !== "" ? String(row.level) : "";
  const attrSet =
    row?.attributeSetId != null && row.attributeSetId !== ""
      ? String(row.attributeSetId)
      : row?.attributeSet
        ? String(row.attributeSet)
        : "";

  return (
    <div className="space-y-1">
      <p className="font-semibold text-brown">{name}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-brown/55">
        <dt>{t.elryanCategoryIdLabel}</dt>
        <dd className="text-brown/70">{id != null ? String(id) : "—"}</dd>
        {hierarchy ? (
          <>
            <dt>{t.elryanCategoryHierarchyLabel}</dt>
            <dd className="text-brown/70">{hierarchy}</dd>
          </>
        ) : null}
        <dt>{t.elryanCategoryKindLabel}</dt>
        <dd className="text-brown/70">{kindLabel(kind, t)}</dd>
        {level ? (
          <>
            <dt>{t.elryanCategoryLevelLabel}</dt>
            <dd className="text-brown/70">{level}</dd>
          </>
        ) : null}
        {attrSet ? (
          <>
            <dt>{t.elryanAttributeSetLabel}</dt>
            <dd className="text-brown/70">{attrSet}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

export default function ElryanCatalogBrowse({ t }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [children, setChildren] = useState([]);
  const [leafNotice, setLeafNotice] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogMsg, setCatalogMsg] = useState("");
  const requestSeq = useRef(0);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);

  const refreshCatalogStatus = useCallback(async () => {
    try {
      const status = await api.elryanCategoryCatalogStatus();
      if (!mountedRef.current) return status;
      // Guard: status must never include a full categories dump in React state.
      if (Array.isArray(status?.categories) && status.categories.length > 0) {
        const { categories: _drop, ...safe } = status;
        setCatalogStatus(safe);
        return safe;
      }
      setCatalogStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refreshCatalogStatus();
    return () => {
      mountedRef.current = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [refreshCatalogStatus]);

  async function loadCategories(nextPage = page) {
    const seq = ++requestSeq.current;
    setBusy(true);
    setError("");
    setLeafNotice(false);
    try {
      const data = await api.elryanCategories({
        search: search.trim() || undefined,
        limit: PAGE_SIZE,
        page: nextPage,
      });
      if (seq !== requestSeq.current) return;
      setRows(data.categories || []);
      setMeta(data.meta || null);
      setPage(Number(data.page) || nextPage);
      setSelected(null);
      setChildren([]);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err.message);
      setRows([]);
      setMeta(null);
    } finally {
      if (seq === requestSeq.current) setBusy(false);
    }
  }

  async function openCategory(row) {
    setSelected(row);
    setChildren([]);
    setError("");
    setLeafNotice(false);

    const id = resolveElryanCategoryId(row);
    if (id == null) {
      setError(t.elryanCategoryIdMissing);
      return;
    }

    const kind = elryanCategoryParentKind(row);
    if (!shouldFetchElryanCategoryChildren(row)) {
      setLeafNotice(true);
      return;
    }

    setBusy(true);
    try {
      const data = await api.elryanCategoryChildren(id);
      setChildren(data.categories || []);
    } catch (err) {
      setChildren([]);
      setError(
        formatElryanChildrenLoadError({
          kind,
          categoryId: id,
          status: err.status,
          code: err.code,
          message: err.message,
        })
      );
    } finally {
      setBusy(false);
    }
  }

  function startCatalogPoll() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await refreshCatalogStatus();
        if (!mountedRef.current) return;
        if (!status?.running) {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setCatalogBusy(false);
          if (status?.status === "complete") setCatalogMsg(t.elryanCatalogSyncComplete);
          else if (status?.status === "cancelled") setCatalogMsg(t.elryanCatalogSyncCancelled);
          else if (status?.error) setCatalogMsg(String(status.error));
        }
      } catch (err) {
        if (!mountedRef.current) return;
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setCatalogBusy(false);
        setCatalogMsg(err?.message || t.elryanCatalogSyncFailed);
      }
    }, 1500);
  }

  async function startFullCatalogSync() {
    setCatalogMsg("");
    const scope = catalogStatus?.scope;
    const confirmed = window.confirm(
      [
        t.elryanCatalogSyncConfirm,
        scope
          ? `Env: ${scope.environment} · limit ${scope.pageLimit} · max pages ${scope.maxPages} · max records ${scope.maxRecords}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    if (!confirmed) return;
    setCatalogBusy(true);
    try {
      const status = await api.elryanCategoryCatalogSync({ confirm: true });
      setCatalogStatus(status);
      startCatalogPoll();
    } catch (err) {
      setCatalogBusy(false);
      setCatalogMsg(err.message);
    }
  }

  async function cancelFullCatalogSync() {
    setCatalogBusy(true);
    try {
      const status = await api.elryanCategoryCatalogCancel();
      setCatalogStatus(status);
    } catch (err) {
      setCatalogMsg(err.message);
    } finally {
      setCatalogBusy(false);
    }
  }

  const total = meta?.total;
  const limit = meta?.limit || PAGE_SIZE;
  const totalPages =
    total != null && Number.isFinite(Number(total)) && limit
      ? Math.max(1, Math.ceil(Number(total) / limit))
      : null;
  const canPrev = page > 1 && !busy;
  const canNext =
    !busy &&
    (totalPages != null ? page < totalPages : rows.length >= PAGE_SIZE);

  return (
    <div className="space-y-8">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.elryanCategoriesTitle}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-brown/60">{t.elryanCategoriesHint}</p>
      </div>

      <section className="space-y-3 rounded-[1.5rem] bg-white p-4 ring-1 ring-brown/10">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-tan">
          {t.elryanFullCatalogTitle}
        </p>
        <p className="text-sm text-brown/60">{t.elryanFullCatalogHint}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={catalogBusy || catalogStatus?.running}
            onClick={startFullCatalogSync}
          >
            {catalogStatus?.running ? t.elryanCatalogSyncRunning : t.elryanFetchFullCatalog}
          </button>
          <button
            type="button"
            className={BUTTON_GHOST}
            disabled={!catalogStatus?.running}
            onClick={cancelFullCatalogSync}
          >
            {t.elryanCatalogSyncCancel}
          </button>
          <button type="button" className={BUTTON_GHOST} disabled={catalogBusy} onClick={refreshCatalogStatus}>
            {t.elryanCatalogRefresh}
          </button>
        </div>
        {(() => {
          const summary = elryanCatalogStatusSummary(catalogStatus);
          return summary.ready ? (
            <p className="text-xs text-brown/55">
              {t.elryanCatalogStatus}: {summary.line}
            </p>
          ) : null;
        })()}
        {normalizeElryanCatalogWarnings(catalogStatus?.warnings).length ? (
          <ul className="list-disc ps-5 text-xs text-amber-900">
            {normalizeElryanCatalogWarnings(catalogStatus.warnings)
              .slice(0, 5)
              .map((w, index) => (
                <li key={`${index}-${w.slice(0, 48)}`}>{w}</li>
              ))}
          </ul>
        ) : null}
        {catalogMsg ? <p className="text-sm text-brown/70">{catalogMsg}</p> : null}
      </section>

      <div className="flex max-w-xl flex-wrap gap-2">
        <input
          className={`${CONTROL} flex-1`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t.search}
          onKeyDown={(event) => {
            if (event.key === "Enter") loadCategories(1);
          }}
        />
        <button type="button" className={BUTTON} disabled={busy} onClick={() => loadCategories(1)}>
          {busy ? t.loading : t.elryanLoadCategories}
        </button>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-3 text-xs text-brown/55">
        <span>
          {t.elryanPageLabel} {page}
          {totalPages != null ? ` / ${totalPages}` : ""}
        </span>
        {total != null ? (
          <span>
            {t.elryanTotalResults}: {total}
          </span>
        ) : meta && !meta.reliable ? (
          <span>{t.elryanMetaUnreliable}</span>
        ) : null}
        <button type="button" className={BUTTON_GHOST} disabled={!canPrev} onClick={() => loadCategories(page - 1)}>
          {t.elryanPrevPage}
        </button>
        <button type="button" className={BUTTON_GHOST} disabled={!canNext} onClick={() => loadCategories(page + 1)}>
          {t.elryanNextPage}
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ul className="max-h-[28rem] space-y-2 overflow-auto rounded-[1.5rem] bg-white p-4 ring-1 ring-brown/10">
          {(rows || []).map((row, index) => {
            const id = resolveElryanCategoryId(row) ?? index;
            const name = elryanCategoryDisplayName(row) || String(id);
            const kind = elryanCategoryParentKind(row);
            return (
              <li key={String(id)}>
                <button
                  type="button"
                  className="w-full rounded-2xl px-3 py-2 text-left text-sm hover:bg-cream"
                  onClick={() => openCategory(row)}
                >
                  <span className="font-semibold text-brown">{name}</span>
                  <span className="mt-1 block text-xs text-brown/45">
                    {t.elryanCategoryIdLabel} {String(id)}
                    {" · "}
                    {kindLabel(kind, t)}
                    {row.level != null && row.level !== "" ? ` · ${t.elryanCategoryLevelLabel} ${row.level}` : ""}
                    {row.attributeSetId != null ? ` · AS ${row.attributeSetId}` : ""}
                  </span>
                  {row.hierarchy ? (
                    <span className="mt-0.5 block text-xs text-brown/40">{String(row.hierarchy)}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
          {!rows.length ? <li className="text-sm text-brown/45">{t.elryanNoCategoriesYet}</li> : null}
        </ul>

        <div className="rounded-[1.5rem] bg-cream/50 p-4 ring-1 ring-brown/10">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-tan">
            {t.elryanCategoryChildren}
          </p>
          {selected ? (
            <div className="mt-2">
              <CategoryMeta row={selected} t={t} />
            </div>
          ) : null}
          <ul className="mt-3 max-h-[22rem] space-y-2 overflow-auto text-sm">
            {leafNotice ? (
              <li className="text-brown/55">{t.elryanCategoryNoSubcategories}</li>
            ) : null}
            {!leafNotice
              ? (children || []).map((row, index) => {
                  const id = resolveElryanCategoryId(row) ?? index;
                  const childKind = elryanCategoryParentKind(row);
                  return (
                    <li key={String(id)} className="rounded-xl bg-white px-3 py-2 ring-1 ring-brown/5">
                      <p className="font-medium text-brown">
                        {elryanCategoryDisplayName(row) || id}
                      </p>
                      <p className="mt-0.5 text-xs text-brown/45">
                        {t.elryanCategoryIdLabel} {String(id)} · {kindLabel(childKind, t)}
                      </p>
                    </li>
                  );
                })
              : null}
            {!leafNotice && selected && !children.length && !error && !busy ? (
              <li className="text-brown/45">{t.elryanNoChildren}</li>
            ) : null}
          </ul>
          <p className="mt-4 text-xs text-brown/50">{t.elryanMappingViaCategorySetup}</p>
        </div>
      </div>
    </div>
  );
}
