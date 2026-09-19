import { useEffect, useMemo, useState } from "react";
import { tName } from "../../i18n";
import { useEscape, useScrollLock } from "../../lib/hooks";

const INPUT =
  "w-full rounded-2xl border border-brown/10 bg-white px-4 py-2.5 text-sm font-medium text-brown outline-none ring-tan/40 focus:ring-2";
const LABEL = "mb-1 block text-xs font-semibold text-brown/50";

export function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function formatGrouped(value) {
  const digits = digitsOnly(value);
  if (!digits) return "";
  return String(BigInt(digits)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function parseGrouped(value) {
  const digits = digitsOnly(value);
  return digits ? Number(digits) : 0;
}

function emptyLoc() {
  return { ku: "", en: "", ar: "" };
}

function fromLoc(value) {
  return {
    ku: String(value?.ku || ""),
    en: String(value?.en || ""),
    ar: String(value?.ar || ""),
  };
}

function locEqual(a, b) {
  return (a?.ku || "") === (b?.ku || "") && (a?.en || "") === (b?.en || "") && (a?.ar || "") === (b?.ar || "");
}

function warrantyFromValue(value) {
  if (value == null || value === "") return emptyLoc();
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value);
    return { ku: text, en: text, ar: text };
  }
  if (typeof value === "object") {
    if (value.ku || value.en || value.ar) return fromLoc(value);
    const text = value.value || value.text || value.label || "";
    if (text !== "") {
      const s = String(text);
      return { ku: s, en: s, ar: s };
    }
  }
  return emptyLoc();
}

function colorText(color) {
  if (!color) return "";
  if (typeof color === "string") return color;
  return color.en || color.ku || color.ar || "";
}

function toColor(text, previous) {
  const value = String(text || "").trim();
  if (previous && typeof previous === "object") {
    return { ...previous, en: value, ku: previous.ku || value, ar: previous.ar || value };
  }
  return { en: value, ku: value, ar: value };
}

function variantsFromProduct(product) {
  return (product?.variants || []).map((variant) => ({
    ...variant,
    colorText: colorText(variant.color),
    imageText: (variant.images || []).map((img) => img.url).filter(Boolean).join("\n"),
    sizes: (variant.sizes || []).map((size) => ({
      ...size,
      label: size.size || size.name || size.label || "",
      stockQuantity: Number(size.stockQuantity) || 0,
    })),
  }));
}

function variantsToPayload(rows) {
  return rows.map((row) => ({
    ...row,
    color: toColor(row.colorText, row.color),
    images: String(row.imageText || "")
      .split("\n")
      .map((url) => url.trim())
      .filter(Boolean)
      .map((url, i) => ({ url, isMain: i === 0 })),
    sizes: (row.sizes || []).map((size) => ({
      ...size,
      size: size.label || size.size,
      stockQuantity: Number(size.stockQuantity) || 0,
    })),
  }));
}

function jsonEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function buildOverridePatch(product, form, { priceMode = "custom" } = {}) {
  const source = product.source || {};
  const patch = {};

  if (form.sku !== (source.sku || source.itemCode || "")) patch.sku = form.sku || null;
  else patch.sku = null;

  if (priceMode === "percent") {
    patch.price = null;
    patch.discountPrice = null;
  } else {
    const price = parseGrouped(form.price);
    const discount = parseGrouped(form.discountPrice);
    const sourcePrice = Number(source.sellingPrice ?? source.price ?? 0);
    const sourceDiscount = Number(source.discountPrice || 0);
    patch.price = price !== sourcePrice ? price : null;
    patch.discountPrice = discount !== sourceDiscount ? discount || null : null;
  }

  const stock = Number(form.stock);
  patch.stock = Number(source.stock) === stock ? null : stock;
  patch.outOfStock = Boolean(form.outOfStock);
  if (form.isActive === Boolean(source.isActive !== false)) patch.isActive = null;
  else patch.isActive = Boolean(form.isActive);

  patch.name = locEqual(form.name, source.name) ? null : form.name;
  patch.description = locEqual(form.description, source.description) ? null : form.description;

  const sourceBrand = fromLoc(source.brand?.name);
  patch.brand = locEqual(form.brand, sourceBrand) ? null : { ...(source.brand || {}), name: form.brand };

  patch.badge = (form.badge || "") === (source.badge || "") ? null : form.badge || null;
  const keywords = String(form.keywords || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const sourceKeywords = Array.isArray(source.keyword) ? source.keyword : [];
  patch.keyword = jsonEqual(keywords, sourceKeywords) ? null : keywords;
  patch.warranty = locEqual(form.warranty, warrantyFromValue(source.warranty))
    ? null
    : form.warranty;

  for (const flag of ["is_featured", "is_new_arrival", "is_hot", "is_best_seller"]) {
    patch[flag] = Boolean(form[flag]) === Boolean(source[flag]) ? null : Boolean(form[flag]);
  }

  const nextVariants = variantsToPayload(form.variants || []);
  patch.variants = jsonEqual(nextVariants, source.variants || product.variants) ? null : nextVariants;
  return patch;
}

function LocFields({ value, onChange }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {["ku", "en", "ar"].map((key) => (
        <div key={key}>
          <label className={LABEL}>{key.toUpperCase()}</label>
          <input
            value={value[key] || ""}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
            className={INPUT}
          />
        </div>
      ))}
    </div>
  );
}

export default function ProductEditor({
  product,
  t,
  lang,
  mode = "store",
  onClose,
  onSave,
  onReset,
  busy,
  message,
}) {
  const source = product?.source || {};
  const [form, setForm] = useState(() => formFromProduct(product));
  const [priceMode, setPriceMode] = useState(product?.customPrice ? "custom" : mode === "platform" ? "percent" : "custom");

  useScrollLock(true);
  useEscape(onClose);

  useEffect(() => {
    setForm(formFromProduct(product));
    setPriceMode(product?.customPrice ? "custom" : mode === "platform" ? "percent" : "custom");
  }, [product, mode]);

  const previewPrice = useMemo(() => {
    if (mode !== "platform") return null;
    if (priceMode === "custom") return parseGrouped(form.price);
    return Number(product.platformPrice || product.storePrice || 0);
  }, [mode, priceMode, form.price, product]);

  if (!product) return null;

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-brown/40" aria-label={t.cancel} onClick={onClose} />
      <div
        className="relative z-10 flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-cream shadow-2xl"
        data-scroll-lock-ignore
      >
        <div className="flex items-start justify-between gap-3 border-b border-brown/10 px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
              {mode === "platform" ? t.platformProduct : t.editProduct}
            </p>
            <h3 className="mt-1 truncate font-display text-2xl">{tName(product.name, lang)}</h3>
            <p className="mt-1 text-xs text-brown/45">
              {t.source}: {product.itemCode || "—"}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-white px-3 py-1.5 text-sm font-semibold">
            {t.close}
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {mode === "platform" ? (
            <section className="rounded-3xl bg-white p-4 ring-1 ring-brown/5">
              <p className={LABEL}>{t.platformPriceMode}</p>
              <div className="mt-2 grid grid-cols-2 gap-2 rounded-full bg-cream p-1">
                {["percent", "custom"].map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setPriceMode(item)}
                    className={`rounded-full px-3 py-2 text-xs font-semibold ${
                      priceMode === item ? "bg-brown text-cream" : "text-brown/60"
                    }`}
                  >
                    {item === "percent" ? t.usePercent : t.customPrice}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-sm text-brown/55">
                {t.storePrice}: {formatGrouped(product.storePrice || source.sellingPrice || source.price || 0)} ·{" "}
                {t.commissionPercentage}: {Number(product.commissionRate || 0)}% · {t.platformPrice}:{" "}
                {formatGrouped(previewPrice || 0)}
              </p>
            </section>
          ) : null}

          <section>
            <p className={LABEL}>{t.productName}</p>
            <LocFields value={form.name} onChange={(name) => setField("name", name)} />
          </section>

          <section>
            <p className={LABEL}>{t.description}</p>
            <div className="grid gap-3">
              {["ku", "en", "ar"].map((key) => (
                <textarea
                  key={key}
                  rows={3}
                  value={form.description[key] || ""}
                  onChange={(e) =>
                    setField("description", { ...form.description, [key]: e.target.value })
                  }
                  className={INPUT}
                  placeholder={key.toUpperCase()}
                />
              ))}
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL}>{t.sku}</label>
              <input value={form.sku} onChange={(e) => setField("sku", e.target.value)} className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>{t.stock}</label>
              <input
                type="number"
                value={form.stock}
                onChange={(e) => setField("stock", e.target.value)}
                className={INPUT}
              />
            </div>
            {(mode === "store" || priceMode === "custom") && (
              <>
                <div>
                  <label className={LABEL}>{t.price}</label>
                  <input
                    dir="ltr"
                    value={form.price}
                    onChange={(e) => setField("price", formatGrouped(e.target.value))}
                    className={`${INPUT} tabular-nums`}
                  />
                </div>
                <div>
                  <label className={LABEL}>{t.discountPrice}</label>
                  <input
                    dir="ltr"
                    value={form.discountPrice}
                    onChange={(e) => setField("discountPrice", formatGrouped(e.target.value))}
                    className={`${INPUT} tabular-nums`}
                  />
                </div>
              </>
            )}
            <div>
              <label className={LABEL}>{t.availability}</label>
              <select
                value={form.outOfStock ? "out" : "in"}
                onChange={(e) => setField("outOfStock", e.target.value === "out")}
                className={INPUT}
              >
                <option value="in">{t.inStock}</option>
                <option value="out">{t.outOfStock}</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>{t.status}</label>
              <select
                value={form.isActive ? "on" : "off"}
                onChange={(e) => setField("isActive", e.target.value === "on")}
                className={INPUT}
              >
                <option value="on">{t.commissionActive}</option>
                <option value="off">{t.commissionInactive}</option>
              </select>
            </div>
          </section>

          <section>
            <p className={LABEL}>{t.productBrand}</p>
            <LocFields value={form.brand} onChange={(brand) => setField("brand", brand)} />
          </section>

          <section>
            <p className={LABEL}>{t.warranty}</p>
            <LocFields value={form.warranty} onChange={(warranty) => setField("warranty", warranty)} />
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL}>{t.badge}</label>
              <input value={form.badge} onChange={(e) => setField("badge", e.target.value)} className={INPUT} />
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL}>{t.keywords}</label>
              <input
                value={form.keywords}
                onChange={(e) => setField("keywords", e.target.value)}
                className={INPUT}
              />
            </div>
          </section>

          <section className="flex flex-wrap gap-2">
            {[
              ["is_featured", t.featured],
              ["is_new_arrival", t.newArrivals],
              ["is_hot", t.deals],
              ["is_best_seller", t.bestSeller],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setField(key, !form[key])}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  form[key] ? "bg-brown text-cream" : "bg-white text-brown/60 ring-1 ring-brown/10"
                }`}
              >
                {label}
              </button>
            ))}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <p className={LABEL}>{t.variants}</p>
              <button
                type="button"
                onClick={() =>
                  setField("variants", [
                    ...form.variants,
                    { colorText: "", imageText: "", sizes: [{ label: "Default", stockQuantity: 0 }] },
                  ])
                }
                className="text-xs font-semibold text-tan"
              >
                {t.addVariant}
              </button>
            </div>
            <div className="space-y-3">
              {form.variants.map((variant, index) => (
                <article key={index} className="rounded-3xl bg-white p-4 ring-1 ring-brown/5">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs font-semibold text-brown/50">
                      {t.colors} {index + 1}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        setField(
                          "variants",
                          form.variants.filter((_, i) => i !== index)
                        )
                      }
                      className="text-xs font-semibold text-red-800"
                    >
                      {t.deleteAccount}
                    </button>
                  </div>
                  <input
                    value={variant.colorText}
                    onChange={(e) => {
                      const next = [...form.variants];
                      next[index] = { ...variant, colorText: e.target.value };
                      setField("variants", next);
                    }}
                    placeholder={t.colors}
                    className={`${INPUT} mb-3`}
                  />
                  <textarea
                    rows={3}
                    value={variant.imageText}
                    onChange={(e) => {
                      const next = [...form.variants];
                      next[index] = { ...variant, imageText: e.target.value };
                      setField("variants", next);
                    }}
                    placeholder={t.imageUrls}
                    className={`${INPUT} mb-3 font-mono text-xs`}
                  />
                  {(variant.sizes || []).map((size, sizeIndex) => (
                    <div key={sizeIndex} className="mb-2 grid grid-cols-[1fr_7rem] gap-2">
                      <input
                        value={size.label}
                        onChange={(e) => {
                          const next = [...form.variants];
                          const sizes = [...(variant.sizes || [])];
                          sizes[sizeIndex] = { ...size, label: e.target.value };
                          next[index] = { ...variant, sizes };
                          setField("variants", next);
                        }}
                        className={INPUT}
                      />
                      <input
                        type="number"
                        value={size.stockQuantity}
                        onChange={(e) => {
                          const next = [...form.variants];
                          const sizes = [...(variant.sizes || [])];
                          sizes[sizeIndex] = { ...size, stockQuantity: e.target.value };
                          next[index] = { ...variant, sizes };
                          setField("variants", next);
                        }}
                        className={INPUT}
                      />
                    </div>
                  ))}
                </article>
              ))}
            </div>
          </section>
        </div>

        <div className="border-t border-brown/10 bg-white p-4">
          {message ? <p className="mb-3 text-sm text-brown/70">{message}</p> : null}
          <div className="flex flex-wrap gap-2">
            {onReset ? (
              <button
                type="button"
                disabled={busy}
                onClick={onReset}
                className="rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-brown disabled:opacity-50"
              >
                {t.resetOverrides}
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => onSave(buildOverridePatch(product, form, { priceMode }))}
              className="ms-auto rounded-full bg-brown px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-50"
            >
              {t.save}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formFromProduct(product) {
  if (!product) {
    return {
      name: emptyLoc(),
      description: emptyLoc(),
      sku: "",
      price: "",
      discountPrice: "",
      stock: 0,
      outOfStock: false,
      isActive: true,
      brand: emptyLoc(),
      badge: "",
      warranty: emptyLoc(),
      keywords: "",
      is_featured: false,
      is_new_arrival: false,
      is_hot: false,
      is_best_seller: false,
      variants: [],
    };
  }
  return {
    name: fromLoc(product.name),
    description: fromLoc(product.description),
    sku: product.sku || "",
    price: formatGrouped(product.sellingPrice ?? product.price ?? 0),
    discountPrice: formatGrouped(product.discountPrice || 0),
    stock: product.stock ?? 0,
    outOfStock: Boolean(product.outOfStock),
    isActive: product.isActive !== false,
    brand: fromLoc(product.brand?.name),
    badge: product.badge || "",
    warranty: warrantyFromValue(product.warranty),
    keywords: Array.isArray(product.keyword) ? product.keyword.join(", ") : "",
    is_featured: Boolean(product.is_featured),
    is_new_arrival: Boolean(product.is_new_arrival),
    is_hot: Boolean(product.is_hot),
    is_best_seller: Boolean(product.is_best_seller),
    variants: variantsFromProduct(product),
  };
}
