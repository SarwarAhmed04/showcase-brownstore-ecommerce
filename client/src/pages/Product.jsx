import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  BadgeCheck,
  Check,
  Copy,
  Heart,
  MapPin,
  RotateCcw,
  Share2,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Badge, StockBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import PageHead from "../components/PageHead";
import ProductRail from "../components/ProductRail";
import EnquiryDialog from "../components/EnquiryDialog";
import { PageSkeleton, Reveal, Stars } from "../components/ui";
import { useCatalog } from "../lib/catalogStore";
import { adaptProduct } from "../lib/catalog";
import { useStore } from "../store";
import { api } from "../api";
import { useLang } from "../context/LangContext";

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
    <div className="py-10 lg:py-section-sm">
      <div className="container-x">
        <PageHead
          crumbs={[
            { label: t.shop, to: "/shop" },
            { label: cat?.name || t.shop, to: `/category/${p.category}` },
            { label: p.name },
          ]}
          title={<span className="sr-only">{p.name}</span>}
        />

        <div className="-mt-4 grid gap-8 lg:grid-cols-2 lg:gap-12">
          <div className="lg:sticky lg:top-[190px] lg:self-start">
            <Card className="glass shot relative overflow-hidden rounded-panel border-0 p-0">
              <AspectRatio ratio={1}>
                <img
                  key={shot}
                  src={gallery[shot] || "/logo-hero.png"}
                  alt={p.name}
                  className="h-full w-full animate-fadeIn object-cover"
                />
              </AspectRatio>
              <div className="absolute left-4 top-4 flex flex-col items-start gap-2">
                {p.onDeal && <Badge variant="deal">{t.deals}</Badge>}
                {p.badge && <Badge variant="overlay">{p.badge}</Badge>}
              </div>
            </Card>

            {gallery.length > 1 && (
              <div className="mt-3 grid grid-cols-4 gap-3">
                {gallery.slice(0, 8).map((src, i) => (
                  <button
                    key={src + i}
                    type="button"
                    onClick={() => setShot(i)}
                    aria-pressed={i === shot}
                    className={cn(
                      "shot overflow-hidden rounded-md border-2 transition-all",
                      i === shot ? "border-primary opacity-100" : "border-transparent opacity-55 hover:opacity-90"
                    )}
                  >
                    <AspectRatio ratio={1}>
                      <img src={src} alt="" className="h-full w-full object-cover" />
                    </AspectRatio>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            {cat?.name && (
              <Link
                to={`/category/${p.category}`}
                className="text-2xs font-bold uppercase tracking-[.18em] text-primary"
              >
                {cat.name}
              </Link>
            )}

            <h1 className="headline mt-3 text-2xl leading-[1.08] sm:text-3xl lg:text-4xl">{p.name}</h1>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              {p.rating > 0 ? <Stars value={p.rating} reviews={p.reviews} size={16} /> : null}
              <span className="flex items-center gap-1.5 text-xs font-semibold text-success">
                <BadgeCheck className="size-4" /> {p.stock === "in" ? t.inStock : t.outOfStock}
              </span>
              {p.brand ? <span className="text-xs text-muted-foreground">{p.brand}</span> : null}
              <StockBadge status={p.stock} />
            </div>

            {p.desc ? <p className="mt-7 text-base leading-relaxed text-muted-foreground">{p.desc}</p> : null}

            <div className="mt-8 space-y-2">
              <EnquiryDialog
                product={p}
                trigger={
                  <Button variant="brand" size="xl" className="w-full">
                    {t.reserveItem}
                  </Button>
                }
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="glass"
                  size="lg"
                  onClick={() => saved.toggle(p.id)}
                  aria-pressed={isSaved}
                  className="flex-1"
                >
                  <Heart className={cn(isSaved && "text-clay-400")} fill={isSaved ? "currentColor" : "none"} />
                  {isSaved ? t.saved : t.saveForLater}
                </Button>
                <Button type="button" variant="glass" size="lg" onClick={share}>
                  {copied ? <Check /> : canShare ? <Share2 /> : <Copy />}
                  {copied ? t.copied : t.share}
                </Button>
              </div>
            </div>

            <Tabs defaultValue="specs" className="mt-10">
              <TabsList className="w-full">
                <TabsTrigger value="specs" className="flex-1">
                  {t.specs}
                </TabsTrigger>
                <TabsTrigger value="service" className="flex-1">
                  {t.serviceCollection}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="specs" className="mt-4">
                <Card className="glass overflow-hidden rounded-card border-0 p-0">
                  <dl className="divide-y divide-border/50">
                    {Object.entries(specs).map(([k, v]) => (
                      <div key={k} className="flex gap-4 px-5 py-3.5">
                        <dt className="w-2/5 shrink-0 text-xs font-semibold text-muted-foreground">{k}</dt>
                        <dd className="text-xs">{v}</dd>
                      </div>
                    ))}
                    {p.sku && !specs[t.sku] && (
                      <div className="flex gap-4 px-5 py-3.5">
                        <dt className="w-2/5 shrink-0 text-xs font-semibold text-muted-foreground">{t.sku}</dt>
                        <dd className="text-xs tabular-nums">{p.sku}</dd>
                      </div>
                    )}
                  </dl>
                </Card>
              </TabsContent>

              <TabsContent value="service" className="mt-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {SERVICE.map(({ Icon, title, sub }) => (
                    <Card key={title} className="glass-soft flex gap-3 rounded-card border-0 p-4">
                      <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                      <div>
                        <div className="text-xs font-bold">{title}</div>
                        <div className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{sub}</div>
                      </div>
                    </Card>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
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
