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
import ProductEditor, { formatGrouped } from "../../components/admin/ProductEditor";
import AvailabilityPanel from "../../components/admin/platform/AvailabilityPanel";
import CategorySetupPanel from "../../components/admin/platform/CategorySetupPanel";
import MiswagApiConnection from "../../components/admin/platform/MiswagApiConnection";
import MiswagSyncAll from "../../components/admin/platform/MiswagSyncAll";
import PlatformOverview from "../../components/admin/platform/PlatformOverview";
import { reasonLabel, StatusBadge } from "../../components/admin/platform/platformUi";
import { usePlatformNav } from "../../components/admin/platform/platformNav";

const SCOPES = ["all", "category", "subcategory", "collection", "brand", "vendor"];
const CONTROL =
  "rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";
const SELECT = `w-full ${CONTROL}`;

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
  return t.category;
}

function formatRate(value) {
  const n = Number(value) || 0;
  return n > 0 ? `+${n}%` : `${n}%`;
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

function PlatformProductRow({ item, t, lang, busy, onEdit, onToggle }) {
  const eligible = item.eligibility ? item.eligibility.eligible : item.platformActive !== false;
  const reasons = item.eligibility?.reasons || [];
  return (
    <div className="flex items-center gap-3 py-3">
      <img
        src={imgUrl(item.image) || "/logo.png"}
        alt=""
        className="h-12 w-12 rounded-xl bg-cream object-cover"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-medium">{tName(item.name, lang)}</p>
          <StatusBadge kind={eligible ? "ready" : "blocked"} t={t} />
          <StatusBadge kind={item.platformActive === false ? "inactive" : "active"} t={t} />
        </div>
        <p className="text-xs text-brown/45">
          {item.sku || "—"} · {formatGrouped(item.platformPrice || item.sellingPrice || 0)}
        </p>
        {!eligible && reasons.length ? (
          <p className="mt-1 text-xs text-red-800">
            {reasons.map((reason) => reasonLabel(t, reason)).join(" · ")}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onToggle}
        className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
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
        className="shrink-0 rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream"
      >
        {t.editProduct}
      </button>
    </div>
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
  const [scope, setScope] = useState("all");
  const [categoryId, setCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [percentage, setPercentage] = useState("");
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
  const [productQ, setProductQ] = useState("");
  const [productPage, setProductPage] = useState(1);
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
  const [eligibility, setEligibility] = useState("all");
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

  const preview = useMemo(() => {
    if (scope === "category" && categoryId) return { category: categoryId };
    if (scope === "subcategory" && subCategoryId) return { subCategory: subCategoryId };
    if (scope === "collection" && collectionId) return { collection: collectionId };
    if (scope === "brand" && brandId) return { brand: brandId };
    if (scope === "vendor" && vendorId) return { vendor: vendorId };
    return {};
  }, [scope, categoryId, subCategoryId, collectionId, brandId, vendorId]);
  const previewKey = JSON.stringify(preview);
  const productListKey = `${partnerSlug}|${productQ}|${previewKey}|${eligibility}`;
  const [seenProductListKey, setSeenProductListKey] = useState(productListKey);
  if (productListKey !== seenProductListKey) {
    setSeenProductListKey(productListKey);
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

  function loadProducts() {
    return api
      .adminPlatformProducts(partnerSlug, {
        q: productQ,
        limit: 20,
        page: productPage,
        eligibility,
        ...preview,
      })
      .then((data) => {
        setProducts(data);
        const pages = Number(data.pagination?.pages) || 1;
        setProductPage((current) => (current > pages ? pages : current));
      });
  }

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

  useEffect(() => {
    setLoading(true);
    setPlainKey("");
    setError("");
    setMessage("");
    setProductQ("");
    setProductPage(1);
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
    let ignore = false;
    const id = setTimeout(() => {
      api
        .adminPlatformProducts(partnerSlug, {
          q: productQ,
          limit: 20,
          page: productPage,
          eligibility,
          ...preview,
        })
        .then((data) => {
          if (ignore) return;
          setProducts(data);
          const pages = Number(data.pagination?.pages) || 1;
          setProductPage((current) => (current > pages ? pages : current));
        })
        .catch(() => {});
    }, 220);
    return () => {
      ignore = true;
      clearTimeout(id);
    };
  }, [partnerSlug, productQ, productPage, previewKey, eligibility]);

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

  function resetForm() {
    setCategoryId("");
    setSubCategoryId("");
    setCollectionId("");
    setBrandId("");
    setVendorId("");
    setPercentage("");
  }

  function fillFromRule(rule) {
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
    const targetId = targetIdForSave();
    const rate = Number(percentage);
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

      {tab === "connection" && partnerSlug === "miswag" ? <MiswagApiConnection t={t} /> : null}

      {tab === "syncAll" && partnerSlug === "miswag" ? <MiswagSyncAll t={t} /> : null}

      {tab === "mapping" ? (
        <CategorySetupPanel
          partnerSlug={partnerSlug}
          t={t}
          lang={lang}
          onNotices={setNoticeCount}
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
            </div>

            {scope === "vendor" ? (
              <div>
                <label className="mb-1 block text-xs font-semibold text-brown/50">
                  {t.vendor}
                </label>
                <select
                  value={vendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                  className={`${SELECT} max-w-xl`}
                >
                  <option value="">{t.selectVendor}</option>
                  {(targets.vendors || []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {optionLabel(item, lang)}
                    </option>
                  ))}
                </select>
              </div>
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
            ) : scope !== "all" ? (
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
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.existingCommissions}
          </p>
          {commissions.length ? (
            <div className="mt-4 divide-y divide-brown/5">
              {commissions.map((rule) => (
                <article key={rule.id} className="flex items-center gap-3 py-3">
                  <button
                    type="button"
                    onClick={() => fillFromRule(rule)}
                    className="min-w-0 flex-1 text-start"
                  >
                    <p className="text-[11px] font-semibold tracking-wide text-tan uppercase">
                      {scopeLabel(t, rule.scope)}
                    </p>
                    <p className="mt-0.5 truncate font-medium">
                      {rule.scope === "all"
                        ? t.allProducts
                        : tName(rule.targetName, lang) || rule.targetId}
                    </p>
                  </button>
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
      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
              {t.products}
            </p>
            <p className="mt-1 text-sm text-brown/50">{t.platformProductsHint}</p>
            {Object.keys(preview).length ? (
              <p className="mt-1 text-sm font-semibold text-brown">
                {t.commissionPreviewCount.replace(
                  "{count}",
                  Number(products.pagination?.total || 0).toLocaleString("en-US")
                )}
              </p>
            ) : null}
          </div>
          <input
            value={productQ}
            onChange={(e) => setProductQ(e.target.value)}
            placeholder={t.search}
            className="rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {[
            ["all", t.eligibilityAll],
            ["ready", t.ready],
            ["blocked", t.blocked],
            ["missing_setup", t.unmapped],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setEligibility(id)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                eligibility === id ? "bg-brown text-cream" : "bg-cream text-brown/60"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {(products.products || []).length ? (
          <div className="mt-5 divide-y divide-brown/5">
            {(products.products || []).map((item) => (
              <PlatformProductRow
                key={item.id}
                item={item}
                t={t}
                lang={lang}
                busy={busy}
                onEdit={() => openPlatformProduct(item)}
                onToggle={async () => {
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
                }}
              />
            ))}
          </div>
        ) : (
          <p className="mt-8 text-sm text-brown/45">{t.noProducts}</p>
        )}
        {products.pagination?.pages > 1 ? (
          <div className="mt-4 flex justify-center gap-2">
            {Array.from({ length: products.pagination.pages }, (_, i) => i + 1)
              .filter(
                (n) =>
                  n === 1 ||
                  n === products.pagination.pages ||
                  Math.abs(n - productPage) <= 2
              )
              .map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setProductPage(n)}
                  className={`h-9 min-w-9 rounded-full ${
                    n === productPage ? "bg-brown text-cream" : "bg-cream"
                  }`}
                >
                  {n}
                </button>
              ))}
          </div>
        ) : null}
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
