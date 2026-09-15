import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { tName } from "../i18n";
import { useLang } from "../context/LangContext";
import Logo from "./Logo";

function CatImage({ src, className }) {
  if (src) {
    return <img src={src} alt="" className={className} />;
  }
  return (
    <div className={`flex items-center justify-center bg-muted ${className}`}>
      <Logo className="h-10 w-14 opacity-50" />
    </div>
  );
}

function Chevron({ dir }) {
  const next = dir === "next";
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-5 w-5 ${next ? "rotate-180 rtl:rotate-0" : "rtl:rotate-180"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
    >
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </svg>
  );
}

function ScrollRail({ children, className }) {
  const { t } = useLang();
  const scroller = useRef(null);
  const [overflow, setOverflow] = useState(false);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  function update() {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const hasOverflow = max > 8;
    setOverflow(hasOverflow);
    if (!hasOverflow) {
      setCanPrev(false);
      setCanNext(false);
      return;
    }
    const rtl = getComputedStyle(el).direction === "rtl";
    const sl = el.scrollLeft;
    const fromStart = rtl ? (sl <= 0 ? -sl : Math.max(0, max - sl)) : sl;
    setCanPrev(fromStart > 8);
    setCanNext(fromStart < max - 8);
  }

  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    update();
    const onScroll = () => update();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [children]);

  function move(dir) {
    const el = scroller.current;
    if (!el) return;
    const amount = Math.max(el.clientWidth * 0.7, 220);
    const rtl = getComputedStyle(el).direction === "rtl";
    el.scrollBy({ left: (rtl ? -dir : dir) * amount, behavior: "smooth" });
  }

  const arrowClass =
    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg shadow-sm transition disabled:cursor-default disabled:opacity-25";

  return (
    <div className="flex items-center gap-2">
      {overflow ? (
        <button
          type="button"
          aria-label={t.scrollPrev}
          disabled={!canPrev}
          onClick={() => move(-1)}
          className={arrowClass}
        >
          <Chevron dir="prev" />
        </button>
      ) : null}
      <div ref={scroller} className={`min-w-0 flex-1 overflow-x-auto no-scrollbar ${className}`}>
        {children}
      </div>
      {overflow ? (
        <button
          type="button"
          aria-label={t.scrollNext}
          disabled={!canNext}
          onClick={() => move(1)}
          className={arrowClass}
        >
          <Chevron dir="next" />
        </button>
      ) : null}
    </div>
  );
}

export default function CategoryShowcase({ categories, layout = "pills", lang }) {
  const items = categories || [];
  if (!items.length) return null;

  if (layout === "circles") {
    return (
      <div className="flex gap-6 overflow-x-auto pb-2">
        {items.map((cat) => (
          <Link
            key={cat.id}
            to={`/shop?category=${cat.id}`}
            className="flex min-w-28 flex-col items-center gap-3"
          >
            <CatImage
              src={cat.image}
              className="h-24 w-24 rounded-full object-cover ring-4 ring-primary/25 shadow-md"
            />
            <span className="max-w-28 text-center text-sm font-medium text-fg">
              {tName(cat.name, lang)}
            </span>
          </Link>
        ))}
      </div>
    );
  }

  if (layout === "cards") {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {items.map((cat) => (
          <Link
            key={cat.id}
            to={`/shop?category=${cat.id}`}
            className="group glass overflow-hidden rounded-card transition hover:-translate-y-0.5"
          >
            <div className="shot aspect-[4/3]">
              <CatImage
                src={cat.image}
                className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
              />
            </div>
            <p className="relative px-4 py-3 text-sm font-semibold text-fg">
              {tName(cat.name, lang)}
            </p>
          </Link>
        ))}
      </div>
    );
  }

  if (layout === "posters") {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((cat) => (
          <Link
            key={cat.id}
            to={`/shop?category=${cat.id}`}
            className="group relative min-h-56 overflow-hidden rounded-panel bg-bg-2 shadow-lg"
          >
            <CatImage
              src={cat.image}
              className="absolute inset-0 h-full w-full object-cover opacity-80 transition duration-500 group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/30 to-transparent" />
            <p className="absolute inset-x-0 bottom-0 p-5 font-display text-2xl text-fg">
              {tName(cat.name, lang)}
            </p>
          </Link>
        ))}
      </div>
    );
  }

  if (layout === "rail") {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((cat, index) => (
          <Link
            key={cat.id}
            to={`/shop?category=${cat.id}`}
            className="glass flex items-center gap-4 rounded-card p-3 transition hover:ring-1 hover:ring-primary/40"
          >
            <span className="w-8 text-center font-display text-lg text-primary">
              {String(index + 1).padStart(2, "0")}
            </span>
            <CatImage
              src={cat.image}
              className="h-16 w-16 shrink-0 rounded-2xl object-cover"
            />
            <span className="min-w-0 flex-1 truncate font-medium text-fg">
              {tName(cat.name, lang)}
            </span>
          </Link>
        ))}
      </div>
    );
  }

  return (
    <ScrollRail key={items.map((cat) => cat.id).join("-")} className="flex gap-3">
      {items.map((cat) => (
        <Link
          key={cat.id}
          to={`/shop?category=${cat.id}`}
          className="glass flex min-w-32 flex-col items-center gap-2 rounded-card p-4 text-center transition hover:ring-1 hover:ring-primary/40"
        >
          <CatImage src={cat.image} className="h-14 w-14 rounded-full object-cover" />
          <span className="text-xs font-medium text-fg">{tName(cat.name, lang)}</span>
        </Link>
      ))}
    </ScrollRail>
  );
}
