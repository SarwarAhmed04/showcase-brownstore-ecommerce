import { useEffect, useState } from "react";
import { api } from "../../../api";
import { pilotStageAllowed } from "./giniVariantSyncDisplay";

const BUTTON = "rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream disabled:bg-brown/20 disabled:text-brown/50";

export default function GiniVariantPilotPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmParent, setConfirmParent] = useState("");
  const [confirmVariants, setConfirmVariants] = useState("");

  async function load() {
    setBusy(true);
    setError("");
    try {
      setData(await api.giniVariantPilot());
    } catch (err) {
      setError(err.message || "The pilot preview could not be read");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function approveSkus(product) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const saved = await api.giniVariantApproveSkus({
        productId: product.productId,
        confirm: true,
        combinations: product.combinations.map((row) => ({ sourceVariantId: row.sourceVariantId, sourceSizeId: row.sourceSizeId, sku: row.proposedSku })),
      });
      setNotice(saved.sentToGini === 0 ? "Variant SKUs were saved locally. Nothing was sent." : "Unexpected send");
      await load();
    } catch (err) {
      setError(err.message || "SKU approval failed");
    } finally {
      setBusy(false);
    }
  }

  async function runStage(product, stage) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await api.giniVariantPilotStage({ productId: product.productId, stage, confirm: true });
      setNotice(`${product.parentSku}: ${result.code || "done"}. Sent ${result.sentToGini || 0}.`);
      if (result.code === "pilot_stopped_uncertain" || result.ok === false) setError(result.code || "The pilot stopped");
      await load();
    } catch (err) {
      setError(err.message || "The pilot stage did not run");
    } finally {
      setBusy(false);
    }
  }

  const writesEnabled = data?.writesEnabled === true;
  return (
    <section className="mt-6 rounded-3xl bg-cream/40 p-5 ring-1 ring-brown/10" data-gini-variant-pilot="true">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-xl text-brown">5-product live pilot</h3>
          <p className="mt-1 max-w-3xl text-sm text-brown/70">
            Separate from the catalog preview. Five products run one at a time. Bulk send is not available. The write gate is {writesEnabled ? "on" : "off"}.
          </p>
        </div>
        <button type="button" className={BUTTON} disabled={busy} onClick={load}>
          {busy ? "Reading" : "Refresh pilot preview"}
        </button>
      </div>
      {data?.categoryCounts ? (
        <p className="mt-3 text-sm text-brown/70">
          Category mappings: {data.categoryCounts.configured} configured, {data.categoryCounts.missing} missing, of {data.categoryCounts.total}.
          {data.catalogSummary ? ` Multi-variant products: ${data.catalogSummary.total}. Ready for review: ${data.catalogSummary.readyForReview}. Duplicate parent SKUs: ${data.catalogSummary.duplicateParent}.` : ""}
        </p>
      ) : null}
      {data?.colorAttribute ? (
        <p className="mt-1 text-sm text-brown/70">
          Color attribute {data.colorAttribute.id} live values: {(data.colorAttribute.values || []).join(", ") || "unread"}.
        </p>
      ) : null}
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-brown/80">
        {(data?.steps || []).map((step) => <li key={step}>{step}</li>)}
      </ol>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm font-semibold text-brown">{notice}</p> : null}
      <div className="mt-4 space-y-4">
        {(data?.products || []).map((product) => {
          const parentAllowed = pilotStageAllowed({
            writesEnabled,
            queue: product.queue,
            ready: product.stageAReady,
            confirmed: confirmParent === product.productId,
            busy,
          });
          const variantsAllowed = pilotStageAllowed({
            writesEnabled,
            queue: product.queue,
            ready: product.stageBReady,
            confirmed: confirmVariants === product.productId,
            busy,
          });
          return (
            <article key={`${product.order}-${product.parentSku}`} className="rounded-2xl bg-white p-4 ring-1 ring-brown/10">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="font-semibold text-brown">{product.order}. {product.name || product.parentSku}</h4>
                <span className="text-xs font-semibold uppercase text-brown/60">{product.queue}</span>
              </div>
              <p className="mt-1 text-sm text-brown/70">
                {product.vendor || "Vendor not chosen"} · SKU {product.parentSku} · category {product.categoryId || "—"} / {product.subcategoryId || "—"} · remote {product.remote?.state || "unread"}
              </p>
              {product.blockers?.length ? <p className="mt-2 text-sm text-red-800">{product.blockers.join(", ")}</p> : null}
              <ul className="mt-2 space-y-1 text-sm text-brown/80">
                {(product.combinations || []).map((row) => (
                  <li key={`${row.sourceVariantId}-${row.sourceSizeId}`}>
                    {row.color} → {row.giniColor || "unmapped"} · stock {row.stock} · price {row.price ?? "—"} · proposed {row.proposedSku || "—"} · images {row.images}
                  </li>
                ))}
              </ul>
              {product.ownerRequired ? (
                <p className="mt-3 text-sm text-brown/70">Vendor ownership is selected in Vendor ownership selection. Saving an owner is off, and the other listing stays in BrownStore.</p>
              ) : null}
              {product.productId && product.blockers?.includes("missing_variant_sku_approval") ? (
                <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => approveSkus(product)}>
                  Approve these SKUs locally
                </button>
              ) : null}
              {product.productId ? (
                <div className="mt-3 space-y-2 text-sm text-brown/80">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={confirmParent === product.productId} onChange={(event) => setConfirmParent(event.target.checked ? product.productId : "")} />
                    I confirm Stage A for {product.parentSku} only
                  </label>
                  <button type="button" className={BUTTON} disabled={!parentAllowed} onClick={() => runStage(product, "parent")}>
                    Confirm hidden parent
                  </button>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={confirmVariants === product.productId} onChange={(event) => setConfirmVariants(event.target.checked ? product.productId : "")} />
                    I confirm Stage B for {product.parentSku} only
                  </label>
                  <button type="button" className={BUTTON} disabled={!variantsAllowed} onClick={() => runStage(product, "variants")}>
                    Confirm variants
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
