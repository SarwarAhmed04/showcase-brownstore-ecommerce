import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMedia } from "../lib/hooks";
import { useLang } from "../context/LangContext";
import { useCatalog } from "../lib/catalogStore";
import { imgUrl } from "../lib/img";

const SLIDE_MS = 7000;

/** Espresso band with the current pick framed in an arch. */
export default function Hero() {
  const [i, setI] = useState(0);
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const { t } = useLang();
  const { live, categories } = useCatalog();

  const slides = [
    {
      eyebrow: t.heroEyebrow,
      title: t.heroTitleLines || [t.heroTitle],
      body: t.heroBody,
      cta: { to: "/shop", label: t.browseCatalogue || t.shopNow },
      alt: {
        to: categories[0] ? `/category/${categories[0].slug}` : "/shop",
        label: categories[0]?.name || t.shop,
      },
      product: live[0],
      img: live[0]?.img,
    },
    {
      eyebrow: t.departmentsEyebrow,
      title: t.heroSlide2Lines,
      body: t.categorySub,
      cta: { to: "/shop", label: t.shop },
      alt: {
        to: categories[1] ? `/category/${categories[1].slug}` : "/contact",
        label: categories[1]?.name || t.contact,
      },
      product: live[1],
      img: live[1]?.img || categories[0]?.cover,
    },
    {
      eyebrow: t.handPickedEyebrow,
      title: t.heroSlide3Lines,
      body: t.featuredSub,
      cta: { to: "/shop", label: t.viewAll },
      alt: { to: "/contact", label: t.contact },
      product: live[2],
      img: live[2]?.img || categories[1]?.cover,
    },
  ];

  useEffect(() => {
    if (reducedMotion) return undefined;
    const timer = setTimeout(() => setI((v) => (v + 1) % slides.length), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [i, reducedMotion, slides.length]);

  const s = slides[i];
  const lines = Array.isArray(s.title) ? s.title : [s.title];

  return (
    <section className="relative z-0 overflow-hidden bg-bean-900 text-bean-50">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -bottom-48 -start-24 h-[520px] w-[400px] rounded-t-full border border-tan/10" />
        <div className="absolute -bottom-48 -start-8 h-[440px] w-[330px] rounded-t-full border border-tan/[0.07]" />
      </div>

      <div className="container-x relative grid items-center gap-12 py-12 sm:py-16 lg:grid-cols-[1.1fr_.9fr] lg:gap-16 lg:py-20">
        <div>
          <p key={`e-${i}`} className="sf-eyebrow text-tan">
            {s.eyebrow}
          </p>

          <h1 key={`t-${i}`} className="sf-display mt-5 text-4xl text-bean-50 sm:text-5xl lg:text-6xl">
            {lines.map((line, n) => (
              <span key={`${i}-${n}`} className="block">
                {n === 1 ? <span className="text-tan">{line}</span> : line}
              </span>
            ))}
          </h1>

          <p key={`b-${i}`} className="mt-6 max-w-md text-base leading-relaxed text-bean-50/70">
            {s.body}
          </p>

          <div className="mt-9 flex flex-wrap gap-3">
            <Button asChild variant="caramel" size="xl">
              <Link to={s.cta.to}>
                {s.cta.label} <ArrowLeft className="ltr:rotate-180" />
              </Link>
            </Button>
            <Button asChild variant="line-light" size="xl">
              <Link to={s.alt.to}>{s.alt.label}</Link>
            </Button>
          </div>

          <div className="mt-12 grid max-w-sm grid-cols-3 gap-4">
            {slides.map((sl, n) => (
              <button
                key={sl.eyebrow + n}
                type="button"
                onClick={() => setI(n)}
                aria-label={sl.eyebrow}
                aria-current={n === i ? true : undefined}
                className="group text-start"
              >
                <span className="block h-0.5 overflow-hidden bg-bean-50/15">
                  <span
                    key={n === i ? `on-${i}` : "off"}
                    className={cn(
                      "block h-full origin-left bg-tan rtl:origin-right",
                      n < i && "w-full",
                      n > i && "w-0",
                      n === i && (reducedMotion ? "w-full" : "w-full animate-progress")
                    )}
                  />
                </span>
                <span
                  dir="ltr"
                  className={cn(
                    "mt-2.5 block font-display text-xs font-bold tabular-nums transition-colors",
                    n === i ? "text-bean-50" : "text-bean-50/40 group-hover:text-bean-50/70"
                  )}
                >
                  {String(n + 1).padStart(2, "0")}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[300px] sm:max-w-[380px] lg:max-w-[440px]">
          <div aria-hidden className="absolute -inset-3 rounded-t-full border border-tan/30 sm:-inset-5" />
          <div className="sf-tile relative aspect-[4/5] overflow-hidden rounded-t-full">
            {slides.map((sl, n) => (
              <img
                key={(sl.img || "fallback") + n}
                src={imgUrl(sl.img, { w: 900, h: 1100 }) || "/logo.png"}
                alt=""
                aria-hidden={n !== i}
                loading={n === 0 ? "eager" : "lazy"}
                decoding="async"
                className={cn(
                  "absolute inset-0 h-full w-full object-contain p-10 pb-24 transition-all duration-700 ease-out sm:p-14 sm:pb-28",
                  n === i ? "scale-100 opacity-100" : "scale-95 opacity-0"
                )}
              />
            ))}
            {s.product ? (
              <Link
                key={s.product.id}
                to={`/product/${s.product.slug}`}
                className="absolute inset-x-4 bottom-4 rounded-md bg-background/95 px-4 py-3 text-bean-900 shadow-sm transition-colors hover:bg-background"
              >
                {s.product.brand && (
                  <span className="block truncate text-2xs font-semibold text-muted-foreground">{s.product.brand}</span>
                )}
                <span className="clamp-1 block text-sm font-semibold">{s.product.name}</span>
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
