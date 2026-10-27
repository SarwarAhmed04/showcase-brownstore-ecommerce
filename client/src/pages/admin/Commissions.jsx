import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { GripVertical, X } from "lucide-react";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import { tName } from "../../i18n";
import { imgUrl } from "../../lib/img";
import Spinner from "../../components/Spinner";
import AdminModal from "../../components/admin/AdminModal";
import ProductEditor from "../../components/admin/ProductEditor";
import AvailabilityPanel from "../../components/admin/platform/AvailabilityPanel";
import CategorySetupPanel from "../../components/admin/platform/CategorySetupPanel";
import GiniApiConnection from "../../components/admin/platform/GiniApiConnection";
import GiniSyncOneProduct from "../../components/admin/platform/GiniSyncOneProduct";
import MiswagApiConnection from "../../components/admin/platform/MiswagApiConnection";

/** Optional local Elryan WIP panels (file absent on GINI-only deploys). */
function useOptionalElryanHost() {
  const [Host, setHost] = useState(null);
  useEffect(() => {
    let cancelled = false;
    import(
      /* @vite-ignore */
      "../../components/admin/platform/elryanPlatformHost.jsx"
    )
      .then((mod) => {
        if (!cancelled && mod?.default) setHost(() => mod.default);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return Host;
}
import MiswagMappingCategories from "../../components/admin/platform/MiswagMappingCategories";
import MiswagSyncAll from "../../components/admin/platform/MiswagSyncAll";
import PlatformOverview from "../../components/admin/platform/PlatformOverview";
import { reasonLabel, StatusBadge } from "../../components/admin/platform/platformUi";
import { usePlatformNav } from "../../components/admin/platform/platformNav";
import {
  applyFilterChange,
  clearChildOptions,
  emptyFilterOptions,
  emptyFilterSelection,
  ensureOption,
  filterFieldsEnabled,
  filterOptionsLevel,
  filterOptionsQueryForChange,
  filterPathParts,
  filterPreviewParams,
  filterSelectionIssue,
  selectionFromCommission,
  staleOptionLevels,
} from "../../lib/filterCommissionForm";

const SCOPES = ["all", "category", "subcategory", "collection", "brand", "vendor", "filter"];
const CONTROL =
  "rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const SELECT = `w-full ${CONTROL} disabled:cursor-not-allowed disabled:opacity-50`;
const EMPTY_PRODUCT_FILTERS = {
  vendor: "",
  brand: "",
  category: "",
  subCategory: "",
  collection: "",
};
const PRODUCT_PAGE_SIZES = [25, 50, 100];

function optionLabel(item, lang) {
  const name = tName(item.name, lang) || item.id;
  const count = Number(item.products) || 0;
  return count ? `${name} (${count.toLocaleString("en-US")})` : name;
}

function scopeLabel(t, scope) {
  if (scope === "all") return t.allCommission;
  if (scope === "subcategory") return t.subCategory;
  if (scope === "collection") return t.collection;
  if (scope === "brand") return t.productBrand;
  if (scope === "vendor") return t.vendor;
  if (scope === "filter") return t.filterCommission;
  return t.category;
}

const FILTER_LABEL_KEY = {
  vendor: "vendor",
  brand: "productBrand",
  category: "category",
  subCategory: "subCategory",
  collection: "collection",
};

function filterPartText(part, t, lang) {
  const stored = tName(part.name, lang);
  if (stored) return stored;
  if (!part.id && part.key === "subCategory") return t.allSubCategories;
  if (!part.id && part.key === "collection") return t.allCollections;
  return part.id;
}

function FilterSelect({ label, value, onChange, options, placeholder, disabled, lang, required = false }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-brown/50">
        {label}
        {required ? " *" : ""}
      </label>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={`${SELECT} filter-select max-w-xl`}
      >
        <option value="">{placeholder}</option>
        {(options || []).map((item) => (
          <option key={item.id} value={item.id}>
            {optionLabel(item, lang)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Custom list so name stays left and commission-rule count sits on the far right. */
function VendorRuleSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  lang,
  required = false,
  markedIds,
  ruleCounts,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const list = options || [];
  const selected = list.find((item) => String(item.id) === String(value));
  const selectedMarked = Boolean(value && markedIds?.has(String(value)));
  const selectedCount = value ? Number(ruleCounts?.get(String(value)) || 0) : 0;

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative max-w-xl">
      <label className="mb-1 block text-xs font-semibold text-brown/50">
        {label}
        {required ? " *" : ""}
      </label>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`${SELECT} filter-select flex items-center justify-between gap-4 text-start disabled:cursor-not-allowed disabled:opacity-50 ${
          selectedMarked ? "border-emerald-200 bg-emerald-50 text-emerald-800" : ""
        }`}
      >
        <span className={`min-w-0 truncate ${selected ? "" : "text-brown/45"}`}>
          {selected ? tName(selected.name, lang) || selected.id : placeholder}
        </span>
        {selectedCount > 0 ? (
          <span className="shrink-0 tabular-nums font-semibold text-emerald-800">
            {selectedCount.toLocaleString("en-US")}
          </span>
        ) : null}
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute z-30 mt-2 max-h-64 w-full overflow-y-auto rounded-2xl border border-brown/10 bg-cream py-1 shadow-lg"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              className={`flex w-full items-center justify-between gap-4 px-4 py-2.5 text-start text-sm ${
                !value ? "bg-brown/10 font-semibold text-brown" : "text-brown/70 hover:bg-brown/[0.04]"
              }`}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              <span>{placeholder}</span>
            </button>
          </li>
          {list.map((item) => {
            const id = String(item.id);
            const marked = Boolean(markedIds?.has(id));
            const ruleCount = Number(ruleCounts?.get(id) || 0);
            const active = String(value) === id;
            return (
              <li key={id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`flex w-full items-center justify-between gap-4 px-4 py-2.5 text-start text-sm ${
                    marked
                      ? "bg-emerald-50 font-semibold text-emerald-800 hover:bg-emerald-100"
                      : active
                        ? "bg-brown/10 font-semibold text-brown"
                        : "text-brown hover:bg-brown/[0.04]"
                  }`}
                  onClick={() => {
                    onChange(id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 truncate">{tName(item.name, lang) || item.id}</span>
                  {ruleCount > 0 ? (
                    <span className="shrink-0 tabular-nums">{ruleCount.toLocaleString("en-US")}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function formatRate(value) {
  const n = Number(value) || 0;
  return n > 0 ? `+${n}%` : `${n}%`;
}

function commissionSortLabel(rule, t, lang) {
  if (rule?.scope === "all") return t.allProducts || "";
  if (rule?.scope === "filter") {
    const vendor = filterPathParts(rule).find((part) => part.key === "vendor");
    return filterPartText(vendor || { key: "vendor" }, t, lang) || rule.vendorId || "";
  }
  return tName(rule?.targetName, lang) || rule?.targetId || "";
}

function sortCommissionRules(items, mode, t, lang) {
  const list = [...(items || [])];
  if (mode === "az" || mode === "za") {
    list.sort((a, b) => {
      const cmp = String(commissionSortLabel(a, t, lang)).localeCompare(
        String(commissionSortLabel(b, t, lang)),
        undefined,
        { sensitivity: "base", numeric: true }
      );
      return mode === "az" ? cmp : -cmp;
    });
    return list;
  }
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

function PartnerLogo({ image, name, className = "h-14 w-14" }) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) {
    return (
      <div
        className={`flex items-center justify-center rounded-2xl bg-brown text-lg font-display text-cream ${className}`}
      >
        {(name || "?").slice(0, 1)}
      </div>
    );
  }
  return (
    <img
      src={imgUrl(image)}
      alt={name || ""}
      onError={() => setFailed(true)}
      className={`rounded-2xl bg-white object-cover ring-1 ring-brown/10 ${className}`}
    />
  );
}

function ImageDropField({ image, name, t, onImage, onError }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  async function applyFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      onImage(await readFile(file));
    } catch (err) {
      onError?.(err.message);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        await applyFile(e.dataTransfer.files?.[0]);
      }}
      className={`mt-4 flex cursor-pointer items-center gap-3 rounded-2xl border border-dashed px-3 py-3 transition ${
        dragging
          ? "border-tan bg-tan/10 ring-2 ring-tan/30"
          : "border-brown/15 bg-cream/60 hover:border-brown/30"
      }`}
    >
      <PartnerLogo image={image} name={name} className="h-14 w-14 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-brown">
          {image ? t.platformImageReady : t.platformImage}
        </p>
        <p className="mt-0.5 text-xs text-brown/45">{t.platformImageDrop}</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          await applyFile(file);
        }}
      />
    </div>
  );
}

function PartnerCards({ t }) {
  const [partners, setPartners] = useState([]);
  const [unknown, setUnknown] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .adminPlatforms()
      .then((data) => {
        setPartners(data.platforms || data.partners || []);
        setUnknown(data.unknownPlatforms || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner label={t.loading} />;

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-3xl">{t.platforms}</h2>
        <p className="mt-1 max-w-2xl text-sm text-brown/50">{t.platformsHint}</p>
      </div>
      {error ? <p className="mb-4 text-sm text-red-700">{error}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {partners.map((partner) => (
          <Link
            key={partner.slug}
            to={`/admin/platforms/${partner.slug}`}
            className="group rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5 transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <PartnerLogo image={partner.image} name={partner.name} className="h-16 w-16" />
            <div className="mt-4 flex items-start justify-between gap-3">
              <h3 className="font-display text-2xl">{partner.name}</h3>
              {Number(partner.taxonomyNotices) > 0 ? (
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900">
                  {Number(partner.taxonomyNotices).toLocaleString("en-US")}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-brown/50">
              {partner.rulesCount || 0} {t.partnerRules}
            </p>
            <p className="mt-4 text-sm font-semibold text-tan group-hover:text-brown">
              {t.openPlatform} →
            </p>
          </Link>
        ))}
      </div>
      {unknown.length ? (
        <section className="mt-8 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.unknownPlatforms}
          </p>
          <p className="mt-2 text-sm text-brown/55">{t.unknownPlatformsHint}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {unknown.map((partner) => (
              <Link
                key={partner.slug}
                to={`/admin/platforms/${partner.slug}`}
                className="rounded-2xl bg-cream px-4 py-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-display text-xl">{partner.name}</p>
                  <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900">
                    {t.legacyPlatform}
                  </span>
                </div>
                <p className="mt-1 text-xs text-brown/45">{partner.slug}</p>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function moneyText(value, t) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const text = amount.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${text} ${t.iq || "IQD"}`;
}

function commissionKind(scope, t) {
  return (
    {
      filter: t.commissionKindFilter,
      vendor: t.commissionKindVendor,
      collection: t.commissionKindCollection,
      subcategory: t.commissionKindSubcategory,
      brand: t.commissionKindBrand,
      category: t.commissionKindCategory,
      all: t.commissionKindAll,
    }[scope] || ""
  );
}

function commissionSummaryText(item, t) {
  if (!item.commission) return "0%";
  const rate = Number(item.commission.percentage ?? item.commissionRate) || 0;
  const kind = commissionKind(item.commission.scope, t);
  return kind ? `${kind} ${rate}%` : `${rate}%`;
}

function winningRuleLabel(item, t) {
  if (!item.commission) return t.noCommission;
  return (
    {
      filter: t.filterCommission,
      vendor: t.vendor,
      collection: t.collection,
      subcategory: t.subCategory,
      brand: t.productBrand,
      category: t.category,
      all: t.allCommission,
    }[item.commission.scope] || item.commission.scope
  );
}

function pageWindow(page, pages) {
  const set = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
  return [...set].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    String(template || "")
  );
}

function PriceDetails({ item, t, lang }) {
  const path = tName(item.commission?.targetName, lang);
  const rows = [
    [t.brownstorePrice, moneyText(item.storePrice, t)],
    [t.winningRule, winningRuleLabel(item, t)],
    [t.matchingPath, path || "—"],
    [t.columnCommission, item.commission ? `${Number(item.commission.percentage) || 0}%` : "0%"],
    [t.rawPlatformPrice, moneyText(item.rawPrice ?? item.storePrice, t)],
    [t.finalPlatformPrice, moneyText(item.platformPrice, t)],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-[11px] font-semibold tracking-wide text-brown/40 uppercase">{label}</dt>
          <dd className="mt-0.5 text-sm font-semibold text-brown">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProductStatus({ item, t }) {
  const eligible = item.eligibility ? item.eligibility.eligible : item.platformActive !== false;
  const reasons = item.eligibility?.reasons || [];
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge kind={eligible ? "ready" : "blocked"} t={t} />
      <StatusBadge kind={item.platformActive === false ? "inactive" : "active"} t={t} />
      {reasons.length ? (
        <p className="max-w-48 text-[11px] leading-4 text-brown/50">
          {reasons.map((reason) => reasonLabel(t, reason)).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function ProductActions({ item, t, busy, onEdit, onToggle, open, onDetails }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={onDetails}
        className={`whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-semibold ${
          open ? "bg-brown text-cream" : "bg-cream text-brown"
        }`}
      >
        {t.priceDetails}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onToggle}
        className={`whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${
          item.platformActive === false
            ? "bg-brown/10 text-brown/55"
            : "bg-emerald-50 text-emerald-800"
        }`}
      >
        {item.platformActive === false ? t.commissionInactive : t.commissionActive}
      </button>
      <button
        type="button"
        onClick={onEdit}
        className="whitespace-nowrap rounded-full bg-brown px-2.5 py-1.5 text-xs font-semibold text-cream"
      >
        {t.editProduct}
      </button>
    </div>
  );
}

function PlatformTableProduct({ item, t, lang, busy, open, onEdit, onToggle, onDetails }) {
  return (
    <>
      <tr className="border-b border-brown/10 align-top">
        <td className="overflow-hidden py-3 pr-2">
          <div className="flex min-w-0 items-center gap-2">
            <img
              src={imgUrl(item.image) || "/logo.png"}
              alt=""
              className="h-10 w-10 shrink-0 rounded-lg bg-cream object-cover"
            />
            <p className="truncate font-medium text-brown">{tName(item.name, lang)}</p>
          </div>
        </td>
        <td className="overflow-hidden py-3 pr-2 font-medium text-brown/70">
          <p className="truncate">{item.sku || item.itemCode || "—"}</p>
        </td>
        <td className="overflow-hidden py-3 pr-2 text-brown/70">
          <p className="truncate">{tName(item.brand?.name, lang) || "—"}</p>
        </td>
        <td className="overflow-hidden py-3 pr-2 font-semibold text-brown">{moneyText(item.storePrice, t)}</td>
        <td className="overflow-hidden py-3 pr-2 font-semibold text-brown">{commissionSummaryText(item, t)}</td>
        <td className="overflow-hidden py-3 pr-2 font-semibold text-brown">{moneyText(item.platformPrice, t)}</td>
        <td className="overflow-hidden py-3 pr-2">
          <ProductStatus item={item} t={t} />
        </td>
        <td className="overflow-hidden py-3">
          <ProductActions
            item={item}
            t={t}
            busy={busy}
            open={open}
            onEdit={onEdit}
            onToggle={onToggle}
            onDetails={onDetails}
          />
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-brown/10">
          <td colSpan={8} className="bg-cream/60 px-4 py-4">
            <PriceDetails item={item} t={t} lang={lang} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function PlatformProductCard({ item, t, lang, busy, open, onEdit, onToggle, onDetails }) {
  const fields = [
    [t.sku, item.sku || item.itemCode || "—"],
    [t.productBrand, tName(item.brand?.name, lang) || "—"],
    [t.brownstorePrice, moneyText(item.storePrice, t)],
    [t.columnCommission, commissionSummaryText(item, t)],
    [t.platformPriceLabel, moneyText(item.platformPrice, t)],
  ];
  return (
    <article className="py-4">
      <div className="flex items-start gap-3">
        <img
          src={imgUrl(item.image) || "/logo.png"}
          alt=""
          className="h-12 w-12 rounded-xl bg-cream object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-brown">{tName(item.name, lang)}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {fields.map(([label, value]) => (
              <div key={label}>
                <dt className="text-brown/40">{label}</dt>
                <dd className="font-semibold text-brown">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2">
            <ProductStatus item={item} t={t} />
          </div>
          <div className="mt-3">
            <ProductActions
              item={item}
              t={t}
              busy={busy}
              open={open}
              onEdit={onEdit}
              onToggle={onToggle}
              onDetails={onDetails}
            />
          </div>
          {open ? (
            <div className="mt-3 rounded-2xl bg-cream/70 p-3">
              <PriceDetails item={item} t={t} lang={lang} />
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function CopyField({ label, value, t, onHide, hideLabel }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="min-w-0">
      <label className="mb-1 block text-xs font-semibold text-brown/50">{label}</label>
      <div className="flex min-w-0 gap-2">
        <input
          readOnly
          dir="ltr"
          value={value}
          className={`${SELECT} min-w-0 flex-1 font-mono text-xs font-medium`}
        />
        {onHide ? (
          <button
            type="button"
            onClick={onHide}
            className="shrink-0 rounded-full bg-cream px-4 py-2.5 text-xs font-semibold text-brown"
          >
            {hideLabel}
          </button>
        ) : null}
        <button
          type="button"
          onClick={async () => {
            const ok = await copyText(value);
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
          className="shrink-0 rounded-full bg-brown px-4 py-2.5 text-xs font-semibold text-cream"
        >
          {copied ? t.copied : t.copy}
        </button>
      </div>
    </div>
  );
}

const DEFAULT_EXCEL_COLUMNS = [
  "nameKu",
  "nameEn",
  "nameAr",
  "descriptionKu",
  "descriptionEn",
  "descriptionAr",
  "sku",
  "stock",
  "price",
  "discountPrice",
  "commission",
  "platformPrice",
  "availability",
  "status",
  "brandKu",
  "brandEn",
  "brandAr",
  "platformCategoryId",
  "platformCategoryName",
  "platformCategoryPath",
  "warrantyKu",
  "warrantyEn",
  "warrantyAr",
  "badge",
  "keywords",
  "featured",
  "newArrival",
  "bestSeller",
  "variants",
  ...Array.from({ length: 10 }, (_, index) => `image:${index + 1}`),
];

function excelColumnLetter(index) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    n -= 1;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return letters;
}

function visualRightSign(scroller) {
  const probe = scroller.firstElementChild;
  if (!probe || scroller.scrollWidth - scroller.clientWidth <= 1) return 1;
  const start = scroller.scrollLeft;
  const before = probe.getBoundingClientRect().left;
  const delta = Math.abs(start) > 1 ? -12 : 12;
  scroller.scrollLeft = start + delta;
  const after = probe.getBoundingClientRect().left;
  scroller.scrollLeft = start;
  const moved = after - before;
  if (Math.abs(moved) < 0.5) return 1;
  return moved / delta < 0 ? 1 : -1;
}

function ExcelColumnOrder({ columns, onReorder, onRemove, removeLabel }) {
  const dragFrom = useRef(null);
  const scrollerRef = useRef(null);
  const dragX = useRef(null);
  const scrolling = useRef(false);
  const frame = useRef(0);
  const rightSign = useRef(1);
  const [dragIndex, setDragIndex] = useState(null);

  function stopAutoScroll() {
    scrolling.current = false;
    dragX.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  }

  function stepScroll() {
    const scroller = scrollerRef.current;
    const x = dragX.current;
    if (!scrolling.current || !scroller || x == null) return;
    const rect = scroller.getBoundingClientRect();
    const edge = 72;
    let towardRight = 0;
    if (x <= rect.left + edge) {
      const depth = Math.min(1, (rect.left + edge - x) / edge);
      towardRight = -Math.max(6, Math.round(24 * depth));
    } else if (x >= rect.right - edge) {
      const depth = Math.min(1, (x - (rect.right - edge)) / edge);
      towardRight = Math.max(6, Math.round(24 * depth));
    }
    if (towardRight) scroller.scrollLeft += rightSign.current * towardRight;
    frame.current = requestAnimationFrame(stepScroll);
  }

  function startAutoScroll(event) {
    const scroller = scrollerRef.current;
    if (scroller) rightSign.current = visualRightSign(scroller);
    dragX.current = event.clientX || null;
    if (scrolling.current) return;
    scrolling.current = true;
    frame.current = requestAnimationFrame(stepScroll);
  }

  function trackDrag(event) {
    if (event.clientX === 0 && event.clientY === 0) return;
    dragX.current = event.clientX;
  }

  useEffect(() => () => stopAutoScroll(), []);

  useEffect(() => {
    if (dragIndex == null) return undefined;
    function onDragOver(event) {
      trackDrag(event);
    }
    window.addEventListener("dragover", onDragOver);
    return () => window.removeEventListener("dragover", onDragOver);
  }, [dragIndex]);

  function move(from, to) {
    if (from == null || to == null || from === to) return;
    const next = [...columns];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onReorder(next);
  }

  function endDrag() {
    dragFrom.current = null;
    setDragIndex(null);
    stopAutoScroll();
  }

  const verticalFade =
    "linear-gradient(to bottom, transparent, rgba(61,35,23,0.38) 18%, rgba(61,35,23,0.38) 82%, transparent)";
  const horizontalFade =
    "linear-gradient(to right, transparent, rgba(61,35,23,0.38) 4%, rgba(61,35,23,0.38) 96%, transparent)";

  return (
    <div ref={scrollerRef} className="mt-3 overflow-x-auto rounded-xl border border-brown/10 bg-white">
      <div className="relative flex w-max min-w-full">
        {columns.map((column, index) => (
          <div key={column.key} className="relative flex shrink-0 flex-col">
            <div className="flex h-8 items-center justify-center bg-[#f3f3f3] px-4 text-[11px] font-semibold text-brown/50">
              {excelColumnLetter(index)}
            </div>
            <div
              draggable
              onDragStart={(event) => {
                if (event.target.closest("[data-remove-column]")) {
                  event.preventDefault();
                  return;
                }
                dragFrom.current = index;
                setDragIndex(index);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", column.key);
                startAutoScroll(event);
              }}
              onDrag={trackDrag}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                trackDrag(event);
              }}
              onDrop={(event) => {
                event.preventDefault();
                move(dragFrom.current, index);
                endDrag();
              }}
              onDragEnd={endDrag}
              className={`group relative flex h-10 cursor-grab items-center px-3 text-xs font-semibold whitespace-nowrap select-none active:cursor-grabbing ${
                dragIndex === index ? "bg-brown text-cream" : "bg-cream text-brown"
              }`}
            >
              <span className="flex items-center gap-2" dir="ltr">
                <GripVertical
                  className={`h-4 w-4 shrink-0 ${dragIndex === index ? "text-cream" : "text-brown/40"}`}
                  strokeWidth={2.5}
                  aria-hidden="true"
                />
                <span>{column.label}</span>
              </span>
              <button
                type="button"
                data-remove-column
                draggable={false}
                aria-label={removeLabel}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onRemove(column);
                }}
                className={`absolute top-0.5 right-0.5 z-[2] flex h-4 w-4 items-center justify-center rounded-full bg-white text-brown opacity-0 shadow-sm ring-1 ring-brown/15 group-hover:opacity-100 focus:opacity-100 ${
                  dragIndex === index ? "text-brown" : ""
                }`}
              >
                <X className="h-3 w-3" strokeWidth={2.5} />
              </button>
            </div>
            {index < columns.length - 1 ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 end-0 z-[1] w-px"
                style={{ background: verticalFade }}
              />
            ) : null}
          </div>
        ))}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-8 z-[1] h-px"
          style={{ background: horizontalFade }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-px"
          style={{ background: horizontalFade }}
        />
      </div>
    </div>
  );
}

function PartnerCommission({ partnerSlug, t, lang }) {
  const { user } = useAuth();
  const { setNav } = usePlatformNav();
  const ElryanHost = useOptionalElryanHost();
  const isPrimary = Boolean(user?.isPrimary);
  const [partner, setPartner] = useState(null);
  const [targets, setTargets] = useState({
    categories: [],
    subcategories: [],
    collections: [],
    brands: [],
    vendors: [],
  });
  const [commissions, setCommissions] = useState([]);
  const [commissionSort, setCommissionSort] = useState("date");
  const [scope, setScope] = useState("all");
  const [categoryId, setCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [filterOptions, setFilterOptions] = useState(emptyFilterOptions);
  const [filterLabels, setFilterLabels] = useState(null);
  const [filterRestoring, setFilterRestoring] = useState(false);
  const [percentage, setPercentage] = useState("");
  const filterRequest = useRef(0);
  const optionRequest = useRef({ brands: 0, categories: 0, subcategories: 0, collections: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [plainKey, setPlainKey] = useState("");
  const [pinOpen, setPinOpen] = useState(false);
  const [pinPurpose, setPinPurpose] = useState("generate");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [products, setProducts] = useState({ products: [], pagination: { pages: 1, total: 0 } });
  const [productSearch, setProductSearch] = useState("");
  const [productQ, setProductQ] = useState("");
  const [productPage, setProductPage] = useState(1);
  const [productLimit, setProductLimit] = useState(50);
  const [productFilters, setProductFilters] = useState(EMPTY_PRODUCT_FILTERS);
  const [catalogFacets, setCatalogFacets] = useState(null);
  const [priceDetailId, setPriceDetailId] = useState(null);
  const [previewTotal, setPreviewTotal] = useState(null);
  const [eligibility, setEligibility] = useState("all");
  const facetKeyRef = useRef("");
  const productLoadRef = useRef(0);
  const productRequestRef = useRef({});
  const [editing, setEditing] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editMessage, setEditMessage] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editImage, setEditImage] = useState("");
  const [tab, setTab] = useState("overview");
  const [noticeCount, setNoticeCount] = useState(0);

  useEffect(() => {
    let ignore = false;
    api
      .platformDashboard(partnerSlug)
      .then((data) => {
        if (!ignore) setNoticeCount(Number(data.newTaxonomyAlerts) || 0);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, [partnerSlug]);
  const [excelTotal, setExcelTotal] = useState(null);
  const [excelGini, setExcelGini] = useState(null);
  const [excelColumns, setExcelColumns] = useState([]);
  const [excelSaved, setExcelSaved] = useState(false);
  const [columnToDelete, setColumnToDelete] = useState(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [excelBusy, setExcelBusy] = useState(false);

  const subcategories = useMemo(
    () =>
      (targets.subcategories || []).filter(
        (item) => !categoryId || item.categoryId === categoryId
      ),
    [targets.subcategories, categoryId]
  );

  const collections = useMemo(
    () =>
      (targets.collections || []).filter((item) => {
        if (categoryId && item.categoryId !== categoryId) return false;
        if (subCategoryId && item.subCategoryId !== subCategoryId) return false;
        return true;
      }),
    [targets.collections, categoryId, subCategoryId]
  );

  const filterSelection = useMemo(
    () => ({ vendorId, brandId, categoryId, subCategoryId, collectionId }),
    [vendorId, brandId, categoryId, subCategoryId, collectionId]
  );
  const filterEnabled = filterFieldsEnabled(filterSelection);
  // Per-vendor commission rule counts (Vendor + Filter scopes) for green marker + select labels
  const vendorCommissionCounts = useMemo(() => {
    const counts = new Map();
    for (const rule of commissions) {
      let id = "";
      if (rule.scope === "vendor") id = String(rule.targetId || "");
      else if (rule.scope === "filter") id = String(rule.vendorId || "");
      if (!id) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
  }, [commissions]);
  const vendorsWithCommission = useMemo(
    () => new Set(vendorCommissionCounts.keys()),
    [vendorCommissionCounts]
  );
  const sortedCommissions = useMemo(
    () => sortCommissionRules(commissions, commissionSort, t, lang),
    [commissions, commissionSort, t, lang]
  );
  const preview = useMemo(() => {
    if (scope === "filter") return filterPreviewParams(filterSelection);
    if (scope === "category" && categoryId) return { category: categoryId };
    if (scope === "subcategory" && subCategoryId) return { subCategory: subCategoryId };
    if (scope === "collection" && collectionId) return { collection: collectionId };
    if (scope === "brand" && brandId) return { brand: brandId };
    if (scope === "vendor" && vendorId) return { vendor: vendorId };
    return {};
  }, [scope, filterSelection, categoryId, subCategoryId, collectionId, brandId, vendorId]);
  const previewKey = JSON.stringify(preview);
  const productFilterKey = `${productFilters.vendor}|${productFilters.brand}|${productFilters.category}|${productFilters.subCategory}|${productFilters.collection}`;
  const productFacetKey = `${partnerSlug}|${productFilterKey}`;
  productRequestRef.current = {
    partnerSlug,
    q: productQ,
    limit: productLimit,
    page: productPage,
    eligibility,
    filters: productFilters,
    facetKey: productFacetKey,
  };

  function changeProductFilter(field, value) {
    setProductFilters((current) => {
      const next = { ...current, [field]: value };
      if (field === "vendor") {
        next.brand = "";
        next.category = "";
        next.subCategory = "";
        next.collection = "";
      } else if (field === "brand") {
        next.category = "";
        next.subCategory = "";
        next.collection = "";
      } else if (field === "category") {
        next.subCategory = "";
        next.collection = "";
      } else if (field === "subCategory") {
        next.collection = "";
      }
      return next;
    });
    setProductPage(1);
  }

  function loadDetail() {
    return api.adminPlatform(partnerSlug).then((detail) => {
      const next = detail.platform || detail.partner || null;
      setPartner(next);
      setCommissions(detail.commissions || []);
      setTargets(
        detail.targets || {
          categories: [],
          subcategories: [],
          collections: [],
          brands: [],
          vendors: [],
        }
      );
    });
  }

  const loadProducts = useCallback(async () => {
    const requestId = productLoadRef.current + 1;
    productLoadRef.current = requestId;
    const current = productRequestRef.current;
    const includeFacets = facetKeyRef.current !== current.facetKey;
    const data = await api.adminPlatformProducts(current.partnerSlug, {
      q: current.q,
      limit: current.limit,
      page: current.page,
      eligibility: current.eligibility,
      vendor: current.filters.vendor,
      brand: current.filters.brand,
      category: current.filters.category,
      subCategory: current.filters.subCategory,
      collection: current.filters.collection,
      facets: includeFacets ? "1" : "0",
    });
    if (productLoadRef.current !== requestId) return data;
    setProducts(data);
    if (data.facets) {
      setCatalogFacets(data.facets);
      facetKeyRef.current = current.facetKey;
    }
    const pages = Number(data.pagination?.pages) || 1;
    setProductPage((page) => (page > pages ? pages : page));
    return data;
  }, []);

  function load() {
    return Promise.all([loadDetail(), loadProducts()]);
  }

  async function openPlatformProduct(item) {
    setEditMessage("");
    try {
      const data = await api.adminPlatformProduct(partnerSlug, item.id);
      setEditing(data.product || item);
    } catch {
      setEditing(item);
    }
  }

  async function togglePlatformProduct(item) {
    setBusy(true);
    setError("");
    try {
      await api.setPlatformAvailability(partnerSlug, {
        scope: "product",
        targetId: item.id,
        isActive: item.platformActive === false,
      });
      await loadProducts();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setPlainKey("");
    setError("");
    setMessage("");
    setProductSearch("");
    setProductQ("");
    setProductPage(1);
    setProductLimit(50);
    setProductFilters(EMPTY_PRODUCT_FILTERS);
    setCatalogFacets(null);
    setPriceDetailId(null);
    setEligibility("all");
    facetKeyRef.current = "";
    setTab("overview");
    setExcelColumns([]);
    setExcelSaved(false);
    setColumnToDelete(null);
    setResetOpen(false);
    loadDetail()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [partnerSlug]);

  useEffect(() => {
    const id = setTimeout(() => {
      const next = productSearch.trim();
      setProductQ((current) => {
        if (current === next) return current;
        setProductPage(1);
        return next;
      });
    }, 400);
    return () => clearTimeout(id);
  }, [productSearch]);

  useEffect(() => {
    if (!Object.keys(preview).length) {
      setPreviewTotal(null);
      return undefined;
    }
    let ignore = false;
    api
      .adminPlatformProducts(partnerSlug, { ...preview, limit: 1, page: 1, facets: "0" })
      .then((data) => {
        if (!ignore) setPreviewTotal(Number(data.pagination?.total) || 0);
      })
      .catch(() => {
        if (!ignore) setPreviewTotal(null);
      });
    return () => {
      ignore = true;
    };
  }, [partnerSlug, previewKey, preview]);

  useEffect(() => {
    if (tab !== "products") return undefined;
    loadProducts().catch((err) => setError(err.message));
    return () => {
      productLoadRef.current += 1;
    };
  }, [
    tab,
    partnerSlug,
    productQ,
    productPage,
    productLimit,
    eligibility,
    productFilterKey,
    loadProducts,
  ]);

  useEffect(() => {
    if (tab !== "excel") return undefined;
    let ignore = false;
    setExcelTotal(null);
    setExcelGini(null);
    api
      .platformExcelMeta(partnerSlug)
      .then((data) => {
        if (ignore) return;
        setExcelTotal(Number(data.total) || 0);
        setExcelColumns(data.columns || []);
        setExcelGini(data.gini || null);
      })
      .catch(() => {
        if (!ignore) setExcelTotal(0);
      });
    return () => {
      ignore = true;
    };
  }, [tab, partnerSlug, commissions]);

  function invalidateOptionLevels(levels) {
    for (const level of levels) {
      if (optionRequest.current[level] != null) optionRequest.current[level] += 1;
    }
  }

  function resetFilterControls() {
    filterRequest.current += 1;
    invalidateOptionLevels(["brands", "categories", "subcategories", "collections"]);
    setFilterRestoring(false);
    setFilterLabels(null);
    setFilterOptions(emptyFilterOptions());
  }

  function resetForm() {
    setCategoryId("");
    setSubCategoryId("");
    setCollectionId("");
    setBrandId("");
    setVendorId("");
    setPercentage("");
    setFilterLabels(null);
    setFilterOptions(emptyFilterOptions());
  }

  async function loadFilterLevel(query) {
    const level = filterOptionsLevel(query);
    if (optionRequest.current[level] == null) return;
    const token = ++optionRequest.current[level];
    try {
      const data = await api.commissionFilterOptions(query);
      if (optionRequest.current[level] !== token) return;
      const resolved = data.level || level;
      setFilterOptions((current) => ({ ...current, [resolved]: data[resolved] || [] }));
    } catch (err) {
      if (optionRequest.current[level] === token) setError(err.message);
    }
  }

  function onFilterField(field, value) {
    const next = applyFilterChange(filterSelection, field, value);
    if (next === filterSelection) return;
    setVendorId(next.vendorId);
    setBrandId(next.brandId);
    setCategoryId(next.categoryId);
    setSubCategoryId(next.subCategoryId);
    setCollectionId(next.collectionId);
    setFilterOptions((options) => clearChildOptions(options, field));
    const query = filterOptionsQueryForChange(next, field);
    const fetchLevel = query ? filterOptionsLevel(query) : "";
    invalidateOptionLevels(staleOptionLevels(field, fetchLevel));
    setError("");
    if (query) void loadFilterLevel(query);
  }

  async function restoreFilterRule(rule) {
    const seq = ++filterRequest.current;
    invalidateOptionLevels(["brands", "categories", "subcategories", "collections"]);
    const selection = selectionFromCommission(rule) || emptyFilterSelection();
    setScope("filter");
    setPercentage(String(rule.percentage ?? ""));
    setFilterLabels(rule.filterPath || null);
    setVendorId(selection.vendorId);
    setBrandId(selection.brandId);
    setCategoryId(selection.categoryId);
    setSubCategoryId(selection.subCategoryId);
    setCollectionId(selection.collectionId);
    setFilterOptions({
      brands: ensureOption([], selection.brandId, rule.filterPath?.brand),
      categories: ensureOption([], selection.categoryId, rule.filterPath?.category),
      subcategories: ensureOption([], selection.subCategoryId, rule.filterPath?.subCategory),
      collections: ensureOption([], selection.collectionId, rule.filterPath?.collection),
    });
    setFilterRestoring(true);
    setError("");
    try {
      const [brands, categories, subcategories, collections] = await Promise.all([
        selection.vendorId
          ? api.commissionFilterOptions({ vendorId: selection.vendorId })
          : Promise.resolve({ brands: [] }),
        selection.vendorId && selection.brandId
          ? api.commissionFilterOptions({
              vendorId: selection.vendorId,
              brandId: selection.brandId,
            })
          : Promise.resolve({ categories: [] }),
        selection.vendorId && selection.brandId && selection.categoryId
          ? api.commissionFilterOptions({
              vendorId: selection.vendorId,
              brandId: selection.brandId,
              categoryId: selection.categoryId,
            })
          : Promise.resolve({ subcategories: [] }),
        selection.vendorId &&
        selection.brandId &&
        selection.categoryId &&
        selection.subCategoryId
          ? api.commissionFilterOptions({
              vendorId: selection.vendorId,
              brandId: selection.brandId,
              categoryId: selection.categoryId,
              subCategoryId: selection.subCategoryId,
            })
          : Promise.resolve({ collections: [] }),
      ]);
      if (filterRequest.current !== seq) return;
      invalidateOptionLevels(["brands", "categories", "subcategories", "collections"]);
      setFilterOptions({
        brands: ensureOption(brands.brands, selection.brandId, rule.filterPath?.brand),
        categories: ensureOption(categories.categories, selection.categoryId, rule.filterPath?.category),
        subcategories: ensureOption(
          subcategories.subcategories,
          selection.subCategoryId,
          rule.filterPath?.subCategory
        ),
        collections: ensureOption(
          collections.collections,
          selection.collectionId,
          rule.filterPath?.collection
        ),
      });
    } catch (err) {
      if (filterRequest.current === seq) setError(err.message);
    } finally {
      if (filterRequest.current === seq) setFilterRestoring(false);
    }
  }

  function fillFromRule(rule) {
    if (rule?.scope === "filter") {
      void restoreFilterRule(rule);
      return;
    }
    resetFilterControls();
    setScope(rule.scope);
    setCategoryId(rule.scope === "category" ? rule.targetId : rule.categoryId || "");
    setSubCategoryId(
      rule.scope === "subcategory"
        ? rule.targetId
        : rule.scope === "collection"
          ? rule.subCategoryId || ""
          : ""
    );
    setCollectionId(rule.scope === "collection" ? rule.targetId : "");
    setBrandId(rule.scope === "brand" ? rule.targetId : "");
    setVendorId(rule.scope === "vendor" ? rule.targetId : "");
    setPercentage(String(rule.percentage));
  }

  function targetIdForSave() {
    if (scope === "all") return "*";
    if (scope === "category") return categoryId;
    if (scope === "subcategory") return subCategoryId;
    if (scope === "brand") return brandId;
    if (scope === "vendor") return vendorId;
    return collectionId;
  }

  async function onSave(event) {
    event.preventDefault();
    const rate = Number(percentage);
    if (scope === "filter") {
      if (filterRestoring) return;
      const issue = filterSelectionIssue(filterSelection);
      if (issue === "required") {
        setError(t.filterCommissionRequired);
        return;
      }
      if (issue === "brand") {
        setError(t.selectBrand);
        return;
      }
      if (issue === "category") {
        setError(t.selectCategory);
        return;
      }
      if (issue === "collection") {
        setError(t.filterCollectionNeedsSub);
        return;
      }
      setBusy(true);
      setError("");
      setMessage("");
      try {
        await api.saveCommission({
          partner: partnerSlug,
          scope,
          vendorId,
          brandId,
          categoryId,
          subCategoryId: subCategoryId || "",
          collectionId: subCategoryId ? collectionId || "" : "",
          percentage: rate,
          isActive: true,
        });
        setMessage(t.commissionSaved);
        resetForm();
        await load();
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
      return;
    }
    const targetId = targetIdForSave();
    if (scope !== "all" && !targetId) {
      setError(
        scope === "vendor"
          ? t.selectVendor
          : scope === "brand"
            ? t.selectBrand
            : scope === "collection"
              ? t.selectCollection
              : scope === "subcategory"
                ? t.selectSubCategory
                : t.selectCategory
      );
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.saveCommission({
        partner: partnerSlug,
        scope,
        targetId,
        percentage: rate,
        isActive: true,
      });
      setMessage(t.commissionSaved);
      resetForm();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(rule) {
    setBusy(true);
    setError("");
    try {
      const data = await api.patchCommission(rule.id, { isActive: !rule.isActive });
      setCommissions((prev) =>
        prev.map((item) => (item.id === data.commission.id ? data.commission : item))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(rule) {
    if (!window.confirm(t.deleteCommissionConfirm)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.deleteCommission(rule.id);
      setMessage(t.commissionDeleted);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function closePinModal() {
    if (busy) return;
    setPinOpen(false);
    setPin("");
    setPinError("");
  }

  function openPin(purpose) {
    if (purpose === "generate" && !isPrimary) {
      setError(t.apiKeyPinOnlyPrimary);
      return;
    }
    setError("");
    setMessage("");
    setPin("");
    setPinError("");
    setPinPurpose(purpose);
    setPinOpen(true);
  }

  async function onConfirmPin(event) {
    event.preventDefault();
    if (pinPurpose === "generate" && !isPrimary) {
      setPinError(t.apiKeyPinOnlyPrimary);
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      setPinError(t.apiKeyPinInvalid);
      return;
    }
    setBusy(true);
    setPinError("");
    setError("");
    setMessage("");
    try {
      if (pinPurpose === "reveal") {
        const data = await api.revealPartnerApiKey(partnerSlug, pin);
        setPlainKey(data.apiKey || "");
      } else {
        const data = await api.regeneratePartnerApiKey(partnerSlug, pin);
        setPartner(data.partner);
        setPlainKey(data.apiKey || "");
      }
      setPinOpen(false);
      setPin("");
    } catch (err) {
      setPinError(err.status === 409 ? t.apiKeyNeedsRegen : t.apiKeyPinInvalid);
    } finally {
      setBusy(false);
    }
  }

  const openPlatformEditor = useCallback(() => {
    setError("");
    setEditName(partner?.name || "");
    setEditImage(partner?.image || "");
    setEditOpen(true);
  }, [partner]);

  useEffect(() => {
    if (!partner) {
      setNav(null);
      return undefined;
    }
    setNav({ partner, tab, setTab, onEdit: openPlatformEditor, noticeCount });
    return undefined;
  }, [partner, tab, setNav, openPlatformEditor, noticeCount]);

  useEffect(() => () => setNav(null), [setNav]);

  if (loading) return <Spinner label={t.loading} />;
  if (!partner) {
    return <p className="text-sm text-red-700">{error || t.noCommissions}</p>;
  }

  const example = `GET ${partner.catalogUrl}?page=1&limit=100\nX-API-Key: ${plainKey || partner.apiKeyPrefix || "bs_****"}`;

  return (
    <div className="min-w-0">
      {editOpen ? (
        <AdminModal
          onClose={() => {
            if (!busy) setEditOpen(false);
          }}
        >
          <form
            className="mx-auto w-full max-w-md rounded-3xl bg-white p-6 shadow-xl ring-1 ring-brown/10"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!editName.trim()) return;
              setBusy(true);
              setError("");
              try {
                const patch = { name: editName.trim() };
                if (typeof editImage === "string" && editImage.startsWith("data:")) {
                  patch.image = editImage;
                }
                const data = await api.patchPlatform(partnerSlug, patch);
                setPartner(data.platform);
                setMessage(t.platformSaved);
                setEditOpen(false);
              } catch (err) {
                setError(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <h3 className="font-display text-2xl">{t.editPlatform}</h3>
            {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
            <label className="mt-5 mb-1 block text-xs font-semibold text-brown/50">
              {t.platformName}
            </label>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className={SELECT}
              autoFocus
              required
            />
            <ImageDropField
              image={editImage}
              name={editName}
              t={t}
              onImage={setEditImage}
              onError={setError}
            />
            <div className="mt-6 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditOpen(false)}
                className="flex-1 rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown"
              >
                {t.cancel}
              </button>
              <button
                type="submit"
                disabled={busy || !editName.trim()}
                className="flex-1 rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
              >
                {t.save}
              </button>
            </div>
          </form>
        </AdminModal>
      ) : null}

      {partner.fixed === false ? (
        <p className="mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {t.unknownPlatformsHint}
        </p>
      ) : null}

      {error && !editOpen ? <p className="mb-4 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mb-4 text-sm text-brown/70">{message}</p> : null}

      {tab === "api" ? (
      <section className="mb-6 min-w-0 overflow-hidden rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.partnerApi}
        </p>
        <p className="mt-2 text-sm text-brown/50">{t.apiKeyHint}</p>
        <div className="mt-5 grid gap-4">
          <CopyField label={t.catalogUrl} value={partner.catalogUrl} t={t} />
          <CopyField label={t.categoriesUrl} value={partner.categoriesUrl} t={t} />
          {partner.hasApiKey || plainKey ? (
            <div>
              {plainKey ? (
                <CopyField
                  label={t.apiKey}
                  value={plainKey}
                  t={t}
                  onHide={() => setPlainKey("")}
                  hideLabel={t.hideApiKey}
                />
              ) : (
                <div className="min-w-0">
                  <label className="mb-1 block text-xs font-semibold text-brown/50">
                    {t.apiKey}
                  </label>
                  <div className="flex min-w-0 gap-2">
                    <input
                      readOnly
                      dir="ltr"
                      type="password"
                      value={partner.apiKeyPrefix || "••••••••••••••••"}
                      className={`${SELECT} min-w-0 flex-1 font-mono text-xs font-medium`}
                    />
                    {partner.canRevealApiKey ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => openPin("reveal")}
                        className="shrink-0 rounded-full bg-brown px-4 py-2.5 text-xs font-semibold text-cream disabled:opacity-50"
                      >
                        {t.showApiKey}
                      </button>
                    ) : null}
                  </div>
                  {!partner.canRevealApiKey ? (
                    <p className="mt-2 text-xs font-semibold text-amber-800">{t.apiKeyNeedsRegen}</p>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs font-semibold text-brown/50">
                {t.apiKey}
              </label>
              <p className="rounded-full bg-cream px-4 py-2.5 font-mono text-sm text-brown/70" dir="ltr">
                {t.noApiKey}
              </p>
            </div>
          )}
          <div>
            <p className="mb-1 text-xs font-semibold text-brown/50">{t.exampleRequest}</p>
            <pre
              dir="ltr"
              className="overflow-x-auto rounded-2xl bg-cream p-4 text-xs leading-relaxed text-brown/80"
            >
              {example}
            </pre>
          </div>
          {isPrimary ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => openPin("generate")}
              className="w-fit rounded-full bg-brown px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
            >
              {partner.hasApiKey ? t.regenerateApiKey : t.generateApiKey}
            </button>
          ) : (
            <p className="text-xs font-semibold text-brown/45">{t.apiKeyPinOnlyPrimary}</p>
          )}
        </div>
      </section>
      ) : null}

      {resetOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-brown/40"
            aria-label={t.cancel}
            onClick={() => setResetOpen(false)}
          />
          <div className="relative z-10 w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl ring-1 ring-brown/10">
            <h3 className="font-display text-2xl">{t.excelResetTitle}</h3>
            <p className="mt-2 text-sm text-brown/50">{t.excelResetHint}</p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setResetOpen(false)}
                className="flex-1 rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                onClick={async () => {
                  setResetOpen(false);
                  setExcelSaved(false);
                  try {
                    const data = await api.savePlatformExcelColumns(
                      partnerSlug,
                      DEFAULT_EXCEL_COLUMNS
                    );
                    setExcelColumns(data.columns || []);
                    setExcelSaved(true);
                  } catch (err) {
                    setError(err.message || t.excelFailed);
                  }
                }}
                className="flex-1 rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream"
              >
                {t.excelReset}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {columnToDelete ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-brown/40"
            aria-label={t.cancel}
            onClick={() => setColumnToDelete(null)}
          />
          <div className="relative z-10 w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl ring-1 ring-brown/10">
            <h3 className="font-display text-2xl">{t.excelDeleteTitle}</h3>
            <p className="mt-2 text-sm text-brown/50">
              {t.excelDeleteHint.replace("{name}", columnToDelete.label)}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setColumnToDelete(null)}
                className="flex-1 rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                onClick={async () => {
                  const removed = columnToDelete;
                  const next = excelColumns.filter((column) => column.key !== removed.key);
                  setColumnToDelete(null);
                  setExcelColumns(next);
                  setExcelSaved(false);
                  try {
                    const data = await api.savePlatformExcelColumns(
                      partnerSlug,
                      next.map((column) => column.key)
                    );
                    setExcelColumns(data.columns || next);
                    setExcelSaved(true);
                  } catch (err) {
                    setExcelColumns(excelColumns);
                    setError(err.message || t.excelFailed);
                  }
                }}
                className="flex-1 rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream"
              >
                {t.excelDeleteConfirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pinOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-brown/40"
            aria-label={t.cancel}
            onClick={closePinModal}
          />
          <form
            onSubmit={onConfirmPin}
            className="relative z-10 w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl ring-1 ring-brown/10"
          >
            <h3 className="font-display text-2xl">
              {pinPurpose === "reveal" ? t.apiKeyRevealTitle : t.apiKeyPinTitle}
            </h3>
            <p className="mt-2 text-sm text-brown/50">
              {pinPurpose === "reveal" ? t.apiKeyRevealHint : t.apiKeyPinHint}
            </p>
            {pinPurpose === "generate" && partner.hasApiKey ? (
              <p className="mt-2 text-xs font-semibold text-amber-800">
                {t.regenerateApiKeyConfirm}
              </p>
            ) : null}
            <label className="mt-5 mb-1 block text-xs font-semibold text-brown/50">
              {t.apiKeyPin}
            </label>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              dir="ltr"
              value={pin}
              onChange={(event) => {
                setPin(event.target.value.replace(/\D/g, "").slice(0, 6));
                setPinError("");
              }}
              className={`${SELECT} text-center font-mono text-lg tracking-[0.4em]`}
            />
            {pinError ? <p className="mt-2 text-sm text-red-700">{pinError}</p> : null}
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={closePinModal}
                className="flex-1 rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown disabled:opacity-50"
              >
                {t.cancel}
              </button>
              <button
                type="submit"
                disabled={busy || pin.length !== 6}
                className="flex-1 rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
              >
                {t.confirm}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {tab === "excel" ? (
        <section className="mb-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.excelTab}
          </p>
          <p className="mt-2 max-w-xl text-sm text-brown/50">{excelGini ? t.giniTemplateNote : t.excelHint}</p>
          {excelGini ? (
            <div className="mt-5 grid gap-2 text-sm sm:grid-cols-2">
              <p>{t.giniTotal}: {Number(excelGini.totalProducts || 0).toLocaleString("en-US")}</p>
              <p>{t.giniEligible}: {Number(excelGini.eligible || 0).toLocaleString("en-US")}</p>
              <p>{t.giniInactive}: {Number(excelGini.blockedInactive || 0).toLocaleString("en-US")}</p>
              <p>{t.giniUnmapped}: {Number(excelGini.blockedUnmapped || 0).toLocaleString("en-US")}</p>
              <p>{t.giniMissing}: {Number(excelGini.missingRequired || 0).toLocaleString("en-US")}</p>
              <p>{t.giniRows}: {Number(excelGini.exportRows || 0).toLocaleString("en-US")}</p>
              <p>{t.giniUniqueSkus}: {Number(excelGini.duplicateSkus?.uniqueSkus || 0).toLocaleString("en-US")}</p>
              <p>{t.giniDuplicateSkus}: {Number(excelGini.duplicateSkus?.duplicateSkuValues || 0).toLocaleString("en-US")}</p>
              <p>{t.giniExtraDuplicateRows}: {Number(excelGini.duplicateSkus?.extraDuplicateRows || 0).toLocaleString("en-US")}</p>
              {(excelGini.missing || []).map((item) => (
                <p key={item.code} className="text-amber-900 sm:col-span-2">
                  {item.message}: {Number(item.count || 0).toLocaleString("en-US")}
                </p>
              ))}
              {excelGini.duplicateSkus?.duplicateSkuValues > 0 ? (
                <div className="sm:col-span-2">
                  <p className="text-amber-900">{t.giniDuplicateWarning}</p>
                  <div className="mt-3 max-h-72 space-y-3 overflow-auto">
                    {(excelGini.duplicateSkus.duplicates || []).map((group) => (
                      <div key={group.sku}>
                        <p className="font-semibold">{t.giniSku}: {group.sku}</p>
                        {(group.products || []).map((product) => (
                          <p key={product.productId} className="text-brown/70">
                            {t.giniProductName}: {product.name || "—"} · {t.giniBrand}: {product.brand || "—"} · {t.giniCollection}: {product.collection || "—"} · {t.giniSellingPrice}: {Number(product.sellingPrice || 0).toLocaleString("en-US")} · {t.giniProductId}: {product.productId} · {t.giniIbsherId}: {product.ibsherId || "—"}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {excelTotal != null && !excelGini ? (
            <div className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-brown/50">{t.excelOrderHint}</p>
                <button
                  type="button"
                  onClick={() => {
                    setColumnToDelete(null);
                    setResetOpen(true);
                  }}
                  className="shrink-0 rounded-full bg-cream px-4 py-2 text-xs font-semibold text-brown"
                >
                  {t.excelReset}
                </button>
              </div>
              <ExcelColumnOrder
                columns={excelColumns}
                removeLabel={t.excelDeleteConfirm}
                onRemove={setColumnToDelete}
                onReorder={async (next) => {
                  setExcelColumns(next);
                  setExcelSaved(false);
                  try {
                    const data = await api.savePlatformExcelColumns(
                      partnerSlug,
                      next.map((column) => column.key)
                    );
                    setExcelColumns(data.columns || next);
                    setExcelSaved(true);
                  } catch (err) {
                    setError(err.message || t.excelFailed);
                  }
                }}
              />
              {excelSaved ? (
                <p className="mt-2 text-xs font-semibold text-brown/60">{t.excelOrderSaved}</p>
              ) : null}
            </div>
          ) : null}
          {excelTotal == null ? (
            <p className="mt-5 text-sm text-brown/45">{t.loading}</p>
          ) : excelTotal > 0 ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold text-brown">
                {excelTotal.toLocaleString("en-US")} {t.excelReady}
              </p>
              <button
                type="button"
                disabled={excelBusy}
                onClick={async () => {
                  setExcelBusy(true);
                  setError("");
                  try {
                    await api.downloadPlatformExcel(partnerSlug, lang);
                  } catch (err) {
                    setError(err.message || t.excelFailed);
                  } finally {
                    setExcelBusy(false);
                  }
                }}
                className="rounded-full bg-brown px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
              >
                {excelBusy ? t.loading : t.excelDownload}
              </button>
            </div>
          ) : (
            <p className="mt-5 text-sm text-brown/55">{t.excelEmpty}</p>
          )}
        </section>
      ) : null}

      {tab === "overview" ? (
        <PlatformOverview
          partnerSlug={partnerSlug}
          partner={partner}
          t={t}
          onOpen={setTab}
          onPartner={setPartner}
        />
      ) : null}

      {tab === "connection" && partnerSlug === "gini" ? <GiniApiConnection t={t} /> : null}

      {tab === "syncOne" && partnerSlug === "gini" ? <GiniSyncOneProduct t={t} lang={lang} /> : null}

      {ElryanHost ? <ElryanHost tab={tab} partnerSlug={partnerSlug} t={t} lang={lang} /> : null}

      {tab === "connection" && partnerSlug === "miswag" ? <MiswagApiConnection t={t} /> : null}

      {tab === "syncAll" && partnerSlug === "miswag" ? <MiswagSyncAll t={t} /> : null}

      {tab === "mappingCategories" && partnerSlug === "miswag" ? (
        <MiswagMappingCategories t={t} lang={lang} onNotices={setNoticeCount} />
      ) : null}

      {tab === "mapping" && partnerSlug !== "miswag" ? (
        <CategorySetupPanel
          partnerSlug={partnerSlug}
          t={t}
          lang={lang}
          onNotices={setNoticeCount}
          onOpenConnection={() => setTab("connection")}
        />
      ) : null}

      {tab === "availability" ? (
        <AvailabilityPanel partnerSlug={partnerSlug} t={t} lang={lang} />
      ) : null}

      {tab === "commissions" ? (
      <div className="space-y-6">
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.addCommission}
          </p>
          <p className="mt-2 text-sm text-brown/50">{t.commissionSignHint}</p>
          <form onSubmit={onSave} className="mt-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="shrink-0">
                <div className="flex flex-wrap gap-1 rounded-[1.25rem] bg-cream p-1 sm:rounded-full">
                  {SCOPES.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => {
                        resetFilterControls();
                        setScope(item);
                        setCategoryId("");
                        setSubCategoryId("");
                        setCollectionId("");
                        setBrandId("");
                        setVendorId("");
                      }}
                      className={`rounded-full px-3 py-2 text-[11px] font-semibold sm:px-4 sm:text-xs ${
                        scope === item ? "bg-brown text-cream" : "text-brown/60"
                      }`}
                    >
                      {scopeLabel(t, item)}
                    </button>
                  ))}
                </div>
              </div>
              {scope !== "filter" ? (
              <div className="ms-auto flex items-end gap-3">
                <div className="w-28 shrink-0">
                  <label className="mb-1 block text-xs font-semibold text-brown/50">
                    {t.commissionPercentage}
                  </label>
                  <input
                    type="number"
                    min="-99"
                    max="500"
                    step="0.1"
                    required
                    dir="ltr"
                    placeholder="+10 / -10"
                    value={percentage}
                    onChange={(e) => setPercentage(e.target.value)}
                    className={`${CONTROL} w-full font-medium tabular-nums`}
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="shrink-0 rounded-full bg-brown px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
                >
                  {t.save}
                </button>
              </div>
              ) : null}
            </div>

            {scope === "filter" ? (
              <div className="grid max-w-xl gap-3">
                <p className="text-sm text-brown/50">{t.filterCommissionHint}</p>
                {filterRestoring ? <p className="text-sm text-brown/50">{t.loading}</p> : null}
                <VendorRuleSelect
                  label={t.vendor}
                  required
                  value={vendorId}
                  disabled={filterRestoring}
                  placeholder={t.selectVendor}
                  lang={lang}
                  markedIds={vendorsWithCommission}
                  ruleCounts={vendorCommissionCounts}
                  options={ensureOption(targets.vendors, vendorId, filterLabels?.vendor)}
                  onChange={(value) => onFilterField("vendorId", value)}
                />
                <FilterSelect
                  label={t.productBrand}
                  value={brandId}
                  disabled={filterRestoring || !filterEnabled.brand}
                  placeholder={t.selectBrand}
                  lang={lang}
                  options={ensureOption(filterOptions.brands, brandId, filterLabels?.brand)}
                  onChange={(value) => onFilterField("brandId", value)}
                />
                <FilterSelect
                  label={t.category}
                  value={categoryId}
                  disabled={filterRestoring || !filterEnabled.category}
                  placeholder={t.selectCategory}
                  lang={lang}
                  options={ensureOption(filterOptions.categories, categoryId, filterLabels?.category)}
                  onChange={(value) => onFilterField("categoryId", value)}
                />
                <FilterSelect
                  label={t.subCategory}
                  value={subCategoryId}
                  disabled={filterRestoring || !filterEnabled.subCategory}
                  placeholder={t.allSubCategories}
                  lang={lang}
                  options={ensureOption(
                    filterOptions.subcategories,
                    subCategoryId,
                    filterLabels?.subCategory
                  )}
                  onChange={(value) => onFilterField("subCategoryId", value)}
                />
                <FilterSelect
                  label={t.collection}
                  value={collectionId}
                  disabled={filterRestoring || !filterEnabled.collection}
                  placeholder={t.allCollections}
                  lang={lang}
                  options={ensureOption(
                    filterOptions.collections,
                    collectionId,
                    filterLabels?.collection
                  )}
                  onChange={(value) => onFilterField("collectionId", value)}
                />
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="sm:w-40">
                    <label className="mb-1 block text-xs font-semibold text-brown/50">
                      {t.commissionPercentage}
                    </label>
                    <input
                      type="number"
                      min="-99"
                      max="500"
                      step="0.1"
                      required
                      dir="ltr"
                      placeholder="+10 / -10"
                      value={percentage}
                      onChange={(e) => setPercentage(e.target.value)}
                      className={`${CONTROL} w-full font-medium tabular-nums`}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busy || filterRestoring}
                    className="shrink-0 rounded-full bg-brown px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
                  >
                    {t.save}
                  </button>
                </div>
                {previewTotal != null ? (
                  <p className="text-sm font-semibold text-brown">
                    {t.commissionPreviewCount.replace(
                      "{count}",
                      Number(previewTotal).toLocaleString("en-US")
                    )}
                  </p>
                ) : null}
              </div>
            ) : scope === "vendor" ? (
              <VendorRuleSelect
                label={t.vendor}
                value={vendorId}
                placeholder={t.selectVendor}
                lang={lang}
                markedIds={vendorsWithCommission}
                ruleCounts={vendorCommissionCounts}
                options={targets.vendors || []}
                onChange={setVendorId}
              />
            ) : scope === "brand" ? (
              <div>
                <label className="mb-1 block text-xs font-semibold text-brown/50">
                  {t.productBrand}
                </label>
                <select
                  value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                  className={`${SELECT} max-w-xl`}
                >
                  <option value="">{t.selectBrand}</option>
                  {(targets.brands || []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {optionLabel(item, lang)}
                    </option>
                  ))}
                </select>
              </div>
            ) : scope === "category" || scope === "subcategory" || scope === "collection" ? (
              <div
                className={`grid gap-3 ${
                  scope === "collection" ? "sm:grid-cols-3" : "sm:grid-cols-2"
                }`}
              >
                <div>
                  <label className="mb-1 block text-xs font-semibold text-brown/50">
                    {t.category}
                  </label>
                  <select
                    value={categoryId}
                    onChange={(e) => {
                      setCategoryId(e.target.value);
                      setSubCategoryId("");
                      setCollectionId("");
                    }}
                    className={SELECT}
                  >
                    <option value="">{t.selectCategory}</option>
                    {(targets.categories || []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {optionLabel(item, lang)}
                      </option>
                    ))}
                  </select>
                </div>

                {scope === "subcategory" || scope === "collection" ? (
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-brown/50">
                      {t.subCategory}
                    </label>
                    <select
                      value={subCategoryId}
                      onChange={(e) => {
                        setSubCategoryId(e.target.value);
                        setCollectionId("");
                      }}
                      className={SELECT}
                    >
                      <option value="">{t.selectSubCategory}</option>
                      {subcategories.map((item) => (
                        <option key={item.id} value={item.id}>
                          {optionLabel(item, lang)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {scope === "collection" ? (
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-brown/50">
                      {t.collection}
                    </label>
                    <select
                      value={collectionId}
                      onChange={(e) => setCollectionId(e.target.value)}
                      className={SELECT}
                    >
                      <option value="">{t.selectCollection}</option>
                      {collections.map((item) => (
                        <option key={item.id} value={item.id}>
                          {optionLabel(item, lang)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
            ) : null}
          </form>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
              {t.existingCommissions}
            </p>
            {commissions.length ? (
              <label className="flex items-center gap-2">
                <span className="text-[11px] font-semibold tracking-wide text-brown/45 uppercase">
                  {t.sort}
                </span>
                <select
                  value={commissionSort}
                  onChange={(e) => setCommissionSort(e.target.value)}
                  className="rounded-full border border-brown/10 bg-cream px-3 py-1.5 text-xs font-semibold text-brown outline-none ring-tan/40 focus:ring-2"
                >
                  <option value="date">{t.commissionSortDate}</option>
                  <option value="az">{t.sortAZ}</option>
                  <option value="za">{t.sortZA}</option>
                </select>
              </label>
            ) : null}
          </div>
          {commissions.length ? (
            <div className="mt-4 divide-y divide-brown/5">
              {sortedCommissions.map((rule) => (
                <article
                  key={rule.id}
                  className={`flex gap-3 py-3 ${
                    rule.scope === "filter"
                      ? "flex-col items-stretch sm:flex-row sm:items-start"
                      : "items-center"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => fillFromRule(rule)}
                    className={`min-w-0 text-start ${
                      rule.scope === "filter" ? "w-full sm:flex-1" : "flex-1"
                    }`}
                  >
                    <p className="text-[11px] font-semibold tracking-wide text-tan uppercase">
                      {scopeLabel(t, rule.scope)}
                    </p>
                    {rule.scope === "filter" ? (
                      <dl className="mt-1 space-y-1">
                        {filterPathParts(rule).map((part) => (
                          <div key={part.key} className="min-w-0 sm:flex sm:gap-2">
                            <dt className="shrink-0 text-xs font-semibold text-brown/45">
                              {t[FILTER_LABEL_KEY[part.key]]}
                            </dt>
                            <dd className="break-words font-medium text-brown">
                              {filterPartText(part, t, lang)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="mt-0.5 truncate font-medium">
                        {rule.scope === "all"
                          ? t.allProducts
                          : tName(rule.targetName, lang) || rule.targetId}
                      </p>
                    )}
                  </button>
                  <div
                    className={`flex shrink-0 items-center gap-3 ${
                      rule.scope === "filter" ? "justify-between sm:justify-end" : ""
                    }`}
                  >
                  <p
                    className={`shrink-0 font-display text-xl tabular-nums ${
                      Number(rule.percentage) < 0 ? "text-red-800" : ""
                    }`}
                    dir="ltr"
                  >
                    {formatRate(rule.percentage)}
                  </p>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onToggle(rule)}
                      className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                        rule.isActive
                          ? "bg-emerald-50 text-emerald-800"
                          : "bg-brown/10 text-brown/50"
                      }`}
                    >
                      {rule.isActive ? t.commissionActive : t.commissionInactive}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDelete(rule)}
                      className="rounded-full bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-800 disabled:opacity-50"
                    >
                      {t.deleteAccount}
                    </button>
                  </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-brown/45">{t.noCommissions}</p>
          )}
        </section>
      </div>
      ) : null}

      {tab === "products" ? (
      <section className="overflow-hidden rounded-3xl bg-white p-4 shadow-sm ring-1 ring-brown/5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
              {t.products}
            </p>
            <p className="mt-1 text-sm text-brown/50">{t.platformProductsHint}</p>
            <p className="mt-1 text-sm font-semibold text-brown">
              {fillTemplate(t.showingRange, {
                from: products.pagination?.from || 0,
                to: products.pagination?.to || 0,
                total: Number(products.pagination?.total || 0).toLocaleString("en-US"),
              })}
            </p>
            <p className="text-xs text-brown/45">
              {fillTemplate(t.pageOf, {
                page: products.pagination?.page || productPage,
                pages: products.pagination?.pages || 1,
              })}
            </p>
          </div>
          <input
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            placeholder={t.search}
            className="w-full rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm sm:w-64"
          />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["vendor", t.vendor, t.allVendors, catalogFacets?.vendors],
            ["brand", t.productBrand, t.allBrands, catalogFacets?.brands],
            ["category", t.category, t.allCategories, catalogFacets?.categories],
            ["subCategory", t.subCategory, t.allSubCategories, catalogFacets?.subcategories],
            ["collection", t.collection, t.allCollections, catalogFacets?.collections],
          ].map(([field, label, placeholder, options]) => (
            <label key={field} className="block">
              <span className="mb-1 block text-xs font-semibold text-brown/50">{label}</span>
              <select
                value={productFilters[field]}
                onChange={(e) => changeProductFilter(field, e.target.value)}
                className={SELECT}
              >
                <option value="">{placeholder}</option>
                {(options || []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {optionLabel(option, lang)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {[
            ["all", t.eligibilityAll],
            ["ready", t.ready],
            ["blocked", t.blocked],
            ["missing_setup", t.unmapped],
            ["inactive", t.inactiveExcluded],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setEligibility(id);
                setProductPage(1);
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                eligibility === id ? "bg-brown text-cream" : "bg-cream text-brown/60"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {(products.products || []).length ? (
          <>
            <div className="mt-5 hidden md:block">
              <table className="w-full table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[11%]" />
                  <col className="w-[10%]" />
                  <col className="w-[12%]" />
                  <col className="w-[8%]" />
                  <col className="w-[12%]" />
                  <col className="w-[9%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-brown/10 text-[11px] tracking-wide text-brown/45 uppercase">
                    <th className="py-2 pr-2 font-semibold">{t.products}</th>
                    <th className="py-2 pr-2 font-semibold">{t.sku}</th>
                    <th className="py-2 pr-2 font-semibold">{t.productBrand}</th>
                    <th className="py-2 pr-2 font-semibold">{t.brownstorePrice}</th>
                    <th className="py-2 pr-2 font-semibold">{t.columnCommission}</th>
                    <th className="py-2 pr-2 font-semibold">{t.platformPriceLabel}</th>
                    <th className="py-2 pr-2 font-semibold">{t.status}</th>
                    <th className="py-2 font-semibold">{t.columnActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {(products.products || []).map((item) => (
                    <PlatformTableProduct
                      key={item.id}
                      item={item}
                      t={t}
                      lang={lang}
                      busy={busy}
                      open={priceDetailId === item.id}
                      onEdit={() => openPlatformProduct(item)}
                      onDetails={() =>
                        setPriceDetailId((current) => (current === item.id ? null : item.id))
                      }
                      onToggle={() => togglePlatformProduct(item)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 divide-y divide-brown/10 md:hidden">
              {(products.products || []).map((item) => (
                <PlatformProductCard
                  key={item.id}
                  item={item}
                  t={t}
                  lang={lang}
                  busy={busy}
                  open={priceDetailId === item.id}
                  onEdit={() => openPlatformProduct(item)}
                  onDetails={() =>
                    setPriceDetailId((current) => (current === item.id ? null : item.id))
                  }
                  onToggle={() => togglePlatformProduct(item)}
                />
              ))}
            </div>
          </>
        ) : (
          <p className="mt-8 text-sm text-brown/45">{t.noProducts}</p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-brown/45">{t.pageSize}</span>
            {PRODUCT_PAGE_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => {
                  setProductLimit(size);
                  setProductPage(1);
                }}
                className={`h-8 min-w-8 rounded-full px-2 text-xs font-semibold ${
                  productLimit === size ? "bg-brown text-cream" : "bg-cream text-brown"
                }`}
              >
                {size}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={productPage <= 1}
              onClick={() => setProductPage((current) => Math.max(1, current - 1))}
              className="rounded-full bg-cream px-3 py-1.5 text-xs font-semibold text-brown disabled:opacity-40"
            >
              {t.platformPrevious}
            </button>
            {pageWindow(productPage, products.pagination?.pages || 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setProductPage(n)}
                className={`h-9 min-w-9 rounded-full text-sm ${
                  n === productPage ? "bg-brown text-cream" : "bg-cream text-brown"
                }`}
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              disabled={productPage >= (products.pagination?.pages || 1)}
              onClick={() =>
                setProductPage((current) =>
                  Math.min(products.pagination?.pages || current, current + 1)
                )
              }
              className="rounded-full bg-cream px-3 py-1.5 text-xs font-semibold text-brown disabled:opacity-40"
            >
              {t.platformNext}
            </button>
          </div>
        </div>
      </section>
      ) : null}

      {editing ? (
        <ProductEditor
          product={editing}
          t={t}
          lang={lang}
          mode="platform"
          availability={{
            active: editing.platformActive !== false,
            eligibility: editing.eligibility,
            onToggle: async (active) => {
              setEditBusy(true);
              setEditMessage("");
              try {
                const data = await api.setPlatformAvailability(partnerSlug, {
                  scope: "product",
                  targetId: editing.id,
                  isActive: active,
                });
                setEditing((current) => ({
                  ...(current || {}),
                  platformActive: data.platformActive !== false && data.isActive !== false,
                  eligibility: data.eligibility || current?.eligibility,
                }));
                setEditMessage(t.saved);
                await loadProducts();
              } catch (err) {
                setEditMessage(err.message);
              } finally {
                setEditBusy(false);
              }
            },
          }}
          busy={editBusy}
          message={editMessage}
          onClose={() => setEditing(null)}
          onReset={async () => {
            setEditBusy(true);
            setEditMessage("");
            try {
              const data = await api.resetPlatformProduct(partnerSlug, editing.id);
              setEditing(data.product);
              setEditMessage(t.saved);
              await load();
            } catch (err) {
              setEditMessage(err.message);
            } finally {
              setEditBusy(false);
            }
          }}
          onSave={async (patch) => {
            setEditBusy(true);
            setEditMessage("");
            try {
              const data = await api.patchPlatformProduct(partnerSlug, editing.id, patch);
              setEditing(data.product);
              setEditMessage(t.saved);
              await load();
            } catch (err) {
              setEditMessage(err.message);
            } finally {
              setEditBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

export default function AdminCommissions() {
  const { t, lang } = useLang();
  const { partner } = useParams();
  const slug = String(partner || "").toLowerCase();

  if (slug) return <PartnerCommission key={slug} partnerSlug={slug} t={t} lang={lang} />;
  return <PartnerCards t={t} />;
}
