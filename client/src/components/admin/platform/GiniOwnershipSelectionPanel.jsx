import { useEffect, useState } from "react";
import { api } from "../../../api";
import { imgUrl } from "../../../lib/img";
import { OWNERSHIP_IMAGE_FALLBACK, ownershipImageSrc } from "./ownershipImage";

const PREVIEW_TEXT = {
  approval_required: "Choose one product, then review that exact choice.",
  group_not_found: "That SKU group is no longer in the current catalog.",
  candidate_not_in_group: "The selected product does not belong to this SKU group.",
  candidate_not_unique: "That product id appears more than once in this SKU group.",
  owner_already_verified: "A verified owner is already recorded. This selection stays locked.",
  owner_already_approved: "A different owner is already approved. This preview will not replace it.",
  conflicting_owner: "This SKU has conflicting owner records. No selection was prepared.",
  already_owner: "This product is already the recorded owner.",
  selection_prepared_not_saved: "Selection prepared. Nothing was saved or sent.",
};

function OwnershipImage({ url }) {
  const [failed, setFailed] = useState(false);
  const resolved = ownershipImageSrc(url, { failed });
  const src = resolved === OWNERSHIP_IMAGE_FALLBACK ? OWNERSHIP_IMAGE_FALLBACK : (imgUrl(resolved) || OWNERSHIP_IMAGE_FALLBACK);
  return (
    <img
      src={src}
      alt=""
      className="h-16 w-16 rounded-lg bg-cream object-cover ring-1 ring-brown/10"
      onError={() => setFailed(true)}
    />
  );
}

function nextGateLabel(gate) {
  return {
    missing_size_attribute: "Missing Size attribute",
    unmapped_colors: "Unmapped colors",
    missing_approved_variant_skus: "Missing approved variant SKUs",
    remote_verification: "Remote verification",
    other: "Another validation gate",
  }[gate] || gate || "Remote verification";
}

export default function GiniOwnershipSelectionPanel() {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState({});
  const [reviews, setReviews] = useState({});

  async function load(nextPage = page, nextQuery = appliedQuery) {
    setBusy(true);
    setError("");
    try {
      setData(await api.giniVariantOwnershipGroups({ query: nextQuery, page: nextPage, pageSize: 10 }));
    } catch (err) {
      setError(err.message || "Failed to load ownership groups");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load(1, "");
  }, []);

  const groups = data?.groups || [];
  const total = data?.total || 0;
  const pages = data?.pages || 1;

  return (
    <div className="mt-5 rounded-2xl bg-cream/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-brown">Vendor ownership selection</h3>
          <p className="mt-1 max-w-3xl text-sm text-brown/70">
            Every duplicate parent SKU is listed here. Choose one BrownStore product per unresolved group. The other product is excluded from GINI ownership and stays in BrownStore. Order, stock, and product id are not a recommendation.
          </p>
        </div>
        <p className="text-sm font-semibold text-brown">Sending is off. Saving is off.</p>
      </div>
      <p className="mt-3 text-sm text-brown/80">
        Duplicate groups {data?.uniqueDuplicateSkuGroups ?? "—"}. Verified owners {data?.groupsWithVerifiedOwner ?? "—"}. Unresolved groups {data?.groupsAwaitingSelection ?? "—"}.
        {appliedQuery ? ` Matching this search: ${total}, of which ${data?.unresolvedInResult ?? 0} are unresolved.` : ` Visible across pages: ${data?.uniqueDuplicateSkuGroups ?? "—"}.`}
      </p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = query.trim();
          setAppliedQuery(next);
          setPage(1);
          load(1, next);
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search SKU, product name, or vendor"
          className="min-w-[16rem] flex-1 rounded-full border border-brown/15 bg-white px-4 py-2 text-sm text-brown"
        />
        <button type="submit" disabled={busy} className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream disabled:bg-brown/30">
          Search
        </button>
      </form>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {busy && !data ? <p className="mt-3 text-sm text-brown/60">Loading ownership groups…</p> : null}
      <div className="mt-4 space-y-4">
        {groups.map((group) => {
          const review = reviews[group.parentSkuKey];
          const locked = !group.selectionOpen;
          return (
            <article key={group.parentSkuKey} className="rounded-2xl bg-white p-4 ring-1 ring-brown/10">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="font-semibold text-brown">Parent SKU {group.parentSku}</h4>
                <span className="text-xs font-semibold uppercase text-brown/60">
                  {group.conflictingOwners ? "Conflicting owner" : group.verifiedOwner ? "Verified owner locked" : group.selectionOpen ? "Needs one choice" : "Selection locked"}
                </span>
              </div>
              <p className="mt-1 text-sm text-brown/70">
                {group.verifiedOwner
                  ? `Verified GINI owner: ${group.verifiedOwner.vendor || "vendor"} · BrownStore product ${group.verifiedOwner.productId}.`
                  : "No verified GINI owner."}
                {" "}Remote parent {group.remote?.id ? `${group.remote.id}${group.remote.visibility ? `, ${group.remote.visibility}` : ""}` : "not recorded"}.
              </p>
              {group.conflictingOwners ? (
                <p className="mt-2 text-sm text-red-800">Conflicting ownership is recorded for this SKU. This screen will not choose between those records.</p>
              ) : null}
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {(group.candidates || []).map((candidate) => {
                  const chosen = choices[group.parentSkuKey] === candidate.productId;
                  const excludedByReview = review?.ok && review.excluded?.some((row) => row.productId === candidate.productId);
                  const recordedOwner = candidate.role === "verified_owner" || candidate.role === "approved_owner";
                  return (
                    <label key={candidate.productId} className={`rounded-xl p-3 ring-1 ${chosen ? "ring-brown bg-cream/40" : "ring-brown/10"}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-brown">{candidate.name || group.parentSku}</p>
                          <p className="text-sm text-brown/70">{candidate.vendor || "Vendor name missing"} · SKU {candidate.parentSku || group.parentSku}</p>
                        </div>
                        <input
                          type="radio"
                          name={`owner-${group.parentSkuKey}`}
                          checked={chosen}
                          disabled={locked || busy}
                          onChange={() => {
                            setChoices((current) => ({ ...current, [group.parentSkuKey]: candidate.productId }));
                            setReviews((current) => ({ ...current, [group.parentSkuKey]: null }));
                          }}
                        />
                      </div>
                      <div className="mt-2 flex gap-2">
                        {((candidate.imageUrls || []).slice(0, 3).length ? candidate.imageUrls.slice(0, 3) : [""]).map((url) => (
                          <OwnershipImage key={url || "fallback"} url={url} />
                        ))}
                        {(candidate.imageUrls || []).length === 0 ? <p className="text-xs text-brown/50">No product image</p> : null}
                      </div>
                      <p className="mt-2 text-xs text-brown/70">BrownStore product {candidate.productId}</p>
                      <p className="text-xs text-brown/70">Source item {candidate.sourceItemId || "—"}</p>
                      <p className="mt-2 text-sm text-brown/80">Colors: {(candidate.colors || []).join(", ") || "—"}</p>
                      <ul className="mt-1 space-y-1 text-sm text-brown/80">
                        {(candidate.stock || []).map((row) => (
                          <li key={`${candidate.productId}-${row.sku}-${row.color}`}>
                            {row.color || "color"} · {row.sku || "SKU missing"} · stock {row.stock ?? "—"}
                          </li>
                        ))}
                      </ul>
                      {recordedOwner ? <p className="mt-2 text-sm font-semibold text-brown">Recorded GINI owner. Selection is locked.</p> : null}
                      {candidate.role === "non_owner" && (group.verifiedOwner || excludedByReview) ? (
                        <p className="mt-2 text-sm font-semibold text-brown">Excluded from GINI ownership. This product is not deleted from BrownStore.</p>
                      ) : null}
                      <p className="mt-2 text-xs text-brown/60">Next gate if chosen: {nextGateLabel(candidate.nextGate)}</p>
                    </label>
                  );
                })}
              </div>
              {group.selectionOpen ? (
                <button
                  type="button"
                  disabled={busy || !choices[group.parentSkuKey]}
                  className="mt-3 rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream disabled:bg-brown/30"
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const preview = await api.giniVariantOwnershipPreview({
                        parentSku: group.parentSku,
                        productId: choices[group.parentSkuKey],
                        confirm: true,
                      });
                      setReviews((current) => ({ ...current, [group.parentSkuKey]: preview }));
                    } catch (err) {
                      setError(err.message || "Review failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Review selection
                </button>
              ) : (
                <p className="mt-3 text-sm text-brown/70">This group does not accept a new owner from this screen.</p>
              )}
              {review ? (
                <div className="mt-3 rounded-xl bg-cream/60 p-3 text-sm text-brown/80">
                  <p className="font-semibold text-brown">{PREVIEW_TEXT[review.code] || review.code}</p>
                  {review.selected ? (
                    <p className="mt-1">
                      Proposed owner: {review.selected.vendor} · {review.selected.name || review.parentSku} · product {review.selected.productId} · source item {review.selected.sourceItemId || "—"}.
                    </p>
                  ) : null}
                  <p className="mt-1">Next blockers: {(review.nextBlockers || []).join(", ") || "none returned"}. Next gate: {nextGateLabel(review.nextGate)}.</p>
                  <p className="mt-1">
                    Saved: {review.saved ? "yes" : "no"}. Sent to GINI: {review.sentToGini ?? 0}. Variant SKUs approved: {review.approvesVariantSkus ? "yes" : "no"}. Stock merged: {review.mergesStock ? "yes" : "no"}.
                  </p>
                  {(review.excluded || []).map((row) => (
                    <p key={row.productId} className="mt-1">
                      {row.vendor} product {row.productId} is excluded from GINI ownership. It is not deleted from BrownStore.
                    </p>
                  ))}
                  <p className="mt-1">Database rechecked: {review.databaseRechecked ? "yes" : "no"}. Owner save authorization: off.</p>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-brown/70">
        <p>
          Page {data?.page || page} of {pages}. Showing {groups.length} of {total} matching groups.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || (data?.page || 1) <= 1}
            className="rounded-full bg-white px-3 py-1.5 font-semibold text-brown ring-1 ring-brown/10 disabled:text-brown/30"
            onClick={() => {
              const next = Math.max(1, (data?.page || page) - 1);
              setPage(next);
              load(next, appliedQuery);
            }}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={busy || (data?.page || 1) >= pages}
            className="rounded-full bg-white px-3 py-1.5 font-semibold text-brown ring-1 ring-brown/10 disabled:text-brown/30"
            onClick={() => {
              const next = Math.min(pages, (data?.page || page) + 1);
              setPage(next);
              load(next, appliedQuery);
            }}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
