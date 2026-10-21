import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { tName } from "../i18n";
import { useLang } from "../context/LangContext";
import { useMedia } from "../lib/hooks";
import { imgUrl } from "../lib/img";
import { cn } from "@/lib/utils";

const ALIGN_CLASS = {
  "top-start": "items-start justify-start text-start",
  "top-center": "items-start justify-center text-center",
  "top-end": "items-start justify-end text-end",
  "middle-start": "items-center justify-start text-start",
  "middle-center": "items-center justify-center text-center",
  "middle-end": "items-center justify-end text-end",
  "bottom-start": "items-end justify-start text-start",
  "bottom-center": "items-end justify-center text-center",
  "bottom-end": "items-end justify-end text-end",
};

const SLIDE_MS = 7000;

function bannerHref(banner) {
  const href = String(banner?.link || "").trim();
  if (!href) return "";
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (/^https?:\/\//i.test(href)) return href;
  return "";
}

function BannerFrame({ banner, className, children }) {
  const href = bannerHref(banner);
  const classes = `${className}${href ? " cursor-pointer" : ""}`;
  if (!href) return <div className={classes}>{children}</div>;
  if (href.startsWith("/")) {
    return (
      <Link to={href} className={`${classes} block`} aria-label={banner.title?.en || "Banner"}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${classes} block`}
      aria-label={banner.title?.en || "Banner"}
    >
      {children}
    </a>
  );
}

export function BannerCopy({ banner, compact = false, className }) {
  const { lang } = useLang();
  const title = tName(banner?.title, lang);
  const subtitle = tName(banner?.subtitle, lang);
  if (!title && !subtitle) return null;
  const align = ALIGN_CLASS[banner.textAlign] || ALIGN_CLASS["bottom-start"];

  return (
    <div className={cn("pointer-events-none absolute inset-0 flex p-4 sm:p-7 lg:p-10", align, className)}>
      <div className={cn("rounded-md bg-bean-900/85 px-4 py-3 sm:px-6 sm:py-5", compact ? "max-w-md" : "max-w-xl")}>
        {title ? (
          <h2 className={cn("sf-display text-bean-50", compact ? "text-lg sm:text-2xl" : "text-xl sm:text-4xl")}>
            {title}
          </h2>
        ) : null}
        {subtitle ? (
          <p className={cn("mt-1.5 text-bean-50/75", compact ? "text-xs sm:text-sm" : "text-sm sm:text-base")}>
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function BannerSlider({ banners }) {
  const slides = (banners || []).filter((item) => item.image).sort((a, b) => a.slot - b.slot);
  const [index, setIndex] = useState(0);
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");

  useEffect(() => {
    setIndex(0);
  }, [slides.length]);

  useEffect(() => {
    if (slides.length < 2 || reducedMotion) return undefined;
    const id = setTimeout(() => setIndex((current) => (current + 1) % slides.length), SLIDE_MS);
    return () => clearTimeout(id);
  }, [index, slides.length, reducedMotion]);

  if (!slides.length) return null;
  const current = slides[Math.min(index, slides.length - 1)];

  return (
    <section className="relative z-0 overflow-hidden bg-bean-900">
      <div className="relative aspect-[5/4] sm:aspect-[16/9] lg:aspect-[2.4/1]">
        {slides.map((item) => (
          <BannerFrame
            key={item.slot}
            banner={item}
            className={`absolute inset-0 transition-opacity duration-700 ${
              item.slot === current.slot ? "z-[1] opacity-100" : "pointer-events-none z-0 opacity-0"
            }`}
          >
            <img
              src={imgUrl(item.image)}
              alt=""
              loading={item.slot === slides[0]?.slot ? "eager" : "lazy"}
              decoding="async"
              fetchPriority={item.slot === current.slot ? "high" : "low"}
              className="h-full w-full object-cover"
            />
              <BannerCopy banner={item} className="pb-20 sm:pb-24" />
          </BannerFrame>
        ))}
      </div>
      {slides.length > 1 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 sm:bottom-7">
          <div
            className="container-x pointer-events-auto grid max-w-sm gap-4"
            style={{ gridTemplateColumns: `repeat(${slides.length}, minmax(0, 1fr))` }}
          >
            {slides.map((item, i) => (
              <button
                key={item.slot}
                type="button"
                aria-label={`Banner ${i + 1}`}
                aria-current={i === index ? true : undefined}
                onClick={() => setIndex(i)}
                className="group text-start"
              >
                <span className="block h-0.5 overflow-hidden bg-bean-50/20">
                  <span
                    key={i === index ? `on-${index}` : "off"}
                    className={cn(
                      "block h-full origin-left bg-tan rtl:origin-right",
                      i < index && "w-full",
                      i > index && "w-0",
                      i === index && (reducedMotion ? "w-full" : "w-full animate-progress")
                    )}
                  />
                </span>
                <span
                  dir="ltr"
                  className={cn(
                    "mt-2.5 block font-display text-xs font-bold tabular-nums transition-colors",
                    i === index ? "text-bean-50" : "text-bean-50/40 group-hover:text-bean-50/70"
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function BannerStrip({ banner }) {
  if (!banner?.image) return null;
  return (
    <section className="container-x py-8 sm:py-10">
      <BannerFrame banner={banner} className="relative overflow-hidden rounded-lg bg-bean-100">
        <div className="aspect-[8/3] sm:aspect-[4/1]">
          <img src={imgUrl(banner.image)} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
          <BannerCopy banner={banner} compact />
        </div>
      </BannerFrame>
    </section>
  );
}
