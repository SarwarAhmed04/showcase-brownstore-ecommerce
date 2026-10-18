import { useEffect, useState } from "react";
import { api } from "../../../api";
import { formatCount } from "./platformUi";

export default function PlatformOverview({ partnerSlug, partner, t, onOpen, onPartner }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    setStats(null);
    setError("");
    api
      .platformDashboard(partnerSlug)
      .then((data) => {
        if (!ignore) setStats(data);
      })
      .catch((err) => {
        if (!ignore) setError(err.message);
      });
    return () => {
      ignore = true;
    };
  }, [partnerSlug, partner?.isActive]);

  async function togglePlatform() {
    const turningOff = partner?.isActive !== false;
    if (turningOff && !window.confirm(t.deactivatePlatformConfirm)) return;
    setBusy(true);
    setError("");
    try {
      const data = await api.patchPlatform(partnerSlug, { isActive: !turningOff });
      onPartner?.(data.platform);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const cards = stats
    ? [
        [t.statTotal, stats.totalProducts],
        [t.statExportReady, stats.exportReady],
        [t.statInactive, stats.inactiveExcluded],
        [t.statPriceRules, stats.priceRules],
        [t.statTotalCollections, stats.totalCollections],
        [t.statMappedCollections, stats.configuredCollections],
        [t.statUnmappedCollections, stats.missingSetupCollections],
        [t.statNewTaxonomyAlerts, stats.newTaxonomyAlerts],
      ]
    : [];

  const actions = [
    ["mapping", t.categoryMapping],
    ["availability", t.availabilityTab],
    ["commissions", t.existingCommissions],
    ["excel", t.excelTab],
  ];

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
              {partner?.name}
            </p>
            <p className="mt-2 max-w-2xl text-sm text-brown/55">{t.platformDashboardHint}</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={togglePlatform}
            className={`rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-50 ${
              partner?.isActive === false
                ? "bg-brown/10 text-brown/55"
                : "bg-emerald-50 text-emerald-800"
            }`}
          >
            {partner?.isActive === false ? t.platformInactiveLabel : t.platformActiveLabel}
          </button>
        </div>
        {stats ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {cards.map(([label, value]) => (
              <article key={label} className="rounded-2xl bg-cream px-4 py-4">
                <p className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">{label}</p>
                <p className="mt-2 font-display text-3xl tabular-nums">{formatCount(value)}</p>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-5 text-sm text-brown/45">{t.loading}</p>
        )}
      </section>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {actions.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onOpen(id)}
            className="rounded-3xl bg-white p-5 text-start shadow-sm ring-1 ring-brown/5 transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <p className="font-display text-2xl">{label}</p>
            <p className="mt-3 text-sm font-semibold text-tan">{t.openPlatform} →</p>
          </button>
        ))}
      </div>
    </div>
  );
}
