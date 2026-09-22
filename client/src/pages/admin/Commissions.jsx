import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Pencil, Plus } from "lucide-react";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import { tName } from "../../i18n";
import { imgUrl } from "../../lib/img";
import Spinner from "../../components/Spinner";
import AdminModal from "../../components/admin/AdminModal";
import ProductEditor, { formatGrouped } from "../../components/admin/ProductEditor";

const SCOPES = ["all", "category", "subcategory", "collection", "vendor"];
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
  if (!image) {
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
      className={`rounded-2xl bg-white object-cover ring-1 ring-brown/10 ${className}`}
    />
  );
}

function PartnerCards({ t }) {
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  function load() {
    return api.adminPlatforms().then((data) => setPartners(data.platforms || data.partners || []));
  }

  useEffect(() => {
    load()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function closeCreate() {
    if (busy) return;
    setCreateOpen(false);
    setName("");
    setImage("");
  }

  async function onCreate(event) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.createPlatform({ name: name.trim(), image });
      setName("");
      setImage("");
      setCreateOpen(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label={t.loading} />;

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-3xl">{t.platforms}</h2>
          <p className="mt-1 text-sm text-brown/50">{t.platformsHint}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setError("");
            setCreateOpen(true);
          }}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brown text-cream shadow-sm transition hover:bg-brown/90"
          aria-label={t.addPlatform}
        >
          <Plus className="h-5 w-5" strokeWidth={2.2} />
        </button>
      </div>
      {error && !createOpen ? <p className="mb-4 text-sm text-red-700">{error}</p> : null}

      {createOpen ? (
        <AdminModal onClose={closeCreate}>
          <form
            className="mx-auto w-full max-w-md rounded-3xl bg-white p-6 shadow-xl ring-1 ring-brown/10"
            onSubmit={onCreate}
          >
            <h3 className="font-display text-2xl">{t.addPlatform}</h3>
            {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
            <label className="mt-5 mb-1 block text-xs font-semibold text-brown/50">
              {t.platformName}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={SELECT}
              placeholder="ibazzar"
              autoFocus
              required
            />
            <div className="mt-4 flex items-center gap-3">
              <PartnerLogo image={image} name={name} className="h-14 w-14" />
              <label className="cursor-pointer rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown">
                {image ? t.platformImageReady : t.platformImage}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    try {
                      setImage(await readFile(file));
                    } catch (err) {
                      setError(err.message);
                    }
                  }}
                />
              </label>
            </div>
            <div className="mt-6 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={closeCreate}
                className="flex-1 rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown"
              >
                {t.cancel}
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="flex-1 rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
              >
                {t.addPlatform}
              </button>
            </div>
          </form>
        </AdminModal>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {partners.map((partner) => (
          <Link
            key={partner.slug}
            to={`/admin/platforms/${partner.slug}`}
            className="group rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5 transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <PartnerLogo image={partner.image} name={partner.name} className="h-16 w-16" />
            <h3 className="mt-4 font-display text-2xl">{partner.name}</h3>
            <p className="mt-1 text-sm text-brown/50">
              {partner.rulesCount || 0} {t.partnerRules}
              {partner.customizedCount
                ? ` · ${partner.customizedCount} ${t.customizedCount}`
                : ""}
            </p>
            <p className="mt-4 text-sm font-semibold text-tan group-hover:text-brown">
              {t.openPlatform} →
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}

const CHANGE_FIELDS = [
  ["sku", "sku"],
  ["price", "price"],
  ["discountPrice", "discountPrice"],
  ["stock", "stock"],
  ["outOfStock", "outOfStock"],
  ["isActive", "status"],
  ["name", "productName"],
  ["description", "description"],
  ["brand", "productBrand"],
  ["category", "category"],
  ["subCategory", "subCategory"],
  ["collectionName", "collection"],
  ["variants", "variants"],
  ["warranty", "warranty"],
  ["keyword", "keywords"],
  ["badge", "badge"],
  ["is_featured", "featured"],
  ["is_new_arrival", "newArrivals"],
  ["is_hot", "hot"],
  ["is_best_seller", "bestSeller"],
];

function isOverrideSet(key, snap) {
  if (key === "outOfStock") return snap.outOfStock === true;
  const value = snap[key];
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function sourceFieldValue(source, key) {
  if (!source) return null;
  if (key === "sku") return source.sku || source.itemCode || "";
  if (key === "price") return Number(source.sellingPrice ?? source.price ?? 0);
  if (key === "discountPrice") return Number(source.discountPrice || 0);
  if (key === "stock") return Number(source.stock || 0);
  if (key === "outOfStock") return Boolean(source.outOfStock);
  if (key === "isActive") return source.isActive !== false;
  if (["is_featured", "is_new_arrival", "is_hot", "is_best_seller"].includes(key)) {
    return Boolean(source[key]);
  }
  return source[key] ?? null;
}

function formatChangeValue(field, value, t, lang) {
  if (value == null || value === "") return "—";
  if (field === "price" || field === "discountPrice") {
    return formatGrouped(value) || "0";
  }
  if (field === "outOfStock") return value ? t.outOfStock : t.inStock;
  if (field === "isActive") return value ? t.commissionActive : t.commissionInactive;
  if (["is_featured", "is_new_arrival", "is_hot", "is_best_seller"].includes(field)) {
    return value ? t.yes : t.no;
  }
  if (field === "name" || field === "description" || field === "warranty") {
    if (typeof value === "object") {
      return tName(value, lang) || Object.values(value).filter(Boolean).join(" · ") || "—";
    }
    return String(value);
  }
  if (["brand", "category", "subCategory", "collectionName"].includes(field)) {
    return tName(value?.name, lang) || "—";
  }
  if (field === "keyword") {
    return Array.isArray(value) ? value.filter(Boolean).join(", ") || "—" : String(value);
  }
  if (field === "variants") {
    const count = Array.isArray(value) ? value.length : 0;
    return `${count} ${t.variants}`;
  }
  return String(value);
}

function listPlatformChanges(item, t, lang) {
  const snap = item?.platformOverrides || item?.overrides || {};
  const source = item?.source || {};
  return CHANGE_FIELDS.filter(([key]) => isOverrideSet(key, snap)).map(([key, labelKey]) => ({
    field: key,
    label: t[labelKey] || key,
    from: formatChangeValue(key, sourceFieldValue(source, key), t, lang),
    to: formatChangeValue(key, snap[key], t, lang),
  }));
}

function PlatformProductRow({ item, t, lang, onEdit, onMessage, showCustomized }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <img
        src={imgUrl(item.image) || "/logo.png"}
        alt=""
        className="h-12 w-12 rounded-xl bg-cream object-cover"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{tName(item.name, lang)}</p>
        <p className="text-xs text-brown/45">
          {item.sku || "—"} ·{" "}
          {item.customPrice && item.storePrice != null
            ? `${formatGrouped(item.storePrice)} → ${formatGrouped(item.platformPrice || 0)}`
            : formatGrouped(item.platformPrice || item.sellingPrice || 0)}
          {showCustomized && item.customized ? ` · ${t.customizedCount}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onMessage ? (
          <button
            type="button"
            onClick={onMessage}
            className="rounded-full bg-cream px-3 py-1.5 text-xs font-semibold text-brown"
          >
            {t.changeMessage}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onEdit}
          className="rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream"
        >
          {t.editProduct}
        </button>
      </div>
    </div>
  );
}

function ChangeMessageDialog({ item, t, lang, onClose }) {
  const changes = listPlatformChanges(item, t, lang);
  return (
    <AdminModal onClose={onClose}>
      <div className="mx-auto w-full max-w-lg rounded-3xl bg-white p-6 shadow-xl ring-1 ring-brown/10">
        <h3 className="font-display text-2xl">{t.changeMessageTitle}</h3>
        <p className="mt-1 truncate text-sm font-medium">{tName(item.name, lang)}</p>
        <p className="mt-2 text-sm text-brown/50">{t.changeMessageHint}</p>
        {changes.length ? (
          <div className="mt-5 divide-y divide-brown/5">
            {changes.map((row) => (
              <article key={row.field} className="py-3">
                <p className="text-[11px] font-semibold tracking-wide text-tan uppercase">
                  {row.label}
                </p>
                <p className="mt-1 text-sm">
                  <span className="text-brown/45">{row.from}</span>
                  <span className="mx-2 text-brown/30">→</span>
                  <span className="font-semibold">{row.to}</span>
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-5 text-sm text-brown/45">{t.noChangeDetails}</p>
        )}
        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream"
        >
          {t.close}
        </button>
      </div>
    </AdminModal>
  );
}

function CopyField({ label, value, t }) {
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

function PartnerCommission({ partnerSlug, t, lang }) {
  const { user } = useAuth();
  const isPrimary = Boolean(user?.isPrimary);
  const [partner, setPartner] = useState(null);
  const [targets, setTargets] = useState({
    categories: [],
    subcategories: [],
    collections: [],
    vendors: [],
  });
  const [commissions, setCommissions] = useState([]);
  const [scope, setScope] = useState("all");
  const [categoryId, setCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [percentage, setPercentage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [plainKey, setPlainKey] = useState("");
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [products, setProducts] = useState({ products: [], pagination: { pages: 1, total: 0 } });
  const [customized, setCustomized] = useState({
    products: [],
    pagination: { page: 1, pages: 1, total: 0 },
  });
  const [productQ, setProductQ] = useState("");
  const [customQ, setCustomQ] = useState("");
  const [customPage, setCustomPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [messageProduct, setMessageProduct] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editMessage, setEditMessage] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editImage, setEditImage] = useState("");
  const [tab, setTab] = useState("products");

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

  function loadDetail() {
    return api.adminPlatform(partnerSlug).then((detail) => {
      const next = detail.platform || detail.partner || null;
      setPartner(next);
      setCommissions(detail.commissions || []);
      setTargets(
        detail.targets || { categories: [], subcategories: [], collections: [], vendors: [] }
      );
    });
  }

  function loadProducts() {
    return api.adminPlatformProducts(partnerSlug, { q: productQ, limit: 20 }).then(setProducts);
  }

  function loadCustomized() {
    return api
      .adminPlatformProducts(partnerSlug, {
        q: customQ,
        limit: 20,
        page: customPage,
        customized: 1,
      })
      .then((data) => {
        setCustomized(data);
        const pages = Number(data.pagination?.pages) || 1;
        setCustomPage((current) => (current > pages ? pages : current));
      });
  }

  function load() {
    return Promise.all([loadDetail(), loadProducts(), loadCustomized()]);
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

  async function openChangeMessage(item) {
    try {
      const data = await api.adminPlatformProduct(partnerSlug, item.id);
      setMessageProduct(data.product || item);
    } catch {
      setMessageProduct(item);
    }
  }

  useEffect(() => {
    setLoading(true);
    setPlainKey("");
    setError("");
    setMessage("");
    setCustomPage(1);
    setCustomQ("");
    setProductQ("");
    setTab("products");
    loadDetail()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [partnerSlug]);

  useEffect(() => {
    const id = setTimeout(() => {
      loadProducts().catch(() => {});
    }, 220);
    return () => clearTimeout(id);
  }, [partnerSlug, productQ]);

  useEffect(() => {
    const id = setTimeout(() => {
      loadCustomized().catch(() => {});
    }, 220);
    return () => clearTimeout(id);
  }, [partnerSlug, customQ, customPage]);

  function resetForm() {
    setCategoryId("");
    setSubCategoryId("");
    setCollectionId("");
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
    setVendorId(rule.scope === "vendor" ? rule.targetId : "");
    setPercentage(String(rule.percentage));
  }

  function targetIdForSave() {
    if (scope === "all") return "*";
    if (scope === "category") return categoryId;
    if (scope === "subcategory") return subCategoryId;
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

  function onRegenerateKey() {
    if (!isPrimary) {
      setError(t.apiKeyPinOnlyPrimary);
      return;
    }
    setError("");
    setMessage("");
    setPin("");
    setPinError("");
    setPinOpen(true);
  }

  async function onConfirmPin(event) {
    event.preventDefault();
    if (!isPrimary) {
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
      const data = await api.regeneratePartnerApiKey(partnerSlug, pin);
      setPartner(data.partner);
      setPlainKey(data.apiKey || "");
      setPinOpen(false);
      setPin("");
    } catch (err) {
      setPinError(t.apiKeyPinInvalid);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label={t.loading} />;
  if (!partner) {
    return <p className="text-sm text-red-700">{error || t.noCommissions}</p>;
  }

  const example = `GET ${partner.catalogUrl}?page=1&limit=100\nX-API-Key: ${plainKey || partner.apiKeyPrefix || "bs_****"}`;

  return (
    <div className="min-w-0">
      <Link
        to="/admin/platforms"
        className="text-sm font-semibold text-brown/50 hover:text-brown"
      >
        ← {t.backToPlatforms}
      </Link>
      <div className="mt-3 mb-6 flex w-full min-w-0 items-center gap-4">
        <PartnerLogo image={partner.image} name={partner.name} className="h-16 w-16" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-3xl">{partner.name}</h2>
          <p className="mt-1 text-sm text-brown/50">{t.commissionSignHint}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setError("");
            setEditName(partner.name || "");
            setEditImage(partner.image || "");
            setEditOpen(true);
          }}
          className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white text-brown shadow-sm ring-1 ring-brown/10 transition hover:bg-cream"
          aria-label={t.editPlatform}
        >
          <Pencil className="h-5 w-5" strokeWidth={2} />
        </button>
      </div>

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
            <div className="mt-4 flex items-center gap-3">
              <PartnerLogo image={editImage} name={editName} className="h-14 w-14" />
              <label className="cursor-pointer rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown">
                {editImage ? t.platformImageReady : t.platformImage}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    try {
                      setEditImage(await readFile(file));
                    } catch (err) {
                      setError(err.message);
                    }
                  }}
                />
              </label>
            </div>
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
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm(t.deletePlatformConfirm)) return;
                setBusy(true);
                try {
                  await api.deletePlatform(partnerSlug);
                  window.location.assign("/admin/platforms");
                } catch (err) {
                  setError(err.message);
                  setBusy(false);
                }
              }}
              className="mt-3 w-full rounded-full bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-800"
            >
              {t.deletePlatform}
            </button>
          </form>
        </AdminModal>
      ) : null}

      <div className="mb-6 grid grid-cols-3 gap-1 rounded-full bg-white p-1 shadow-sm ring-1 ring-brown/5">
        {[
          { id: "products", label: t.products },
          { id: "customized", label: t.customizedProducts, count: partner.customizedCount || 0 },
          { id: "api", label: t.partnerApi },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-full px-2 py-2.5 text-xs font-semibold transition sm:px-4 sm:text-sm ${
              tab === item.id ? "bg-brown text-cream" : "text-brown/55 hover:text-brown"
            }`}
          >
            {item.label}
            {item.count ? ` (${item.count})` : ""}
          </button>
        ))}
      </div>

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
          {plainKey ? (
            <div>
              <CopyField label={t.apiKey} value={plainKey} t={t} />
              <p className="mt-2 text-xs font-semibold text-amber-800">{t.apiKeyOnce}</p>
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs font-semibold text-brown/50">
                {t.apiKey}
              </label>
              <p className="rounded-full bg-cream px-4 py-2.5 font-mono text-sm text-brown/70" dir="ltr">
                {partner.apiKeyPrefix || t.noApiKey}
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
              onClick={onRegenerateKey}
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
            <h3 className="font-display text-2xl">{t.apiKeyPinTitle}</h3>
            <p className="mt-2 text-sm text-brown/50">{t.apiKeyPinHint}</p>
            {partner.hasApiKey ? (
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

      {tab === "products" ? (
      <>
      <div className="space-y-6">
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.addCommission}
          </p>
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

      <section className="mt-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
              {t.products}
            </p>
            <p className="mt-1 text-sm text-brown/50">{t.platformProductsHint}</p>
          </div>
          <input
            value={productQ}
            onChange={(e) => setProductQ(e.target.value)}
            placeholder={t.search}
            className="rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm"
          />
        </div>
        <div className="mt-5 divide-y divide-brown/5">
          {(products.products || []).map((item) => (
            <PlatformProductRow
              key={item.id}
              item={item}
              t={t}
              lang={lang}
              showCustomized
              onEdit={() => openPlatformProduct(item)}
            />
          ))}
        </div>
      </section>
      </>
      ) : null}

      {tab === "customized" ? (
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
                {t.customizedProducts}
              </p>
              <p className="mt-1 text-sm text-brown/50">{t.customizedProductsHint}</p>
            </div>
            <input
              value={customQ}
              onChange={(e) => {
                setCustomPage(1);
                setCustomQ(e.target.value);
              }}
              placeholder={t.search}
              className="rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm"
            />
          </div>
          {(customized.products || []).length ? (
            <div className="mt-5 divide-y divide-brown/5">
              {(customized.products || []).map((item) => (
                <PlatformProductRow
                  key={item.id}
                  item={item}
                  t={t}
                  lang={lang}
                  onEdit={() => openPlatformProduct(item)}
                  onMessage={() => openChangeMessage(item)}
                />
              ))}
            </div>
          ) : (
            <p className="mt-8 text-sm text-brown/45">{t.noCustomizedProducts}</p>
          )}
          {customized.pagination?.pages > 1 ? (
            <div className="mt-4 flex justify-center gap-2">
              {Array.from({ length: customized.pagination.pages }, (_, i) => i + 1)
                .filter(
                  (n) =>
                    n === 1 ||
                    n === customized.pagination.pages ||
                    Math.abs(n - customPage) <= 2
                )
                .map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCustomPage(n)}
                    className={`h-9 min-w-9 rounded-full ${
                      n === customPage ? "bg-brown text-cream" : "bg-cream"
                    }`}
                  >
                    {n}
                  </button>
                ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {messageProduct ? (
        <ChangeMessageDialog
          item={messageProduct}
          t={t}
          lang={lang}
          onClose={() => setMessageProduct(null)}
        />
      ) : null}

      {editing ? (
        <ProductEditor
          product={editing}
          t={t}
          lang={lang}
          mode="platform"
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

  if (slug) return <PartnerCommission partnerSlug={slug} t={t} lang={lang} />;
  return <PartnerCards t={t} />;
}
