import { Link } from "react-router-dom";
import { useLang } from "../context/LangContext";
import { formatPrice, tName } from "../i18n";

export default function ProductCard({ product }) {
  const { lang, t } = useLang();
  if (!product) return null;
  const hasDiscount =
    product.discountPrice > 0 && product.discountPrice < product.price;

  return (
    <Link
      to={`/product/${product.id}`}
      className="group overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-brown/5 transition hover:-translate-y-1 hover:shadow-xl"
    >
      <div className="relative aspect-square overflow-hidden bg-cream">
        {product.image ? (
          <img
            src={product.image}
            alt={tName(product.name, lang)}
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <img src="/logo.png" alt="" className="h-16 opacity-30" />
          </div>
        )}
        <span
          className={`absolute top-3 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            product.inStock
              ? "bg-white/90 text-emerald-800"
              : "bg-white/90 text-red-700"
          } ${lang === "en" ? "left-3" : "right-3"}`}
        >
          {product.inStock ? t.inStock : t.outOfStock}
        </span>
      </div>
      <div className="space-y-2 p-4">
        <p className="text-[11px] font-semibold tracking-wide text-tan">
          {product.sku || "—"}
        </p>
        <h3 className="line-clamp-2 min-h-12 font-medium text-brown">
          {tName(product.name, lang)}
        </h3>
        <div className="flex items-end justify-between gap-2">
          <div>
            <p className="font-display text-lg font-semibold text-brown">
              {formatPrice(product.sellingPrice, lang)}
            </p>
            {hasDiscount && (
              <p className="text-xs text-brown/40 line-through">
                {formatPrice(product.price, lang)}
              </p>
            )}
          </div>
          <p className="text-xs text-brown/50">
            {t.stock}: {product.stock}
          </p>
        </div>
      </div>
    </Link>
  );
}
