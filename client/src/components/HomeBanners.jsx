import { useEffect, useState } from "react";
import { tName } from "../i18n";
import { useLang } from "../context/LangContext";

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

export function BannerCopy({ banner, compact = false }) {
  const { lang } = useLang();
  const title = tName(banner?.title, lang);
  const subtitle = tName(banner?.subtitle, lang);
  if (!title && !subtitle) return null;
  const align = ALIGN_CLASS[banner.textAlign] || ALIGN_CLASS["bottom-start"];

  return (
    <div className={`pointer-events-none absolute inset-0 flex p-4 sm:p-6 lg:p-8 ${align}`}>
      <div className={`max-w-xl rounded-2xl bg-black/40 px-4 py-3 sm:px-5 sm:py-4 ${compact ? "max-w-md" : ""}`}>
        {title ? (
          <h2 className={`font-display leading-tight text-white ${compact ? "text-xl sm:text-2xl" : "text-2xl sm:text-4xl"}`}>
            {title}
          </h2>
        ) : null}
        {subtitle ? (
          <p className={`mt-1 text-white/85 ${compact ? "text-xs sm:text-sm" : "text-sm sm:text-base"}`}>
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

  useEffect(() => {
    setIndex(0);
  }, [slides.length]);

  useEffect(() => {
    if (slides.length < 2) return undefined;
    const id = setInterval(() => {
      setIndex((current) => (current + 1) % slides.length);
    }, 7000);
    return () => clearInterval(id);
  }, [slides.length]);

  if (!slides.length) return null;
  const current = slides[Math.min(index, slides.length - 1)];

  return (
    <section className="container-x pt-6">
      <div className="relative overflow-hidden rounded-panel bg-secondary">
        <div className="aspect-[2/1] sm:aspect-[5/2] lg:aspect-[3/1]">
          {slides.map((item) => (
            <div
              key={item.slot}
              className={`absolute inset-0 transition-opacity duration-700 ${
                item.slot === current.slot ? "opacity-100" : "opacity-0"
              }`}
            >
              <img
                src={item.image}
                alt=""
                loading={item.slot === slides[0]?.slot ? "eager" : "lazy"}
                decoding="async"
                fetchPriority={item.slot === current.slot ? "high" : "low"}
                className="h-full w-full object-cover"
              />
              <BannerCopy banner={item} />
            </div>
          ))}
        </div>
        {slides.length > 1 ? (
          <div className="absolute inset-x-0 bottom-3 z-10 flex justify-center gap-2">
            {slides.map((item, i) => (
              <button
                key={item.slot}
                type="button"
                aria-label={`Banner ${item.slot}`}
                onClick={() => setIndex(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === index ? "w-8 bg-primary" : "w-2.5 bg-white/60"
                }`}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function BannerStrip({ banner }) {
  if (!banner?.image) return null;
  return (
    <section className="container-x py-6">
      <div className="relative overflow-hidden rounded-panel bg-secondary">
        <div className="aspect-[8/3] sm:aspect-[4/1]">
          <img src={banner.image} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
          <BannerCopy banner={banner} compact />
        </div>
      </div>
    </section>
  );
}
