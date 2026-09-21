import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RotateCcw, ShieldCheck, Sparkles, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMedia } from "../lib/hooks";
import { Reveal } from "./ui";
import { useLang } from "../context/LangContext";
import { useCatalog } from "../lib/catalogStore";
import { imgUrl } from "../lib/img";

const PROMISES = [
  { Icon: Truck, key: "featureSameDay", sub: "featureSameDaySub" },
  { Icon: ShieldCheck, key: "featureCover", sub: "featureCoverSub" },
  { Icon: RotateCcw, key: "featureReturns", sub: "featureReturnsSub" },
  { Icon: Sparkles, key: "featurePicked", sub: "featurePickedSub" },
];

function StaticField() {
  return (
    <div
      className="absolute inset-0"
      style={{
        background: `radial-gradient(120% 100% at 15% 0%, #ffd9a333, transparent 55%),
                     linear-gradient(140deg, #f7ede0, #d8c0a666)`,
      }}
    />
  );
}

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
      img: live[0]?.img,
    },
    {
      eyebrow: t.departmentsEyebrow,
      title: t.heroSlide2Lines,
      body: t.categorySub,
      cta: { to: "/shop", label: t.shop },
      alt: { to: "/shop", label: t.shop },
      img: live[1]?.img || categories[0]?.cover,
    },
    {
      eyebrow: t.handPickedEyebrow,
      title: t.heroSlide3Lines,
      body: t.featuredSub,
      cta: { to: "/shop", label: t.viewAll },
      alt: { to: "/about", label: t.about },
      img: live[2]?.img || categories[1]?.cover,
    },
  ];

  useEffect(() => {
    if (reducedMotion) return undefined;
    const timer = setInterval(() => setI((v) => (v + 1) % slides.length), 7000);
    return () => clearInterval(timer);
  }, [reducedMotion, slides.length]);

  const s = slides[i];

  return (
    <section className="container-x pt-6 lg:pt-8">
      <div className="glass relative overflow-hidden rounded-panel">
        <div aria-hidden className="absolute inset-0">
          <StaticField />
          <div className="absolute inset-0 bg-gradient-to-r from-background/85 via-background/55 to-background/20" />
        </div>

        <div className="relative z-10 grid items-stretch lg:grid-cols-[1.25fr_.75fr]">
          <div className="flex flex-col justify-center p-5 sm:p-7 lg:px-10 lg:py-6">
            <Reveal key={`e-${i}`} as="span" className="eyebrow mb-3 self-start">
              <Sparkles className="size-3" /> {s.eyebrow}
            </Reveal>

            <h1 className="headline text-2xl leading-[1.1] sm:text-3xl lg:text-[2.1rem]">
              {(Array.isArray(s.title) ? s.title : [s.title]).map((line, n) => (
                <Reveal key={`${i}-${n}`} as="span" delay={n * 90}>
                  {n > 0 ? " " : ""}
                  {n === 1 ? <span className="gold-text">{line}</span> : line}
                </Reveal>
              ))}
            </h1>

            <Reveal
              key={`b-${i}`}
              as="p"
              delay={260}
              className="mt-2 max-w-md text-sm leading-relaxed text-foreground/75"
            >
              {s.body}
            </Reveal>

            <div className="mt-4 flex flex-wrap gap-3">
              <Button asChild variant="brand" size="lg">
                <Link to={s.cta.to}>
                  {s.cta.label} <ArrowRight />
                </Link>
              </Button>
              <Button asChild variant="glass" size="lg">
                <Link to={s.alt.to}>{s.alt.label}</Link>
              </Button>
            </div>

            <div className="mt-4 flex items-center gap-2.5">
              {slides.map((sl, n) => (
                <button
                  key={sl.eyebrow}
                  type="button"
                  onClick={() => setI(n)}
                  aria-label={`${n + 1}`}
                  aria-current={n === i}
                  className="group py-1.5"
                >
                  <span
                    className={cn(
                      "block h-1 rounded-pill transition-all duration-500",
                      n === i ? "w-10 bg-primary" : "w-5 bg-border group-hover:bg-muted-foreground"
                    )}
                  />
                </button>
              ))}
              <span dir="ltr" className="ms-2 text-2xs font-semibold text-muted-foreground">
                {String(i + 1).padStart(2, "0")} / {String(slides.length).padStart(2, "0")}
              </span>
            </div>
          </div>

          <div className="relative min-h-[160px] overflow-hidden sm:min-h-[180px] lg:min-h-0">
            {slides.map((sl, n) =>
              n === i || n === (i + 1) % slides.length ? (
                <img
                  key={(sl.img || "fallback") + n}
                  src={imgUrl(sl.img) || "/logo.png"}
                  alt=""
                  aria-hidden={n !== i}
                  loading={n === 0 ? "eager" : "lazy"}
                  decoding="async"
                  className={cn(
                    "absolute inset-0 h-full w-full object-contain object-center p-3 transition-opacity duration-500 lg:p-4",
                    n === i ? "opacity-100" : "opacity-0"
                  )}
                />
              ) : null
            )}
            <div className="absolute inset-0 bg-gradient-to-r from-background via-background/20 to-transparent lg:from-background/50 lg:via-background/10" />
            <div className="absolute inset-0 bg-gradient-to-t from-background/50 to-transparent lg:hidden" />
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PROMISES.map(({ Icon, key, sub }) => (
          <div
            key={key}
            className="glass flex items-center gap-3.5 rounded-card px-5 py-4 transition-transform duration-300 hover:-translate-y-1"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
              <Icon className="size-4" />
            </span>
            <span>
              <span className="block text-xs font-bold">{t[key]}</span>
              <span className="block text-2xs text-muted-foreground">{t[sub]}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
