import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Pencil, Plus } from "lucide-react";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import { tName } from "../../i18n";
import Spinner from "../../components/Spinner";
import AdminModal from "../../components/admin/AdminModal";
import ProductEditor, { formatGrouped } from "../../components/admin/ProductEditor";

const EDIT_MODES = ["one", "vendor", "category", "subcategory", "collection", "all"];
const SELECT =
  "w-full rounded-full border border-brown/10 bg-cream px-4 py-2.5 text-sm font-semibold text-brown outline-none ring-tan/40 focus:ring-2";

function optionLabel(item, lang) {
  const name = tName(item.name, lang) || item.id;
  const count = Number(item.products) || 0;
  return count ? `${name} (${count.toLocaleString("en-US")})` : name;
}

function editModeLabel(t, mode) {
  if (mode === "one") return t.editByOne;
  if (mode === "vendor") return t.vendor;
  if (mode === "subcategory") return t.subCategory;
  if (mode === "collection") return t.collection;
  if (mode === "all") return t.allCommission;
  return t.category;
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
      src={image}
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

function CopyField({ label, value, t }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-brown/50">{label}</label>
      <div className="flex gap-2">
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
  const [scope, setScope] = useState("one");
  const [categoryId, setCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [vendorQ, setVendorQ] = useState("");
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
  const [productQ, setProductQ] = useState("");
  const [productPage, setProductPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editMessage, setEditMessage] = useState("");
  const [platformName, setPlatformName] = useState("");
  const [savedReady, setSavedReady] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftImage, setDraftImage] = useState("");

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

  const vendorOptions = useMemo(() => {
    const list = targets.vendors || [];
    const q = vendorQ.trim().toLowerCase();
    const filtered = !q
      ? list
      : list.filter((item) => {
          const name = item.name || {};
          return [name.ku, name.en, name.ar, item.id].some((value) =>
            String(value || "").toLowerCase().includes(q)
          );
        });
    if (vendorId && !filtered.some((item) => item.id === vendorId)) {
      const selected = list.find((item) => item.id === vendorId);
      if (selected) return [selected, ...filtered];
    }
    return filtered;
  }, [targets.vendors, vendorQ, vendorId]);

  function loadDetail() {
    return api.adminPlatform(partnerSlug).then((detail) => {
      const next = detail.platform || detail.partner || null;
      setPartner(next);
      setPlatformName(next?.name || "");
      setCommissions(detail.commissions || []);
      setTargets(detail.targets || { categories: [], subcategories: [], collections: [], vendors: [] });
    });
  }

  function loadProducts() {
    const params = { q: productQ, limit: 30, page: productPage };
    if (scope === "vendor" && vendorId) params.brand = vendorId;
    if ((scope === "category" || scope === "subcategory" || scope === "collection") && categoryId) {
      params.category = categoryId;
    }
    if ((scope === "subcategory" || scope === "collection") && subCategoryId) {
      params.subcategory = subCategoryId;
    }
    if (scope === "collection" && collectionId) params.collection = collectionId;
    return api.adminPlatformProducts(partnerSlug, params).then(setProducts);
  }

  function load() {
    return Promise.all([loadDetail(), loadProducts()]);
  }

  useEffect(() => {
    setLoading(true);
    setPlainKey("");
    setError("");
    setMessage("");
    loadDetail()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [partnerSlug]);

  useEffect(() => {
    const id = setTimeout(() => {
      loadProducts().catch(() => {});
    }, 220);
    return () => clearTimeout(id);
  }, [partnerSlug, productQ, productPage, scope, vendorId, categoryId, subCategoryId, collectionId]);

  function resetForm() {
    setCategoryId("");
    setSubCategoryId("");
    setCollectionId("");
    setVendorId("");
    setVendorQ("");
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
    setVendorQ("");
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
    if (scope === "one") return;
    const targetId = targetIdForSave();
    const rate = Number(percentage);
    if (scope !== "all" && !targetId) {
      setError(
        scope === "collection"
          ? t.selectCollection
          : scope === "subcategory"
            ? t.selectSubCategory
            : scope === "vendor"
              ? t.selectVendor
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
      setSavedReady(true);
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
  const canMakeKey =
    savedReady || partner.hasApiKey || commissions.length > 0 || Number(partner.customizedCount) > 0;
  const pages = Math.max(1, Number(products.pagination?.pages) || 1);

  return (
    <div>
      <Link
        to="/admin/platforms"
        className="text-sm font-semibold text-brown/50 hover:text-brown"
      >
        ← {t.backToPlatforms}
      </Link>

      <div className="mt-3 mb-6 flex items-center gap-4">
        <PartnerLogo image={partner.image} name={partner.name} className="h-16 w-16" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate font-display text-3xl">{partner.name}</h2>
            <button
              type="button"
              onClick={() => {
                setDraftName(partner.name || "");
                setDraftImage("");
                setPlatformName(partner.name || "");
                setMetaOpen(true);
              }}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-brown ring-1 ring-brown/10 hover:bg-cream"
              aria-label={t.editPlatform}
            >
              <Pencil className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
          <p className="mt-1 text-sm text-brown/45">{t.platformHeading}</p>
        </div>
      </div>

      <div className="mb-6 flex gap-1 rounded-full bg-white p-1 ring-1 ring-brown/10">
        <span className="rounded-full bg-brown px-4 py-2 text-sm font-semibold text-cream">
          {t.tabEditProducts}
        </span>
      </div>

      {error ? <p className="mb-4 text-sm text-red-700">{error}</p> : null}
      {message ? <p className="mb-4 text-sm text-brown/70">{message}</p> : null}

      {metaOpen ? (
        <AdminModal onClose={() => !busy && setMetaOpen(false)}>
          <form
            className="mx-auto w-full max-w-md rounded-3xl bg-white p-6 shadow-xl ring-1 ring-brown/10"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                const body = { name: draftName.trim() };
                if (draftImage) body.image = draftImage;
                const data = await api.patchPlatform(partnerSlug, body);
                setPartner(data.platform);
                setPlatformName(data.platform?.name || draftName);
                setMessage(t.platformSaved);
                setMetaOpen(false);
                setDraftImage("");
              } catch (err) {
                setError(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <h3 className="font-display text-2xl">{t.editPlatform}</h3>
            <label className="mt-5 mb-1 block text-xs font-semibold text-brown/50">
              {t.platformName}
            </label>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              className={SELECT}
              required
            />
            <div className="mt-4 flex items-center gap-3">
              <PartnerLogo
                image={draftImage || partner.image}
                name={draftName || partner.name}
                className="h-14 w-14"
              />
              <label className="cursor-pointer rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown">
                {draftImage ? t.platformImageReady : t.platformImage}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      setDraftImage(await readFile(file));
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
                onClick={() => setMetaOpen(false)}
                className="flex-1 rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown"
              >
                {t.cancel}
              </button>
              <button
                type="submit"
                disabled={busy || !draftName.trim()}
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

      {pinOpen ? (
        <AdminModal onClose={closePinModal}>
          <form
            onSubmit={onConfirmPin}
            className="mx-auto w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl ring-1 ring-brown/10"
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
        </AdminModal>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.addCommission}
          </p>
          <form onSubmit={onSave} className="mt-5 space-y-4">
            <div className="flex flex-wrap gap-1 rounded-3xl bg-cream p-1">
              {EDIT_MODES.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setScope(item);
                    setProductPage(1);
                    setSubCategoryId("");
                    setCollectionId("");
                    setVendorId("");
                    setVendorQ("");
                    if (item === "all" || item === "vendor" || item === "one") {
                      setCategoryId("");
                    }
                  }}
                  className={`rounded-full px-3 py-2 text-[11px] font-semibold sm:text-xs ${
                    scope === item ? "bg-brown text-cream" : "text-brown/60"
                  }`}
                >
                  {editModeLabel(t, item)}
                </button>
              ))}
            </div>

            {scope === "vendor" ? (
              <div className="space-y-2">
                <label className="mb-1 block text-xs font-semibold text-brown/50">
                  {t.vendor}
                </label>
                <input
                  type="search"
                  value={vendorQ}
                  onChange={(e) => setVendorQ(e.target.value)}
                  placeholder={t.vendorSearch}
                  className={SELECT}
                />
                <select
                  value={vendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                  className={SELECT}
                >
                  <option value="">{t.selectVendor}</option>
                  {vendorOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {optionLabel(item, lang)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {scope !== "all" && scope !== "vendor" && scope !== "one" ? (
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
            ) : null}

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

            {scope !== "one" ? (
            <div>
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
                className={`${SELECT} font-medium tabular-nums`}
              />
            </div>
            ) : null}

            {scope !== "one" ? (
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-full bg-brown px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
            >
              {t.groupRateSave}
            </button>
            ) : (
              <p className="text-sm text-brown/50">{t.platformProductsHint}</p>
            )}
          </form>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
            {t.existingCommissions}
          </p>
          {commissions.length ? (
            <div className="mt-5 grid gap-3">
              {commissions.map((rule) => (
                <article
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-cream p-4 ring-1 ring-brown/5"
                >
                  <button
                    type="button"
                    onClick={() => fillFromRule(rule)}
                    className="min-w-0 flex-1 text-start"
                  >
                    <p className="text-[11px] font-semibold tracking-wide text-tan uppercase">
                      {scopeLabel(t, rule.scope)}
                    </p>
                    <p className="mt-1 truncate font-medium">
                      {rule.scope === "all"
                        ? t.allProducts
                        : tName(rule.targetName, lang) || rule.targetId}
                    </p>
                  </button>
                  <p
                    className={`font-display text-2xl tabular-nums ${
                      Number(rule.percentage) < 0 ? "text-red-800" : ""
                    }`}
                    dir="ltr"
                  >
                    {formatRate(rule.percentage)}
                  </p>
                  <div className="flex items-center gap-2">
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
            <p className="mt-5 text-sm text-brown/45">{t.noCommissions}</p>
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
            onChange={(e) => {
              setProductQ(e.target.value);
              setProductPage(1);
            }}
            placeholder={t.search}
            className="rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm"
          />
        </div>
        <div className="mt-5 divide-y divide-brown/5">
          {(products.products || []).map((item) => (
            <div key={item.id} className="flex items-center gap-3 py-3">
              <img
                src={item.image || "/logo.png"}
                alt=""
                className="h-12 w-12 rounded-xl bg-cream object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{tName(item.name, lang)}</p>
                <p className="text-xs text-brown/45">
                  {item.sku || "—"} · {formatGrouped(item.platformPrice || item.sellingPrice || 0)}
                  {item.customized ? ` · ${t.customizedCount}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  setEditMessage("");
                  try {
                    const data = await api.adminPlatformProduct(partnerSlug, item.id);
                    setEditing(data.product || item);
                  } catch {
                    setEditing(item);
                  }
                }}
                className="rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream"
              >
                {t.editProduct}
              </button>
            </div>
          ))}
        </div>
        {pages > 1 ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setProductPage(n)}
                className={`h-9 min-w-9 rounded-full px-3 text-sm font-semibold ${
                  n === productPage ? "bg-brown text-cream" : "bg-cream text-brown"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="mt-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.generateApiKey}
        </p>
        <p className="mt-2 text-sm text-brown/50">
          {canMakeKey ? t.apiKeyHint : t.saveThenApiKey}
        </p>
        {canMakeKey ? (
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
        ) : null}
      </section>

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
              setSavedReady(true);
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
