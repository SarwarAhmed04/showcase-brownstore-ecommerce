import { useState } from "react";
import { api } from "../../../api";

export default function GiniKe20PricePatchPanel() {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState(null);
  const stage = preview?.nextStage === "black" ? "black" : preview?.nextStage === "blue" ? "blue" : "";
  const canSend = preview?.readyForConfirmation === true && stage !== "" && confirmed && !busy;

  return (
    <div className="mt-5 rounded-2xl bg-cream/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-brown">KE20 price PATCH</h3>
          <p className="mt-1 max-w-2xl text-sm text-brown/70">
            One variant at a time. Blue 164306 is prepared first, then black 164307 only after blue is verified. Both prices would become 28000 IQD. Stock, visibility, and images stay unchanged. The write gate is off unless both server flags are set, and this screen does not turn them on.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream disabled:bg-brown/30"
          onClick={async () => {
            setBusy(true);
            setError("");
            setConfirmed(false);
            try {
              setPreview(await api.giniKe20PricePatchPreview());
            } catch (err) {
              setError(err.message || "KE20 price preview failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          Load KE20 price baseline
        </button>
      </div>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {preview ? (
        <div className="mt-4 space-y-2 text-sm text-brown/80">
          <p>
            Next stage: {stage || "none"}. Write gate {preview.writesEnabled ? "on" : "off"}. Host {preview.host || "unread"} {preview.hostMatches ? "matches merchant.gini.iq" : "is not the required merchant host"}.
          </p>
          <p>Blue PATCH {preview.stages?.blue?.rawBody} · journal {preview.stages?.blue?.operation?.status || "idle"}</p>
          <p>Black PATCH {preview.stages?.black?.rawBody} · journal {preview.stages?.black?.operation?.status || "idle"}</p>
          <p>
            Baseline {preview.baseline?.ok ? "matches" : `blocked (${(preview.baseline?.blockers || []).join(", ") || "unread"})`}.
            Ownership {preview.ownership?.ok ? "matches" : `blocked (${(preview.ownership?.blockers || []).join(", ") || "unread"})`}.
            Approval {preview.approval?.ok ? "matches" : `blocked (${(preview.approval?.blockers || []).join(", ") || "unread"})`}.
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            I confirm this single {stage || "KE20"} price PATCH and no other product
          </label>
          <button
            type="button"
            disabled={!canSend}
            className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream disabled:bg-brown/20 disabled:text-brown/50"
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const saved = await api.giniKe20PricePatch({ stage, confirm: true });
                setResult(saved);
                setPreview(await api.giniKe20PricePatchPreview());
                setConfirmed(false);
              } catch (err) {
                setError(err.message || "KE20 price PATCH failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Send this one price PATCH
          </button>
          {result ? <p>Last result: {result.code}. Verified: {result.verified ? "yes" : "no"}. Retry: no.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
