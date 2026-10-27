import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../../api";
import { useLang } from "../../context/LangContext";
import { tName } from "../../i18n";
import Spinner from "../../components/Spinner";

const CONTROL =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";

function formatCount(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function Toggle({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-emerald-700" : "bg-brown/25"
      }`}
    >
      <span
        className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${
          checked ? "start-5" : "start-0.5"
        }`}
      />
    </button>
  );
}

export default function AdminVendorControls() {
  const { t, lang } = useLang();
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [openVendors, setOpenVendors] = useState(() => new Set());

  const listKey = q.trim();

  async function load() {
    const next = await api.vendorControls({ q: listKey });
    setData(next);
  }

  useEffect(() => {
    let ignore = false;
    const timer = setTimeout(() => {
      api
        .vendorControls({ q: listKey })
        .then((next) => {
          if (!ignore) {
            setData(next);
            setError("");
          }
        })
        .catch((err) => {
          if (!ignore) setError(err.message);
        });
    }, 200);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [listKey]);

  const rows = data?.rows || [];
  const counts = data?.counts || { vendors: 0, inactiveVendors: 0, inactiveBrands: 0 };

  const summary = useMemo(() => {
    const template = t.vendorControlsSummary || "";
    return template
      .replace("{vendors}", formatCount(counts.vendors))
      .replace("{inactiveVendors}", formatCount(counts.inactiveVendors))
      .replace("{inactiveBrands}", formatCount(counts.inactiveBrands));
  }, [t.vendorControlsSummary, counts]);

  function toggleOpen(vendorId) {
    setOpenVendors((prev) => {
      const next = new Set(prev);
      if (next.has(vendorId)) next.delete(vendorId);
      else next.add(vendorId);
      return next;
    });
  }

  async function onVendorToggle(vendor, active) {
    const count = formatCount(vendor.productCount);
    const prompt = (active ? t.vendorControlsActivateVendor : t.vendorControlsDeactivateVendor).replace(
      "{count}",
      count
    );
    if (!window.confirm(prompt)) return;
    const key = `vendor:${vendor.id}`;
    setBusyKey(key);
    setError("");
    try {
      await api.setVendorControl(vendor.id, { active });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey("");
    }
  }

  async function onBrandToggle(vendor, brand, active) {
    const count = formatCount(brand.productCount);
    const prompt = (active ? t.vendorControlsActivateBrand : t.vendorControlsDeactivateBrand)
      .replace("{count}", count)
      .replace("{brand}", tName(brand.name, lang) || brand.id);
    if (!window.confirm(prompt)) return;
    const key = `brand:${vendor.id}:${brand.id}`;
    setBusyKey(key);
    setError("");
    try {
      await api.setVendorBrandControl(vendor.id, brand.id, { active });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey("");
    }
  }

  if (!data && !error) return <Spinner label={t.loading} />;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">{t.vendorControls}</p>
        <h1 className="mt-2 font-display text-3xl text-brown">{t.vendorControlsTitle}</h1>
        <p className="mt-2 max-w-3xl text-sm text-brown/55">{t.vendorControlsHint}</p>
        {summary ? <p className="mt-3 text-sm font-semibold text-brown/70">{summary}</p> : null}
      </div>

      <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-brown/5">
        <label className="block text-sm font-semibold text-brown">
          {t.search}
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            className={`${CONTROL} mt-2`}
            placeholder={t.vendorControlsSearchPlaceholder}
          />
        </label>
        {error ? <p className="mt-4 text-sm font-semibold text-red-700">{error}</p> : null}
      </div>

      <div className="space-y-3">
        {rows.map((vendor) => {
          const open = openVendors.has(vendor.id);
          const vendorBusy = busyKey === `vendor:${vendor.id}`;
          return (
            <section key={vendor.id} className="rounded-3xl bg-white shadow-sm ring-1 ring-brown/5">
              <div className="flex flex-wrap items-center gap-3 px-5 py-4">
                <button
                  type="button"
                  onClick={() => toggleOpen(vendor.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-start"
                >
                  {open ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-brown/40" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-brown/40 rtl:rotate-180" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate font-display text-xl text-brown">
                      {tName(vendor.name, lang) || vendor.id}
                    </span>
                    <span className="mt-0.5 block text-xs font-semibold text-brown/45">
                      {formatCount(vendor.productCount)} {t.products}
                      {" · "}
                      {formatCount(vendor.brands.length)} {t.productBrand}
                    </span>
                  </span>
                </button>
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                      vendor.active ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"
                    }`}
                  >
                    {vendor.active ? t.commissionActive : t.commissionInactive}
                  </span>
                  <Toggle
                    checked={vendor.active}
                    disabled={Boolean(busyKey) || vendorBusy}
                    label={tName(vendor.name, lang) || vendor.id}
                    onChange={(next) => onVendorToggle(vendor, next)}
                  />
                </div>
              </div>

              {open ? (
                <div className="border-t border-brown/[0.06] px-5 py-4">
                  {!vendor.brands.length ? (
                    <p className="text-sm text-brown/50">{t.vendorControlsNoBrands}</p>
                  ) : (
                    <ul className="space-y-2">
                      {vendor.brands.map((brand) => {
                        const brandBusy = busyKey === `brand:${vendor.id}:${brand.id}`;
                        return (
                          <li
                            key={brand.id}
                            className="flex flex-wrap items-center gap-3 rounded-2xl bg-cream/70 px-4 py-3"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-semibold text-brown">
                                {tName(brand.name, lang) || brand.id}
                              </p>
                              <p className="mt-0.5 text-xs font-semibold text-brown/45">
                                {formatCount(brand.productCount)} {t.products}
                                {brand.blockedByVendor ? ` · ${t.vendorControlsBlockedByVendor}` : ""}
                              </p>
                            </div>
                            <span
                              className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                                brand.active ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"
                              }`}
                            >
                              {brand.active ? t.commissionActive : t.commissionInactive}
                            </span>
                            <Toggle
                              checked={brand.active}
                              disabled={Boolean(busyKey) || brandBusy || brand.blockedByVendor}
                              label={tName(brand.name, lang) || brand.id}
                              onChange={(next) => onBrandToggle(vendor, brand, next)}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
        {!rows.length ? (
          <p className="rounded-3xl bg-white px-5 py-8 text-center text-sm text-brown/50 shadow-sm ring-1 ring-brown/5">
            {t.vendorControlsEmpty}
          </p>
        ) : null}
      </div>
    </div>
  );
}
