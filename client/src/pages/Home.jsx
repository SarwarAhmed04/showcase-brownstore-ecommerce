import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useLang } from "../context/LangContext";
import { tName } from "../i18n";
import ProductCard from "../components/ProductCard";
import Spinner from "../components/Spinner";

export default function Home() {
  const { t, lang } = useLang();
  const [data, setData] = useState({ products: [], categories: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.products({ limit: 8, sort: "newest" }), api.categories()])
      .then(([products, categories]) => {
        setData({
          products: products.products || [],
          categories: categories.categories || [],
        });
      })
      .catch(() => setData({ products: [], categories: [] }))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(210,166,121,0.28),_transparent_55%)]" />
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 md:grid-cols-2 md:py-24">
          <div>
            <p className="mb-3 text-sm font-semibold tracking-[0.2em] text-tan uppercase">
              BrownStore
            </p>
            <h1 className="font-display text-4xl leading-tight text-brown md:text-5xl">
              {t.heroTitle}
            </h1>
            <p className="mt-4 max-w-md text-brown/70">{t.heroBody}</p>
            <Link
              to="/shop"
              className="mt-8 inline-flex rounded-full bg-brown px-6 py-3 text-sm font-semibold text-cream shadow-lg shadow-brown/20 transition hover:bg-brown/90"
            >
              {t.shopNow}
            </Link>
          </div>
          <div className="flex justify-center">
            <div className="relative">
              <div className="absolute inset-8 rounded-full bg-tan/30 blur-3xl" />
              <img
                src="/logo.png"
                alt="BrownStore"
                className="relative h-64 w-64 object-contain drop-shadow-xl md:h-80 md:w-80"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-8">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="font-display text-2xl text-brown">{t.shopByCategory}</h2>
        </div>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {data.categories.map((cat) => (
            <Link
              key={cat.id}
              to={`/shop?category=${cat.id}`}
              className="flex min-w-32 flex-col items-center gap-2 rounded-2xl bg-white p-4 text-center shadow-sm ring-1 ring-brown/5 transition hover:ring-tan"
            >
              {cat.image ? (
                <img
                  src={cat.image}
                  alt=""
                  className="h-14 w-14 rounded-full object-cover"
                />
              ) : (
                <img src="/logo.png" alt="" className="h-10 w-10 opacity-60" />
              )}
              <span className="text-xs font-medium text-brown">
                {tName(cat.name, lang)}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="font-display text-2xl text-brown">{t.featured}</h2>
          <Link to="/shop" className="text-sm font-semibold text-tan hover:text-brown">
            {t.viewAll}
          </Link>
        </div>
        {loading ? (
          <Spinner label={t.loading} />
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {data.products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
