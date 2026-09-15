import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import { tName } from "../../i18n";
import Spinner from "../../components/Spinner";

function formatCount(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function formatWhen(value, lang) {
  if (!value) return null;
  const locale = lang === "ar" ? "ar-IQ" : lang === "ku" ? "en-GB" : "en-US";
  return new Date(value).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function greetingKey() {
  const hour = new Date().getHours();
  if (hour < 12) return "goodMorning";
  if (hour < 18) return "goodAfternoon";
  return "goodEvening";
}

function MixRow({ label, value, total, tone }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-sm text-brown/60">{label}</span>
        <span className="font-display text-xl tabular-nums">{formatCount(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-brown/10">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const { t, lang } = useLang();
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .adminStats()
      .then(setStats)
      .catch((err) => setError(err.message));
  }, []);

  const visiblePct = useMemo(() => {
    if (!stats?.products) return 0;
    return Math.round((stats.visible / stats.products) * 100);
  }, [stats]);

  if (!stats && !error) return <Spinner label={t.loading} />;

  const hello = t[greetingKey()];
  const synced = formatWhen(stats?.lastSyncedAt, lang);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-4xl tracking-tight text-brown md:text-[2.6rem]">
            {t.overview}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-brown/50">
            {hello}
            {user?.email ? ` · ${user.email}` : ""} — {t.dashboardLead}
          </p>
        </div>
        <Link
          to="/admin/products"
          className="rounded-full bg-tan px-5 py-2.5 text-sm font-semibold text-brown shadow-[0_1px_2px_rgb(61_35_23/0.12)] hover:bg-[#c8965a]"
        >
          {t.viewAllProducts}
        </Link>
      </section>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {stats ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: t.catalogSize, value: formatCount(stats.products), hint: t.products },
              { label: t.listedOnStore, value: formatCount(stats.visible), hint: `${visiblePct}%` },
              { label: t.hiddenFromStore, value: formatCount(stats.outOfStock) },
              { label: t.categoriesCount, value: formatCount(stats.categories) },
            ].map((card) => (
              <div
                key={card.label}
                className="rounded-[1.5rem] bg-white px-5 py-5 shadow-sm ring-1 ring-brown/[0.04]"
              >
                <p className="text-[11px] font-semibold tracking-[0.16em] text-brown/40 uppercase">
                  {card.label}
                </p>
                <p className="mt-3 font-display text-[2rem] leading-none tabular-nums text-brown">
                  {card.value}
                </p>
                {card.hint ? (
                  <p className="mt-2 text-xs text-brown/40">{card.hint}</p>
                ) : null}
              </div>
            ))}
          </section>

          <section className="grid gap-4 lg:grid-cols-12">
            <div className="rounded-[1.75rem] bg-white p-6 shadow-sm ring-1 ring-brown/5 lg:col-span-7">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
                    {t.visibleShare}
                  </p>
                  <p className="mt-2 font-display text-4xl tabular-nums">{visiblePct}%</p>
                </div>
                <p className="text-sm text-brown/45">
                  {formatCount(stats.visible)} / {formatCount(stats.products)}
                </p>
              </div>

              <div className="mt-6 flex h-4 overflow-hidden rounded-full bg-brown/10">
                <div
                  className="h-full bg-brown transition-[width] duration-500"
                  style={{ width: `${visiblePct}%` }}
                />
                <div
                  className="h-full bg-tan transition-[width] duration-500"
                  style={{ width: `${Math.max(0, 100 - visiblePct)}%` }}
                />
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <Link
                  to="/admin/products"
                  className="rounded-3xl bg-cream px-5 py-4 ring-1 ring-brown/5 transition hover:ring-tan/40"
                >
                  <p className="text-xs font-semibold tracking-wide text-emerald-800">
                    {t.listedOnStore}
                  </p>
                  <p className="mt-1 font-display text-3xl tabular-nums">
                    {formatCount(stats.visible)}
                  </p>
                </Link>
                <div className="rounded-3xl bg-cream px-5 py-4 ring-1 ring-brown/5">
                  <p className="text-xs font-semibold tracking-wide text-red-800">
                    {t.hiddenFromStore}
                  </p>
                  <p className="mt-1 font-display text-3xl tabular-nums">
                    {formatCount(stats.outOfStock)}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-between gap-5 rounded-[1.75rem] bg-white p-6 shadow-sm ring-1 ring-brown/5 lg:col-span-5">
              <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
                {t.catalogMix}
              </p>
              <div className="flex items-end justify-between gap-3 rounded-3xl bg-white px-5 py-4">
                <span className="text-sm text-brown/60">{t.categoriesCount}</span>
                <span className="font-display text-4xl tabular-nums">
                  {formatCount(stats.categories)}
                </span>
              </div>
              <div className="space-y-5">
                <MixRow
                  label={t.featured}
                  value={stats.featured}
                  total={stats.products}
                  tone="bg-tan"
                />
                <MixRow
                  label={t.newArrivals}
                  value={stats.newArrivals}
                  total={stats.products}
                  tone="bg-brown/50"
                />
              </div>
            </div>
          </section>

          <section>
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
                  {t.recentProducts}
                </p>
                <h3 className="mt-1 font-display text-2xl">{t.products}</h3>
              </div>
              <Link
                to="/admin/products"
                className="text-sm font-semibold text-brown/70 hover:text-brown"
              >
                {t.viewAllProducts}
              </Link>
            </div>
            <div className="-mx-1 flex gap-3 overflow-x-auto pb-2">
              {(stats.recent || []).map((product) => (
                <Link
                  key={product.id}
                  to={`/admin/products?q=${encodeURIComponent(product.sku || "")}`}
                  className="w-40 shrink-0 rounded-3xl bg-white p-3 shadow-sm ring-1 ring-brown/5 transition hover:-translate-y-0.5 hover:ring-tan/40"
                >
                  <div className="aspect-square overflow-hidden rounded-2xl bg-cream">
                    <img
                      src={product.image || "/logo.png"}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <p className="mt-3 line-clamp-2 min-h-10 text-sm font-medium">
                    {tName(product.name, lang)}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-brown/40">
                    {product.sku || product.itemCode || "—"}
                  </p>
                  {product.outOfStock ? (
                    <p className="mt-2 text-[11px] font-semibold text-red-800">
                      {t.outOfStock}
                    </p>
                  ) : (
                    <p className="mt-2 text-[11px] font-semibold text-emerald-800">
                      {t.inStock}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          </section>

          <section className="relative overflow-hidden rounded-[2rem] border border-dashed border-tan/70 bg-[repeating-linear-gradient(90deg,transparent,transparent_12px,rgba(210,166,121,0.12)_12px,rgba(210,166,121,0.12)_13px)] px-6 py-5 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold tracking-[0.22em] text-tan uppercase">
                  {t.lastSync}
                </p>
                <p className="mt-1 font-display text-xl">
                  {synced || t.neverSynced}
                </p>
              </div>
              <Link
                to="/admin/products"
                className="rounded-full bg-tan px-5 py-2.5 text-sm font-semibold text-brown"
              >
                {t.viewAllProducts}
              </Link>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
