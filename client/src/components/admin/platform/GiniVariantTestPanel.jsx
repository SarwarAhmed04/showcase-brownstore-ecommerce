import { useState } from "react";
import { api } from "../../../api";
import { canConfirmGiniVariantStage, describeGiniVariantStages, GINI_VARIANT_TEST_PRODUCT_ID } from "./giniVariantTestDisplay.js";

const BUTTON = "rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50";

export default function GiniVariantTestPanel() {
  const [preview, setPreview] = useState(null);
  const [stageResult, setStageResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmParent, setConfirmParent] = useState(false);
  const [confirmVariants, setConfirmVariants] = useState(false);
  const [acceptUniqueness, setAcceptUniqueness] = useState(false);
  const writesEnabled = preview?.writesEnabled === true;
  const parentReady = canConfirmGiniVariantStage({ stage: "parent", preview, confirmed: confirmParent, busy, writesEnabled });
  const variantsReady = canConfirmGiniVariantStage({
    stage: "variants",
    preview,
    confirmed: confirmVariants,
    acceptUniqueness,
    busy,
    writesEnabled,
  });
  const stages = describeGiniVariantStages({ preview, confirmParent, confirmVariants, acceptUniqueness, busy, writesEnabled });

  async function runPreview() {
    setBusy(true);
    setError("");
    setPreview(null);
    setStageResult(null);
    try {
      setPreview(await api.giniVariantTestPreview(GINI_VARIANT_TEST_PRODUCT_ID));
    } catch (err) {
      setError(err.message || "The variant preview could not be read.");
    } finally {
      setBusy(false);
    }
  }

  async function runStage(stage) {
    setBusy(true);
    setError("");
    setStageResult(null);
    try {
      const result = stage === "parent"
        ? await api.giniVariantTestStageA(GINI_VARIANT_TEST_PRODUCT_ID, true)
        : await api.giniVariantTestStageB(GINI_VARIANT_TEST_PRODUCT_ID, true, true);
      setStageResult(result);
      setPreview(await api.giniVariantTestPreview(GINI_VARIANT_TEST_PRODUCT_ID));
    } catch (err) {
      setError(err.message || "The variant stage did not run.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5" data-gini-variant-test-panel="true">
      <h2 className="text-lg font-semibold text-brown">GINI variant test</h2>
      <p className="mt-2 text-sm text-brown/70">
        Two-stage test for Jawal Flex product {GINI_VARIANT_TEST_PRODUCT_ID}, parent SKU 75244. IT Lobby stays out. Stage A and Stage B each have their own checks and confirmation.
      </p>
      <button type="button" className={`${BUTTON} mt-4`} disabled={busy} onClick={runPreview}>
        {busy ? "Reading" : "Preview parent and variants"}
      </button>
      {error ? <p className="mt-3 text-sm font-semibold text-red-700">{error}</p> : null}
      {preview ? (
        <div className="mt-4 space-y-3 text-sm text-brown">
          <p>Write gate: {preview.writesEnabled ? "on" : "off"}. Operation: {preview.operationStatus || "idle"}. Parent on GINI: {preview.parentRemoteState || "unread"}.</p>
          <h3 className="font-semibold">Stage A</h3>
          <p>Stage A: {stages.parentStatus}.</p>
          {stages.parentBlockerMessages.length ? stages.parentBlockerMessages.map((message) => <p key={message}>{message}</p>) : <p>Stage A blockers: none.</p>}
          <h3 className="font-semibold">Stage B</h3>
          <p>Stage B: {stages.variantStatus}.</p>
          {stages.variantBlockerMessages.map((message) => <p key={message}>{message}</p>)}
          {stages.uniquenessMessage ? <p>{stages.uniquenessMessage}</p> : null}
          {(preview.imageFiles || []).map((file) => (
            <p key={`${file.color}-${file.filename}`}>Image {file.color}: {file.verified ? `${file.byteLength} bytes` : "bytes not verified"}.</p>
          ))}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={confirmParent} onChange={(event) => setConfirmParent(event.target.checked)} />
            Confirm Stage A for hidden parent 75244 only
          </label>
          <button type="button" className={BUTTON} disabled={!parentReady} onClick={() => runStage("parent")}>
            Stage A: create hidden parent
          </button>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={confirmVariants} onChange={(event) => setConfirmVariants(event.target.checked)} />
            Confirm Stage B for the three color variants only
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={acceptUniqueness} onChange={(event) => setAcceptUniqueness(event.target.checked)} />
            Acknowledge that global variant-SKU uniqueness is unproven
          </label>
          <button type="button" className={BUTTON} disabled={!variantsReady} onClick={() => runStage("variants")}>
            Stage B: save three variants
          </button>
          {stageResult ? <p>{stageResult.message || stageResult.code}</p> : null}
          {preview.parent ? (
            <pre className="overflow-auto rounded-2xl bg-cream p-3 text-xs">{JSON.stringify({ parent: preview.parent, variants: preview.variants, preservedSourceImages: preview.preservedSourceImages, stagePlan: preview.stagePlan }, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
