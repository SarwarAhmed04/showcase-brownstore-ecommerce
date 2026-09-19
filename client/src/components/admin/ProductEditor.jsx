import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { tName } from "../../i18n";
import { formatWarranty, normalizeWarranty, warrantyPayload } from "../../lib/warranty";
import AdminModal from "./AdminModal";

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

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

function variantsToPayload(rows, mainUrl) {
  const main = String(mainUrl || "").trim();
  return rows.map((row, variantIndex) => {
    let images = imageUrlsFromText(row.imageText).map((url) => ({
      url,
      isMain: Boolean(main) && url === main,
    }));
    const mainIndex = images.findIndex((img) => img.isMain);
    if (mainIndex > 0) {
      const [item] = images.splice(mainIndex, 1);
      images.unshift(item);
    }
    if (variantIndex === 0 && images.length && !images.some((img) => img.isMain) && !main) {
      images[0] = { ...images[0], isMain: true };
    }
    return {
      ...row,
      color: toColor(row.colorText, row.color),
      images,
      sizes: (row.sizes || []).map((size) => ({
        ...size,
        size: size.label || size.size,
        stockQuantity: Number(size.stockQuantity) || 0,
      })),
    };
  });
}

function imageUrlsFromText(text) {
  return String(text || "")
    .split("\n")
    .map((url) => url.trim())
    .filter(Boolean);
}

function mainImageUrl(product) {
  for (const variant of product?.variants || []) {
    const marked = (variant.images || []).find((img) => img?.isMain && img.url);
    if (marked?.url) return marked.url;
  }
  return product?.image || product?.variants?.[0]?.images?.[0]?.url || "";
}

function editorImages(product, form) {
  const urls = [];
  const seen = new Set();
  function push(url) {
    const next = String(url || "").trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
    urls.push(next);
  }
  push(form?.mainUrl);
  push(product?.image);
  for (const variant of form?.variants || []) {
    for (const url of imageUrlsFromText(variant.imageText)) push(url);
  }
  return urls;
}

function ImageGrid({ urls, className = "grid grid-cols-3 gap-2 sm:grid-cols-4" }) {
  if (!urls.length) return null;
  return (
    <div className={className}>
      {urls.map((url) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-2xl bg-white ring-1 ring-brown/10"
        >
          <img src={url} alt="" className="aspect-square h-full w-full object-cover" />
        </a>
      ))}
    </div>
  );
}

function ProductGallery({ urls, mainUrl, onSetMain, t }) {
  const scroller = useRef(null);
  const drag = useRef(null);
  const skipClick = useRef(false);
  const [active, setActive] = useState(mainUrl || urls[0] || "");
  const [overflow, setOverflow] = useState(false);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  useEffect(() => {
    setActive((current) => {
      if (urls.includes(current)) return current;
      if (urls.includes(mainUrl)) return mainUrl;
      return urls[0] || "";
    });
  }, [urls, mainUrl]);

  function updateArrows() {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const hasOverflow = max > 8;
    setOverflow(hasOverflow);
    const first = el.firstElementChild;
    const last = el.lastElementChild;
    if (!hasOverflow || !first || !last) {
      setCanLeft(false);
      setCanRight(false);
      return;
    }
    const box = el.getBoundingClientRect();
    setCanLeft(first.getBoundingClientRect().left < box.left - 8);
    setCanRight(last.getBoundingClientRect().right > box.right + 8);
  }

  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    updateArrows();
    const frame = requestAnimationFrame(updateArrows);
    const onScroll = () => updateArrows();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    window.addEventListener("resize", updateArrows);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", updateArrows);
    };
  }, [urls]);

  function scrollVisual(dir) {
    const el = scroller.current;
    if (!el) return;
    const amount = Math.min(el.clientWidth * 0.75, 220);
    const rtl = getComputedStyle(el).direction === "rtl";
    el.scrollBy({ left: (rtl ? -dir : dir) * amount, behavior: "smooth" });
  }

  function onPointerDown(event) {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const el = scroller.current;
    if (!el) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      scroll: el.scrollLeft,
      moved: false,
    };
    el.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    const el = scroller.current;
    const state = drag.current;
    if (!el || !state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) < 6) return;
    state.moved = true;
    el.scrollLeft = state.scroll - dx;
  }

  function endDrag(event) {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    skipClick.current = state.moved;
    drag.current = null;
    scroller.current?.releasePointerCapture?.(event.pointerId);
  }

  if (!urls.length) return null;

  const preview = urls.includes(active) ? active : urls[0];
  const isMain = preview === mainUrl;
  const arrowClass =
    "absolute top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white text-brown shadow-sm ring-1 ring-brown/10 transition disabled:opacity-30";

  return (
    <div>
      <div className="overflow-hidden rounded-[1.5rem] bg-white ring-1 ring-brown/10">
        <img src={preview} alt="" className="mx-auto max-h-[22rem] w-full object-contain" />
      </div>
      {urls.length > 1 ? (
        <div className="relative mt-3">
          <div
            ref={scroller}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={`flex gap-2 overflow-x-auto py-1 no-scrollbar ${
              overflow ? "cursor-grab px-10 active:cursor-grabbing" : "justify-center px-1"
            }`}
          >
            {urls.map((url) => {
              const selected = url === preview;
              const marked = url === mainUrl;
              return (
                <button
                  key={url}
                  type="button"
                  onClick={() => {
                    if (skipClick.current) {
                      skipClick.current = false;
                      return;
                    }
                    setActive(url);
                  }}
                  className={`shrink-0 rounded-[1.15rem] p-[3px] transition ${
                    selected ? "bg-brown" : "bg-brown/15 hover:bg-brown/40"
                  }`}
                  aria-pressed={selected}
                  aria-label={marked ? t.mainImage : t.gallery}
                >
                  <span className="pointer-events-none relative block h-16 w-16 overflow-hidden rounded-[1rem] bg-white">
                    <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
                    {marked ? (
                      <span className="absolute inset-x-0 bottom-0 bg-brown/80 py-0.5 text-[9px] font-semibold text-cream">
                        {t.mainImage}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          {overflow ? (
            <>
              <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-cream to-transparent" />
              <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-cream to-transparent" />
              <button
                type="button"
                aria-label={t.scrollPrev}
                disabled={!canLeft}
                onClick={() => scrollVisual(-1)}
                className={`${arrowClass} left-0`}
              >
                <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
              </button>
              <button
                type="button"
                aria-label={t.scrollNext}
                disabled={!canRight}
                onClick={() => scrollVisual(1)}
                className={`${arrowClass} right-0`}
              >
                <ChevronRight className="h-4 w-4" strokeWidth={2.2} />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {urls.length > 1 ? (
        <div className="mt-3 flex justify-center">
          {isMain ? (
            <p className="text-xs font-semibold text-brown/45">{t.mainImage}</p>
          ) : (
            <button
              type="button"
              onClick={() => onSetMain(preview)}
              className="rounded-full bg-brown px-4 py-2 text-xs font-semibold text-cream"
            >
              {t.setMainImage}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
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
  const sourceWarranty = warrantyPayload(source.warranty);
  const nextWarranty = warrantyPayload(form.warranty);
  patch.warranty = jsonEqual(nextWarranty, sourceWarranty) ? null : nextWarranty;

  for (const flag of ["is_featured", "is_new_arrival", "is_hot", "is_best_seller"]) {
    patch[flag] = Boolean(form[flag]) === Boolean(source[flag]) ? null : Boolean(form[flag]);
  }

  const nextVariants = variantsToPayload(form.variants || [], form.mainUrl);
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

  useEffect(() => {
    setForm(formFromProduct(product));
    setPriceMode(product?.customPrice ? "custom" : mode === "platform" ? "percent" : "custom");
  }, [product, mode]);

  const previewPrice = useMemo(() => {
    if (mode !== "platform") return null;
    if (priceMode === "custom") return parseGrouped(form.price);
    return Number(product.platformPrice || product.storePrice || 0);
  }, [mode, priceMode, form.price, product]);

  const images = useMemo(() => editorImages(product, form), [product, form]);

  if (!product) return null;

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <AdminModal onClose={onClose}>
      <div className="mx-auto flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-[1.75rem] bg-cream shadow-2xl ring-1 ring-brown/10">
        <div className="flex items-start justify-between gap-3 border-b border-brown/10 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {form.mainUrl || product.image ? (
              <img
                src={form.mainUrl || product.image}
                alt=""
                className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-1 ring-brown/10"
              />
            ) : null}
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
                {mode === "platform" ? t.platformProduct : t.editProduct}
              </p>
              <h3 className="mt-1 truncate font-display text-2xl">{tName(product.name, lang)}</h3>
              <p className="mt-1 text-xs text-brown/45">
                {t.source}: {product.itemCode || "—"}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-white px-3 py-1.5 text-sm font-semibold">
            {t.close}
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section>
            <p className={LABEL}>{t.gallery}</p>
            {images.length ? (
              <ProductGallery
                urls={images}
                mainUrl={form.mainUrl || images[0]}
                onSetMain={(url) => setField("mainUrl", url)}
                t={t}
              />
            ) : (
              <p className="text-sm text-brown/45">{t.bannerEmpty}</p>
            )}
          </section>
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

          <section className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL}>{t.badge}</label>
              <input value={form.badge} onChange={(e) => setField("badge", e.target.value)} className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>{t.warranty}</label>
              <div className="grid grid-cols-[1fr_7rem] gap-2">
                <input
                  type="number"
                  min="0"
                  dir="ltr"
                  value={form.warranty.duration}
                  onChange={(e) =>
                    setField("warranty", { ...form.warranty, duration: e.target.value })
                  }
                  className={INPUT}
                />
                <select
                  value={form.warranty.unit}
                  onChange={(e) =>
                    setField("warranty", { ...form.warranty, unit: e.target.value })
                  }
                  className={INPUT}
                >
                  <option value="years">{t.warrantyYears}</option>
                  <option value="months">{t.warrantyMonths}</option>
                  <option value="days">{t.warrantyDays}</option>
                </select>
              </div>
              {formatWarranty(form.warranty, t) ? (
                <p className="mt-1 text-xs text-brown/45">{formatWarranty(form.warranty, t)}</p>
              ) : null}
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
                  <ImageGrid
                    urls={imageUrlsFromText(variant.imageText)}
                    className="mb-3 grid grid-cols-4 gap-2"
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
    </AdminModal>
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
      warranty: { duration: "", unit: "years", description: "" },
      keywords: "",
      is_featured: false,
      is_new_arrival: false,
      is_hot: false,
      is_best_seller: false,
      variants: [],
      mainUrl: "",
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
    warranty: normalizeWarranty(product.warranty),
    keywords: Array.isArray(product.keyword) ? product.keyword.join(", ") : "",
    is_featured: Boolean(product.is_featured),
    is_new_arrival: Boolean(product.is_new_arrival),
    is_hot: Boolean(product.is_hot),
    is_best_seller: Boolean(product.is_best_seller),
    variants: variantsFromProduct(product),
    mainUrl: mainImageUrl(product),
  };
}
