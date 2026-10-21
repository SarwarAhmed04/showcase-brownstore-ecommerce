import { Link } from 'react-router-dom'
import { ArrowLeft, Eye, Heart } from 'lucide-react'
import { cn } from '@/lib/utils'
import { imgUrl } from '../lib/img'
import { useStore } from '../store'
import { useLang } from '../context/LangContext'
import { Stars, StockDot } from './ui'

function useBadge(p) {
  const { t } = useLang()
  return p.badge === 'New' ? t.newBadge : p.badge
}

function SaveButton({ product: p, className }) {
  const { saved } = useStore()
  const { t } = useLang()
  const isSaved = saved.has(p.id)
  return (
    <button
      type="button"
      onClick={() => saved.toggle(p.id)}
      aria-pressed={isSaved}
      aria-label={isSaved ? t.removeFromSaved : t.saveThisItem}
      className={cn(
        'grid size-9 place-items-center rounded-full transition-colors duration-300',
        isSaved ? 'bg-bean-900 text-tan' : 'bg-background/85 text-bean-900 hover:bg-bean-900 hover:text-bean-50',
        className,
      )}
    >
      <Heart className="size-4" fill={isSaved ? 'currentColor' : 'none'} />
    </button>
  )
}

/**
 * Portrait card: the packshot sits on a sand tile (white backgrounds are
 * multiplied away), save is always reachable, quick view rises on hover.
 */
export default function ProductCard({ product: p, width, compact = false, className }) {
  const { openQuickView } = useStore()
  const { t } = useLang()
  const badge = useBadge(p)
  const href = `/product/${p.slug}`

  return (
    <article className={cn('group relative flex flex-col', className)} style={{ width }}>
      <div className="sf-tile relative aspect-[4/5] overflow-hidden rounded-lg">
        <Link to={href} tabIndex={-1} aria-hidden="true" className="block h-full w-full">
          <img
            src={imgUrl(p.img, { w: 640, h: 800 })}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain p-5 transition-transform duration-700 ease-out group-hover:scale-[1.05] sm:p-6"
          />
        </Link>

        <div className="pointer-events-none absolute start-2.5 top-2.5 flex flex-col items-start gap-1.5">
          {badge && (
            <span className="rounded-sm bg-bean-900 px-2 py-1 text-[10px] font-bold leading-none text-bean-50 ltr:uppercase ltr:tracking-wider">
              {badge}
            </span>
          )}
        </div>

        <SaveButton product={p} className="absolute end-2.5 top-2.5" />

        <button
          type="button"
          onClick={() => openQuickView(p)}
          className="absolute inset-x-2.5 bottom-2.5 hidden h-10 translate-y-3 items-center justify-center gap-2 rounded-md bg-bean-900 text-xs font-semibold text-bean-50 opacity-0 transition-all duration-300 hover:bg-primary focus-visible:translate-y-0 focus-visible:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 lg:flex"
        >
          <Eye className="size-4" /> {t.quickView}
        </button>
      </div>

      <div className={cn('flex flex-1 flex-col', compact ? 'mt-2.5 gap-1' : 'mt-3 gap-1.5')}>
        <div className="flex min-h-4 items-center justify-between gap-2">
          <span className="truncate text-2xs font-semibold text-muted-foreground ltr:uppercase ltr:tracking-[.12em]">
            {p.brand}
          </span>
          <StockDot stock={p.stock} className="shrink-0" />
        </div>
        <h3 className={cn('clamp-2 font-semibold leading-snug text-bean-900', compact ? 'text-xs' : 'text-sm')}>
          <Link to={href} className="transition-colors hover:text-primary">
            {p.name}
          </Link>
        </h3>
        {p.rating > 0 && <Stars value={p.rating} reviews={p.reviews} showCount={!compact} />}
      </div>
    </article>
  )
}

/** Oversized lead card for the featured bento on the home page. */
export function FeatureCard({ product: p, className }) {
  const { t } = useLang()
  const badge = useBadge(p)
  const href = `/product/${p.slug}`

  return (
    <article className={cn('sf-tile group relative flex h-full flex-col overflow-hidden rounded-lg', className)}>
      <Link to={href} tabIndex={-1} aria-hidden="true" className="relative block min-h-[300px] flex-1 sm:min-h-[380px]">
        <img
          src={imgUrl(p.img, { w: 1000, h: 1000 })}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-contain p-10 transition-transform duration-700 ease-out group-hover:scale-[1.04] sm:p-14"
        />
      </Link>

      <div className="pointer-events-none absolute start-4 top-4 flex items-center gap-2 sm:start-6 sm:top-6">
        <span className="sf-eyebrow">{t.handPickedEyebrow}</span>
        {badge && (
          <span className="rounded-sm bg-bean-900 px-2 py-1 text-[10px] font-bold leading-none text-bean-50">{badge}</span>
        )}
      </div>
      <SaveButton product={p} className="absolute end-4 top-4 sm:end-6 sm:top-6" />

      <div className="relative flex items-end justify-between gap-4 p-5 sm:p-7">
        <div className="min-w-0">
          {p.brand && (
            <span className="text-2xs font-semibold text-muted-foreground ltr:uppercase ltr:tracking-[.12em]">{p.brand}</span>
          )}
          <h3 className="sf-display clamp-2 mt-1.5 text-xl text-bean-900 sm:text-2xl">
            <Link to={href} className="transition-colors hover:text-primary">
              {p.name}
            </Link>
          </h3>
          <StockDot stock={p.stock} className="mt-2.5" />
        </div>
        <Link
          to={href}
          aria-label={`${t.details} — ${p.name}`}
          className="grid size-12 shrink-0 place-items-center rounded-full bg-bean-900 text-bean-50 transition-colors duration-300 group-hover:bg-primary"
        >
          <ArrowLeft className="size-5 ltr:rotate-180" />
        </Link>
      </div>
    </article>
  )
}
