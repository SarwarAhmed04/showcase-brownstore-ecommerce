import { useState } from "react";
import { api } from "../../../api";

export default function GiniVariantStockPatchPanel() {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [result, setResult] = useState(null);
  const canApply = preview?.readyForConfirmation === true && confirmed && !busy;
  const canRestore = preview?.writesEnabled === true
    && preview?.hostMatches === true
    && preview?.operation?.status === "verified"
    && preview?.operation?.direction === "apply"
    && restoreConfirmed
    && !busy;

  return (
    <div className="mt-5 rounded-2xl bg-cream/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-brown">KE20-BLACK quantity test</h3>
          <p className="mt-1 max-w-2xl text-sm text-brown/70">
            BrownStore stock stays at 10. A later approved test would temporarily set GINI KE20-BLACK to 9. KE20-BLUE stays at 10. Nothing is sent from this preview.
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
              setPreview(await api.giniVariantStockPatchPreview());
            } catch (err) {
              setError(err.message || "Baseline preview failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          Load KE20 baseline
        </button>
      </div>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {preview ? (
        <div className="mt-4 space-y-2 text-sm text-brown/80">
          <p>{preview.intentionalDifference}</p>
          <p>
            Proposed request: PATCH {preview.request?.path} {preview.request?.rawBody}
          </p>
          <p>
            Write gate {preview.writesEnabled ? "on" : "off"}. Host {preview.host || "unread"} {preview.hostMatches ? "matches merchant.gini.iq" : "is not the required merchant host"}.
          </p>
          <p>
            Baseline {preview.baseline?.ok ? "matches" : `blocked (${(preview.baseline?.blockers || []).join(", ") || "unread"})`}.
            Ownership {preview.ownership?.ok ? "matches" : `blocked (${(preview.ownership?.blockers || []).join(", ")})`}.
          </p>
          <p>
            Restore is separate and is not automatic: {preview.restorePlan?.method} {preview.restorePlan?.path} {preview.restorePlan?.rawBody}
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            I confirm this one KE20-BLACK change from 10 to 9
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={restoreConfirmed} onChange={(event) => setRestoreConfirmed(event.target.checked)} />
            I separately confirm restoring KE20-BLACK from 9 to 10
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canApply}
              className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream disabled:bg-brown/20 disabled:text-brown/50"
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  setResult(await api.giniVariantStockPatch({ confirm: true, direction: "apply" }));
                } catch (err) {
                  setError(err.message || "Quantity PATCH failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send quantity 9 PATCH
            </button>
            <button
              type="button"
              disabled={!canRestore}
              className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream disabled:bg-brown/20 disabled:text-brown/50"
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  setResult(await api.giniVariantStockPatch({ confirm: true, direction: "restore" }));
                } catch (err) {
                  setError(err.message || "Restore failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Restore quantity 10
            </button>
          </div>
          {result ? <p>Last result: {result.code}. Verified: {result.verified ? "yes" : "no"}. Retry: no.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
