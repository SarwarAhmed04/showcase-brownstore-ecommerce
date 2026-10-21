import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  Check,
  Copy,
  Heart,
  MapPin,
  RotateCcw,
  Share2,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Breadcrumbs } from "../components/PageHead";
import ProductRail from "../components/ProductRail";
import EnquiryDialog from "../components/EnquiryDialog";
import { PageSkeleton, Reveal, Stars, StockDot } from "../components/ui";
import { useCatalog } from "../lib/catalogStore";
import { adaptProduct } from "../lib/catalog";
import { useStore } from "../store";
import { api } from "../api";
import { useLang } from "../context/LangContext";
import { imgUrl } from "../lib/img";

export default function Product() {
  const { slug } = useParams();
  const { related, categoryBySlug, bySlug } = useCatalog();
  const { saved } = useStore();
  const { t, lang } = useLang();
  const [shot, setShot] = useState(0);
  const [copied, setCopied] = useState(false);
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(Boolean(navigator.share));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setShot(0);
    api
      .product(slug)
      .then((data) => {
        if (!cancelled) setPayload(data);
      })
      .catch(() => {
        if (!cancelled) setPayload(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const cached = bySlug(slug);
  const p = useMemo(
    () => (payload?.product ? adaptProduct(payload.product, lang) : cached),
    [payload, lang, cached]
  );
  const relatedItems = useMemo(() => {
    if (payload?.related?.length) return payload.related.map((item) => adaptProduct(item, lang));
    return p ? related(p, 10) : [];
  }, [payload, lang, p, related]);

  const trackedId = useRef(null);
  useEffect(() => {
    if (!p || trackedId.current === p.id) return;
    trackedId.current = p.id;
  }, [p]);

  if (loading && !p) return <PageSkeleton />;
  if (!p) return <Navigate to="/404" replace />;

  const cat = categoryBySlug[p.category];
  const gallery = p.gallery?.length ? p.gallery : [p.img].filter(Boolean);
  const isSaved = saved.has(p.id);
  const specs = p.specs && typeof p.specs === "object" ? p.specs : {};

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: p.name, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* dismissed */
    }
  };

  const SERVICE = [
    { Icon: Truck, title: t.featureSameDay, sub: t.featureSameDaySub },
    { Icon: ShieldCheck, title: t.featureCover, sub: t.featureCoverSub },
    { Icon: RotateCcw, title: t.featureReturns, sub: t.featureReturnsSub },
    { Icon: MapPin, title: t.contact, sub: t.hoursValue },
  ];

  return (
    <div className="py-8 lg:py-12">
      <div className="container-x">
        <Breadcrumbs
          crumbs={[
            { label: t.shop, to: "/shop" },
            { label: cat?.name || t.shop, to: `/category/${p.category}` },
            { label: p.name },
          ]}
        />

        <div className="mt-8 grid gap-10 lg:grid-cols-[1.05fr_.95fr] lg:gap-16">
          <div className="lg:sticky lg:top-[8.5rem] lg:self-start">
            <div className="sf-tile relative overflow-hidden rounded-lg">
              <div className="aspect-square">
                <img
                  key={shot}
                  src={imgUrl(gallery[shot], { w: 1000, h: 1000 }) || "/logo.png"}
                  alt={p.name}
                  className="h-full w-full object-contain p-8 sm:p-12"
                />
              </div>
              {p.badge && (
                <span className="absolute start-4 top-4 rounded-sm bg-bean-900 px-2 py-1 text-[10px] font-bold leading-none text-bean-50 ltr:uppercase ltr:tracking-wider">
                  {p.badge === "New" ? t.newBadge : p.badge}
                </span>
              )}
            </div>

            {gallery.length > 1 && (
              <div className="mt-3 grid grid-cols-5 gap-2 sm:grid-cols-6">
                {gallery.slice(0, 8).map((src, i) => (
                  <button
                    key={src + i}
                    type="button"
                    onClick={() => setShot(i)}
                    aria-pressed={i === shot}
                    className={cn(
                      "sf-tile overflow-hidden rounded-md ring-2 ring-offset-2 ring-offset-background transition-all",
                      i === shot ? "ring-bean-900" : "ring-transparent opacity-60 hover:opacity-100"
                    )}
                  >
                    <span className="block aspect-square">
                      <img src={imgUrl(src, { w: 160, h: 160 })} alt="" className="h-full w-full object-contain p-1.5" />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            {cat?.name && (
              <Link
                to={`/category/${p.category}`}
                className="sf-eyebrow"
              >
                {cat.name}
              </Link>
            )}

            <h1 className="sf-display mt-4 text-3xl leading-tight text-bean-900 sm:text-4xl">
              {p.name}
            </h1>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              {p.rating > 0 ? <Stars value={p.rating} reviews={p.reviews} size={16} /> : null}
              <StockDot stock={p.stock} />
              {p.brand ? <span className="text-xs font-semibold text-muted-foreground">{p.brand}</span> : null}
            </div>

            {p.desc ? (
              <p className="mt-7 text-base leading-relaxed text-muted-foreground">{p.desc}</p>
            ) : null}

            <div className="mt-8 space-y-2">
              <EnquiryDialog
                product={p}
                trigger={
                  <Button variant="ink" size="xl" className="w-full">
                    {t.reserveItem}
                  </Button>
                }
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="line"
                  size="lg"
                  onClick={() => saved.toggle(p.id)}
                  aria-pressed={isSaved}
                  className="flex-1"
                >
                  <Heart className={cn(isSaved && "text-primary")} fill={isSaved ? "currentColor" : "none"} />
                  {isSaved ? t.saved : t.saveForLater}
                </Button>
                <Button type="button" variant="line" size="lg" onClick={share}>
                  {copied ? <Check /> : canShare ? <Share2 /> : <Copy />}
                  {copied ? t.copied : t.share}
                </Button>
              </div>
              <p className="pt-1 text-center text-2xs text-muted-foreground">{t.displayPriceNote}</p>
            </div>

            {Object.keys(specs).length > 0 && (
              <div className="mt-10">
                <h2 className="sf-eyebrow mb-4">{t.specs}</h2>
                <dl className="divide-y divide-bean-900/10 border-y border-bean-900/10">
                  {Object.entries(specs).map(([k, v]) => (
                    <div key={k} className="flex gap-4 py-3.5">
                      <dt className="w-2/5 shrink-0 text-xs font-semibold text-muted-foreground">{k}</dt>
                      <dd className="text-xs text-bean-900">{v}</dd>
                    </div>
                  ))}
                  {p.sku && !specs.SKU && (
                    <div className="flex gap-4 py-3.5">
                      <dt className="w-2/5 shrink-0 text-xs font-semibold text-muted-foreground">{t.sku}</dt>
                      <dd className="text-xs tabular-nums text-bean-900">{p.sku}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            <div className="mt-10 grid gap-px bg-bean-900/10 sm:grid-cols-2">
              {SERVICE.map(({ Icon, title, sub }) => (
                <div key={title} className="flex gap-3 bg-background p-4">
                  <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div>
                    <div className="text-xs font-bold text-bean-900">{title}</div>
                    <div className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Reveal>
        <ProductRail
          eyebrow={t.relatedEyebrow}
          title={t.related}
          items={relatedItems}
          to={p.category ? `/category/${p.category}` : "/shop"}
        />
      </Reveal>
    </div>
  );
}
