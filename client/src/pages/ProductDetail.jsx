import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { useLang } from "../context/LangContext";
import { formatPrice, tName } from "../i18n";
import ProductCard from "../components/ProductCard";
import Spinner from "../components/Spinner";

export default function ProductDetail() {
  const { id } = useParams();
  const { t, lang } = useLang();
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [variantIndex, setVariantIndex] = useState(0);
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setLoading(true);
    setVariantIndex(0);
    setImageIndex(0);
    api
      .product(id)
      .then(setPayload)
      .catch(() => setPayload(null))
      .finally(() => setLoading(false));
  }, [id]);

  const product = payload?.product;
  const variant = product?.variants?.[variantIndex] || product?.variants?.[0];
  const images = useMemo(() => variant?.images || [], [variant]);
  const activeImage = images[imageIndex]?.url || product?.image;

  if (loading) return <Spinner label={t.loading} />;
  if (!product) {
    return <p className="py-20 text-center text-brown/50">{t.noProducts}</p>;
  }

  const hasDiscount =
    product.discountPrice > 0 && product.discountPrice < product.price;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="grid gap-10 lg:grid-cols-2">
        <div>
          <div className="overflow-hidden rounded-3xl bg-white ring-1 ring-brown/5">
            {activeImage ? (
              <img
                src={activeImage}
                alt={tName(product.name, lang)}
                className="aspect-square w-full object-cover"
              />
            ) : (
              <div className="flex aspect-square items-center justify-center">
                <img src="/logo-4k.png" alt="" className="h-40 opacity-40" />
              </div>
            )}
          </div>
          {images.length > 1 && (
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {images.map((img, i) => (
                <button
                  key={img._id || i}
                  type="button"
                  onClick={() => setImageIndex(i)}
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl ring-2 ${
                    i === imageIndex ? "ring-tan" : "ring-transparent"
                  }`}
                >
                  <img src={img.url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="text-sm font-semibold text-tan">
            {t.sku}: {product.sku}
          </p>
          <h1 className="mt-2 font-display text-3xl text-brown">
            {tName(product.name, lang)}
          </h1>
          <p className="mt-2 text-sm text-brown/50">
            {tName(product.brand?.name, lang)}
            {product.category ? ` · ${tName(product.category.name, lang)}` : ""}
          </p>

          <div className="mt-6 flex items-end gap-4">
            <p className="font-display text-4xl text-brown">
              {formatPrice(product.sellingPrice, lang)}
            </p>
            {hasDiscount && (
              <p className="pb-1 text-brown/40 line-through">
                {formatPrice(product.price, lang)}
              </p>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                product.inStock
                  ? "bg-emerald-50 text-emerald-800"
                  : "bg-red-50 text-red-700"
              }`}
            >
              {product.inStock ? t.inStock : t.outOfStock}
            </span>
            <span className="text-sm text-brown/60">
              {t.stock}: {product.stock}
            </span>
          </div>

          {product.variants?.length > 1 && (
            <div className="mt-6">
              <p className="mb-2 text-sm font-semibold">{t.colors}</p>
              <div className="flex flex-wrap gap-2">
                {product.variants.map((v, i) => (
                  <button
                    key={v._id || i}
                    type="button"
                    onClick={() => {
                      setVariantIndex(i);
                      setImageIndex(0);
                    }}
                    className={`rounded-full px-3 py-1.5 text-sm ${
                      i === variantIndex
                        ? "bg-brown text-cream"
                        : "bg-white ring-1 ring-brown/10"
                    }`}
                  >
                    {tName(v.color, lang) || `#${i + 1}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-8">
            <h2 className="mb-2 font-semibold">{t.description}</h2>
            <p className="whitespace-pre-wrap leading-7 text-brown/75">
              {tName(product.description, lang)}
            </p>
          </div>
        </div>
      </div>

      {payload.related?.length > 0 && (
        <section className="mt-16">
          <h2 className="mb-6 font-display text-2xl">{t.related}</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {payload.related.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
