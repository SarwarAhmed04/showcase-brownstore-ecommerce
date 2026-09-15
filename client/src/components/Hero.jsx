import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RotateCcw, ShieldCheck, Sparkles, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMedia } from "../lib/hooks";
import { useStore } from "../store";
import { Reveal } from "./ui";
import { useLang } from "../context/LangContext";
import { useCatalog } from "../lib/catalogStore";

const Grainient = lazy(() => import("./Grainient"));

const PROMISES = [
  { Icon: Truck, key: "featureSameDay", sub: "featureSameDaySub" },
  { Icon: ShieldCheck, key: "featureCover", sub: "featureCoverSub" },
  { Icon: RotateCcw, key: "featureReturns", sub: "featureReturnsSub" },
  { Icon: Sparkles, key: "featurePicked", sub: "featurePickedSub" },
];

const SHADER = {
  espresso: { color1: "#ffcd85", color2: "#1b100c", color3: "#6d482c", lightMode: false },
  cream: { color1: "#ffd9a3", color2: "#f7ede0", color3: "#d8c0a6", lightMode: true },
};

function StaticField({ shader }) {
  return (
    <div
      className="absolute inset-0"
      style={{
        background: `radial-gradient(120% 100% at 15% 0%, ${shader.color1}33, transparent 55%),
                     linear-gradient(140deg, ${shader.color2}, ${shader.color3}66)`,
      }}
    />
  );
}

export default function Hero() {
  const [i, setI] = useState(0);
  const { theme } = useStore();
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const { t, lang } = useLang();
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
      title:
        lang === "en"
          ? ["Built for", "the daily", "repetition"]
          : lang === "ar"
            ? ["مصممة لـ", "التكرار", "اليومي"]
            : ["دروستکراو بۆ", "ڕۆژانە", "و دووبارەبوونەوە"],
      body: t.categorySub,
      cta: { to: "/shop", label: t.shop },
      alt: { to: "/deals", label: t.deals },
      img: live[1]?.img || categories[0]?.cover,
    },
    {
      eyebrow: t.handPickedEyebrow,
      title:
        lang === "en"
          ? ["Pieces that", "get better", "with use"]
          : lang === "ar"
            ? ["قطع تتحسن", "مع", "الاستخدام"]
            : ["پارچەکان باشتر دەبن", "لەگەڵ", "بەکارهێنان"],
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
  const shader = SHADER[theme] ?? SHADER.espresso;

  return (
    <section className="container-x pt-8 lg:pt-14">
      <div className="glass relative overflow-hidden rounded-panel">
        <div aria-hidden className="absolute inset-0">
          {reducedMotion ? (
            <StaticField shader={shader} />
          ) : (
            <Suspense fallback={<StaticField shader={shader} />}>
              <Grainient
                key={theme}
                className="absolute inset-0"
                color1={shader.color1}
                color2={shader.color2}
                color3={shader.color3}
                lightMode={shader.lightMode}
                timeSpeed={0.14}
                warpStrength={0.8}
                warpAmplitude={38}
                grainAmount={0.06}
                contrast={1.25}
                saturation={0.85}
                zoom={1.1}
              />
            </Suspense>
          )}
          <div className="absolute inset-0 bg-gradient-to-r from-background/85 via-background/55 to-background/20" />
        </div>

        <div className="relative z-10 grid items-stretch lg:grid-cols-[1.05fr_1fr]">
          <div className="flex flex-col justify-center p-8 sm:p-12 lg:p-16">
            <Reveal key={`e-${i}`} as="span" className="eyebrow mb-6">
              <Sparkles className="size-3" /> {s.eyebrow}
            </Reveal>

            <h1 className="headline text-3xl leading-[1.02] sm:text-4xl lg:text-5xl">
              {s.title.map((line, n) => (
                <Reveal key={`${i}-${n}`} as="span" className="block" delay={n * 90}>
                  {n === 1 ? <span className="gold-text">{line}</span> : line}
                </Reveal>
              ))}
            </h1>

            <Reveal
              key={`b-${i}`}
              as="p"
              delay={260}
              className="mt-6 max-w-md text-base leading-relaxed text-foreground/75"
            >
              {s.body}
            </Reveal>

            <div className="mt-9 flex flex-wrap gap-3">
              <Button asChild variant="brand" size="xl">
                <Link to={s.cta.to}>
                  {s.cta.label} <ArrowRight />
                </Link>
              </Button>
              <Button asChild variant="glass" size="xl">
                <Link to={s.alt.to}>{s.alt.label}</Link>
              </Button>
            </div>

            <div className="mt-10 flex items-center gap-2.5">
              {slides.map((sl, n) => (
                <button
                  key={sl.eyebrow}
                  type="button"
                  onClick={() => setI(n)}
                  aria-label={`${n + 1}`}
                  aria-current={n === i}
                  className="group py-2"
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

          <div className="relative min-h-[300px] overflow-hidden lg:min-h-[560px]">
            {slides.map((sl, n) => (
              <img
                key={(sl.img || "fallback") + n}
                src={sl.img || "/logo-hero.png"}
                alt=""
                aria-hidden={n !== i}
                className={cn(
                  "absolute inset-0 h-full w-full object-cover transition-all duration-[1200ms]",
                  n === i ? "scale-100 opacity-100" : "scale-110 opacity-0"
                )}
              />
            ))}
            <div className="absolute inset-0 bg-gradient-to-r from-background via-background/35 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-t from-background/60 to-transparent lg:hidden" />
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
