import { Link } from 'react-router-dom'
import { Eye, Heart } from 'lucide-react'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { imgUrl } from '../lib/img'
import { useStore } from '../store'
import { useLang } from '../context/LangContext'
import { Stars } from './ui'

/**
 * Commerce card, Origin UI layout adapted to Brown Store tokens.
 *
 * The pattern: fixed-ratio image, badges pinned top-left, hover actions
 * top-right, and a content block whose price row is pushed to the bottom by
 * `mt-auto` so cards in a row line up regardless of title length.
 */
export default function ProductCard({ product: p, width, compact = false, className }) {
  const { saved, openQuickView } = useStore()
  const { t } = useLang()
  const isSaved = saved.has(p.id)

  return (
    <Card
      className={cn(
        'group glass relative flex flex-col overflow-hidden rounded-card border-0 p-0',
        'transition-transform duration-300 hover:-translate-y-1',
        className,
      )}
      style={{ width }}
    >
      {/* ---------- imagery ---------- */}
      <Link to={`/product/${p.slug}`} aria-label={p.name} className="shot block">
        <AspectRatio ratio={4 / 5}>
          <img
            src={imgUrl(p.img, { w: 640, h: 800 })}
            alt={p.name}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
          {/* scrim keeps overlay badges legible on any photograph */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/10" />
        </AspectRatio>
      </Link>

      <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-2">
        {p.onDeal && <Badge variant="deal">{t.deals}</Badge>}
        {p.badge && <Badge variant="overlay">{p.badge}</Badge>}
        {p.stock === 'out' && <Badge variant="overlay">{t.outOfStock}</Badge>}
      </div>

      {/* hover actions — reachable by keyboard via group-focus-within */}
      <div className="absolute right-3 top-3 flex flex-col gap-2 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100">
        <Button
          type="button"
          variant="overlay"
          size="icon-sm"
          onClick={() => saved.toggle(p.id)}
          aria-pressed={isSaved}
          aria-label={isSaved ? t.removeFromSaved : t.saveThisItem}
        >
          <Heart className={cn(isSaved && 'text-clay-300')} fill={isSaved ? 'currentColor' : 'none'} />
        </Button>
        <Button
          type="button"
          variant="overlay"
          size="icon-sm"
          onClick={() => openQuickView(p)}
          aria-label={`${t.details} ${p.name}`}
        >
          <Eye />
        </Button>
      </div>

      {/* ---------- copy ---------- */}
      <div className={cn('flex flex-1 flex-col', compact ? 'gap-1.5 p-4' : 'gap-2 p-5')}>
        <span className="text-2xs font-bold uppercase tracking-[.16em] text-muted-foreground">
          {p.brand}
        </span>

        <h3
          className={cn('clamp-1 font-semibold leading-snug', compact ? 'text-xs' : 'text-sm')}
          title={p.name}
        >
          <Link to={`/product/${p.slug}`} className="transition-colors hover:text-primary">
            {p.name}
          </Link>
        </h3>

      {p.rating > 0 ? <Stars value={p.rating} reviews={p.reviews} showCount={!compact} /> : <div />}

        {/* Seven-figure prices will not sit beside a button on a two-column
            phone grid, so stack until there is room. */}
        <div className="mt-auto flex flex-col gap-2 pt-2 sm:flex-row sm:items-end sm:justify-end">
          <Button asChild variant="outline" size="xs" className="shrink-0 self-start rounded-pill sm:self-auto">
            <Link to={`/product/${p.slug}`}>{t.details}</Link>
          </Button>
        </div>
      </div>
    </Card>
  )
}

/** Placeholder used while a grid is loading or filtering. */
export function ProductCardSkeleton() {
  return (
    <Card className="glass overflow-hidden rounded-card border-0 p-0">
      <AspectRatio ratio={4 / 5}>
        <Skeleton className="h-full w-full rounded-none" />
      </AspectRatio>
      <div className="space-y-2.5 p-5">
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-5 w-28" />
      </div>
    </Card>
  )
}
