import { useEffect, useState } from "react";
import { api } from "../../../api";
import { canSendGiniVariantSync, canSendVariantChangedSync, variantSyncStatusLabel } from "./giniVariantSyncDisplay";
import GiniVariantPilotPanel from "./GiniVariantPilotPanel";
import GiniKe20PricePatchPanel from "./GiniKe20PricePatchPanel";
import GiniEi8888PricePatchPanel from "./GiniEi8888PricePatchPanel";
import GiniVariantStockPatchPanel from "./GiniVariantStockPatchPanel";

const FILTERS = [
  ["", "All"],
  ["READY_FOR_REVIEW", "Ready for review"],
  ["NEEDS_REVIEW", "Needs review"],
  ["BLOCKED", "Blocked"],
  ["APPROVED_FOR_FUTURE_SYNC", "Approved, not sent"],
  ["VERIFIED_REMOTE", "Verified"],
  ["UNCERTAIN", "Uncertain"],
];

function Count({ label, value }) {
  return (
    <div className="rounded-2xl bg-cream/60 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-brown/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-brown">{Number(value || 0).toLocaleString("en-US")}</p>
    </div>
  );
}

function commissionText(rule) {
  if (!rule) return "no saved commission rule";
  const name = rule.targetName ? ` · ${rule.targetName}` : "";
  return `${rule.percentage}% ${rule.scope || "rule"}${name}`;
}

export default function GiniVariantSyncPanel() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [dryRun, setDryRun] = useState(null);

  async function load(next = status) {
    setBusy(true);
    setError("");
    try {
      setData(await api.giniVariantSync(next, 1));
    } catch (err) {
      setError(err.message || "Failed to load the variant preview");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load(status);
  }, [status]);

  const summary = data?.summary || {};
  return (
    <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl text-brown">Variant Sync</h2>
          <p className="mt-1 max-w-2xl text-sm text-brown/70">
            Dry-run preview. Approving a mapping stores it locally and does not send anything to GINI.
          </p>
        </div>
        <button type="button" disabled className="rounded-full bg-brown/20 px-4 py-2 text-sm font-semibold text-brown/50" title="Sending is not enabled">
          Send is off
        </button>
      </div>
      <div className="mt-5 rounded-2xl bg-cream/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-brown">Changed sync dry run</h3>
            <p className="mt-1 max-w-2xl text-sm text-brown/70">
              Reads the six reconciled parents and compares them with BrownStore. It does not send creates, updates, or deletions.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream disabled:bg-brown/30"
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setDryRun(await api.giniVariantChangedPreview());
              } catch (err) {
                setError(err.message || "Dry run failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Run dry-run preview
          </button>
        </div>
        {dryRun ? (
          <div className="mt-4 space-y-3 text-sm text-brown/80">
            <p>
              Sending is {canSendVariantChangedSync() || dryRun.canSend ? "on" : "off"}. Bulk variant writes are {dryRun.bulkSyncEnabled ? "on" : "off"}.
            </p>
            <p>
              New {dryRun.summary?.new || 0} · Changed {dryRun.summary?.changed || 0} · Unchanged {dryRun.summary?.unchanged || 0} · Blocked {dryRun.summary?.blocked || 0} · Uncertain {dryRun.summary?.uncertain || 0}
            </p>
            <p>
              Duplicate parents {dryRun.summary?.duplicateParent || 0} · Missing color or size {dryRun.summary?.missingColorOrSize || 0} · Missing ownership {dryRun.summary?.missingOwnership || 0} · Missing SKU approval {dryRun.summary?.missingSkuApproval || 0}
            </p>
            <p>{dryRun.futureBulk?.note}</p>
            {dryRun.pricePilot ? (
              <article className="rounded-xl bg-white p-3">
                <p className="font-semibold text-brown">
                  One-product price pilot: {dryRun.pricePilot.ready ? `${dryRun.pricePilot.label} · ${dryRun.pricePilot.parentSku}` : "not ready"}
                </p>
                <p>
                  Approval is {dryRun.pricePilot.approved ? "recorded locally" : "still required"}. Sending is off. Batch execution is {dryRun.pricePilot.batchEnabled ? "on" : "off"}.
                </p>
                {dryRun.pricePilot.ready && !dryRun.pricePilot.approved ? (
                  <button
                    type="button"
                    disabled={busy}
                    className="mt-2 rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream disabled:bg-brown/30"
                    onClick={async () => {
                      setBusy(true);
                      setNotice("");
                      setError("");
                      try {
                        const saved = await api.giniVariantPricePilotApprove({ parentSku: dryRun.pricePilot.parentSku, confirm: true });
                        setNotice(saved.sentToGini === 0 ? `Local approval saved for ${saved.parentSku || dryRun.pricePilot.parentSku}. No price was sent.` : "Unexpected send");
                        setDryRun(await api.giniVariantChangedPreview());
                      } catch (err) {
                        setError(err.message || "Pilot approval failed");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Record pilot approval locally
                  </button>
                ) : null}
                {(dryRun.pricePilot.variants || []).map((row) => (
                  <p key={`${row.sku}-pilot`}>
                    {row.sku}: {row.oldPrice} → {row.newPrice} IQD. Stock {row.oldStock} → {row.newStock}. {commissionText(row.commission)}
                  </p>
                ))}
                {(dryRun.pricePilot.preserved || []).length ? (
                  <p>Left unchanged: {dryRun.pricePilot.preserved.map((row) => `${row.sku} ${row.oldPrice} / qty ${row.oldStock}`).join(", ")}.</p>
                ) : null}
              </article>
            ) : null}
            <p>
              Simple sync stays on its existing workflow
              {dryRun.overview?.simple?.available
                ? `: ready ${dryRun.overview.simple.readyCreate}, existing ${dryRun.overview.simple.alreadyExists}, changed ${dryRun.overview.simple.changed}, unchanged ${dryRun.overview.simple.unchanged}, blocked ${dryRun.overview.simple.blocked}.`
                : ". A stored simple preview was not found."}
            </p>
            <p>
              Color attribute {dryRun.colorAttribute?.id || "unread"} {dryRun.colorAttribute?.state}. Returned values: {dryRun.colorAttribute?.valueCount || 0}.
            </p>
            {dryRun.missingColors?.length ? (
              <p>Missing colors, with no invented ids: {dryRun.missingColors.map((row) => `${row.color} (${row.productCount})`).join(", ")}</p>
            ) : null}
            <ul className="space-y-2">
              {(dryRun.unsupported || []).map((item) => (
                <li key={item.operation}>{item.operation}: {item.status}</li>
              ))}
            </ul>
            {(dryRun.pilots || []).map((pilot) => (
              <article key={pilot.parentSku} className="rounded-xl bg-white p-3">
                <p className="font-semibold text-brown">{pilot.label} · {pilot.parentSku} · {pilot.disposition}</p>
                <p>
                  Remote {pilot.remote?.id || "—"} · {pilot.remote?.state} · {pilot.remote?.visibility || "visibility unverified"} · quantity {pilot.remote?.quantity ?? "—"} · variants {pilot.remote?.variantCount ?? "—"}
                  {pilot.remote?.categoryId ? ` · category ${pilot.remote.categoryId}/${pilot.remote.subcategoryId || "—"}` : ""}
                </p>
                {pilot.remote?.variants?.length ? (
                  <ul className="mt-1">
                    {pilot.remote.variants.map((row) => (
                      <li key={row.sku}>
                        {row.sku} · {row.color || "color unverified"} · {row.price ?? "—"} · qty {row.quantity ?? "—"} · attribute {row.attributeId || "not returned"} · images {row.images?.state === "present" ? row.images.urls.length : "not returned"}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {pilot.blockers?.length ? <p className="text-red-800">{pilot.blockers.join(", ")}</p> : null}
                {pilot.priceRows?.length ? (
                  <ul className="mt-1 space-y-1">
                    {pilot.priceRows.map((row) => (
                      <li key={`${row.sku}-price`}>
                        {row.sku}: price {row.oldPrice ?? "—"} → {row.newPrice ?? "—"} · stock {row.oldStock ?? "—"} → {row.newStock ?? "—"} · {commissionText(row.commission)}
                        {row.preserved ? " · preserved" : ""}
                        {row.withheldReason ? ` · withheld ${row.withheldReason}` : ""}
                        {row.patch?.rawBody ? <span className="block font-mono text-xs">{row.patch.method} {row.patch.path} {row.patch.rawBody}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {pilot.differences?.length ? (
                  <ul>{pilot.differences.map((row, index) => <li key={`${row.code}-${row.sku}-${index}`}>{row.detail}</li>)}</ul>
                ) : <p>No price, quantity, color, or category differences.</p>}
                {pilot.imageNotes?.length ? (
                  <p>Image note: {pilot.imageNotes.map((row) => `${row.sku} has ${row.localImages} local images and ${row.remoteImages} remote variant image`).join("; ")}. No image write is proposed.</p>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </div>
      <GiniKe20PricePatchPanel />
      <GiniEi8888PricePatchPanel />
      <GiniVariantStockPatchPanel />
      <GiniVariantPilotPanel />
      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {notice ? <p className="mt-4 text-sm font-semibold text-brown">{notice}</p> : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Count label="Multi-variant products" value={summary.total} />
        <Count label="Ready for review" value={summary.readyForReview} />
        <Count label="Awaiting category mapping" value={summary.awaitingCategory} />
        <Count label="Awaiting attribute mapping" value={summary.awaitingAttribute} />
        <Count label="Duplicate parent SKU" value={summary.duplicateParent} />
        <Count label="Awaiting vendor ownership" value={summary.awaitingOwnership} />
        <Count label="Missing variant SKU approval" value={summary.missingSkuApproval} />
        <Count label="Existing remote parent" value={summary.existingRemoteParent} />
        <Count label="Verified and unchanged" value={summary.verifiedUnchanged} />
        <Count label="Blocked" value={summary.blocked} />
        <Count label="Uncertain operations" value={summary.uncertain} />
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {FILTERS.map(([id, label]) => (
          <button
            key={id || "all"}
            type="button"
            onClick={() => setStatus(id)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${status === id ? "bg-brown text-cream" : "bg-cream text-brown"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-5 space-y-4">
        {busy && !data ? <p className="text-sm text-brown/60">Loading preview…</p> : null}
        {(data?.products || []).map((product) => (
          <article key={product.productId} className="rounded-2xl ring-1 ring-brown/10 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold text-brown">{product.name || product.parentSku}</h3>
              <span className="text-xs font-semibold uppercase text-brown/60">{variantSyncStatusLabel(product.status)}</span>
            </div>
            <p className="mt-1 text-sm text-brown/70">
              {product.vendor} · SKU {product.parentSku} · category {product.categoryId || "—"} / {product.subcategoryId || "—"}
            </p>
            <p className="mt-2 text-xs text-brown/60">
              Intended action: {product.intendedAction}. Sending is {canSendGiniVariantSync() ? "on" : "off"}. Live category check: {product.mappingLiveStatus}.
            </p>
            {product.blockers?.length ? <p className="mt-2 text-sm text-red-800">{product.blockers.join(", ")}</p> : null}
            <ul className="mt-3 space-y-1 text-sm text-brown/80">
              {(product.combinations || []).map((row) => (
                <li key={`${row.sourceVariantId}-${row.sourceSizeId}`}>
                  {row.color} / {row.size} · stock {row.stock} · price {row.price ?? "—"} · proposed {row.proposedSku || "—"} · attribute {row.attributeId || "unmapped"} · images {row.images}
                </li>
              ))}
            </ul>
            {product.remoteParent?.giniProductId ? (
              <p className="mt-2 text-sm text-brown">Remote parent {product.remoteParent.giniProductId}, visibility {product.remoteParent.visibility || "unverified"}.</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {product.status === "READY_FOR_REVIEW" ? (
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream"
                  onClick={async () => {
                    setBusy(true);
                    setNotice("");
                    try {
                      const saved = await api.giniVariantApproveSkus({
                        productId: product.productId,
                        confirm: true,
                        combinations: product.combinations.map((row) => ({ sourceVariantId: row.sourceVariantId, sourceSizeId: row.sourceSizeId, sku: row.proposedSku })),
                      });
                      setNotice(saved.code === "approved_for_future_sync" ? "Saved locally. Nothing was sent." : saved.code);
                      await load(status);
                    } catch (err) {
                      setError(err.message || "Approval failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Approve SKUs locally
                </button>
              ) : null}
              {product.status === "NEEDS_REVIEW" ? (
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream"
                  onClick={async () => {
                    setBusy(true);
                    setNotice("");
                    try {
                      const saved = await api.giniVariantApproveOwner({ productId: product.productId, confirm: true });
                      setNotice(saved.sentToGini === 0 ? "Owner saved locally. The other vendor product was not merged or sent." : "Unexpected send");
                      await load(status);
                    } catch (err) {
                      setError(err.message || "Ownership approval failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Choose this vendor as owner
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
