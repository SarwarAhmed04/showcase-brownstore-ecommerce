import { Link } from 'react-router-dom'
import { ArrowLeft, ChevronLeft, ChevronRight, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useReveal } from '../lib/hooks'
import { useLang } from '../context/LangContext'

/* Scroll-reveal wrapper. `delay` staggers items inside a grid. */
export function Reveal({ children, delay = 0, className = '', as: Tag = 'div' }) {
  const ref = useReveal()
  return (
    <Tag ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </Tag>
  )
}

/* Five stars with a half-step fill, plus the numeric score. */
export function Stars({ value, reviews, size = 13, showCount = true }) {
  if (!value) return null
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-[2px]" dir="ltr">
        {[0, 1, 2, 3, 4].map((i) => {
          const fill = Math.max(0, Math.min(1, value - i))
          return (
            <span key={i} className="relative inline-block" style={{ width: size, height: size }}>
              <Star size={size} className="absolute inset-0 text-bean-300" strokeWidth={1.6} />
              <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
                <Star size={size} className="text-primary" fill="currentColor" strokeWidth={0} />
              </span>
            </span>
          )
        })}
      </div>
      <span className="text-2xs font-semibold text-bean-900/75">{value.toFixed(1)}</span>
      {showCount && reviews != null && <span className="text-2xs text-muted-foreground">({reviews})</span>}
    </div>
  )
}

/* "In stock" / "Out of stock" as a coloured dot, so it reads at a glance. */
export function StockDot({ stock, className }) {
  const { t } = useLang()
  const inStock = stock === 'in'
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-2xs font-semibold', className)}>
      <span className={cn('size-1.5 rounded-full', inStock ? 'bg-moss-500' : 'bg-clay-500')} />
      <span className={inStock ? 'text-moss-600' : 'text-clay-600'}>{inStock ? t.inStock : t.outOfStock}</span>
    </span>
  )
}

/* Arrow-led text link used as the "view all" action on sections. */
export function ArrowLink({ to, children, className, light = false }) {
  return (
    <Link
      to={to}
      className={cn(
        'group inline-flex shrink-0 items-center gap-2 text-sm font-semibold',
        light ? 'text-tan' : 'text-bean-900',
        className,
      )}
    >
      <span className="sf-link">{children}</span>
      <span
        className={cn(
          'grid size-8 place-items-center rounded-full border transition-colors duration-300',
          light
            ? 'border-tan/40 group-hover:border-tan group-hover:bg-tan group-hover:text-bean-900'
            : 'border-bean-900/20 group-hover:border-bean-900 group-hover:bg-bean-900 group-hover:text-bean-50',
        )}
      >
        <ArrowLeft className="size-3.5 transition-transform duration-300 ltr:rotate-180 ltr:group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
      </span>
    </Link>
  )
}

/* Prev/next for a `useRail` scroller. Chevrons point along the reading
   direction, so they flip with the document rather than staying physical. */
export function RailArrows({ rail, label = '', light = false }) {
  const { t } = useLang()
  if (!rail.overflow) return null
  const cls = cn(
    'grid size-10 place-items-center rounded-full border transition-colors duration-300 disabled:pointer-events-none disabled:opacity-30',
    light
      ? 'border-bean-50/25 text-bean-50 hover:bg-bean-50 hover:text-bean-900'
      : 'border-bean-900/20 text-bean-900 hover:border-bean-900 hover:bg-bean-900 hover:text-bean-50',
  )
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => rail.move(-1)}
        disabled={!rail.canPrev}
        aria-label={`${t.scrollPrev} ${label}`.trim()}
        className={cls}
      >
        <ChevronRight className="size-4 ltr:rotate-180" />
      </button>
      <button
        type="button"
        onClick={() => rail.move(1)}
        disabled={!rail.canNext}
        aria-label={`${t.scrollNext} ${label}`.trim()}
        className={cls}
      >
        <ChevronLeft className="size-4 ltr:rotate-180" />
      </button>
    </div>
  )
}

/* Section header: a hairline rule, a caramel eyebrow, and a big grotesque title. */
export function SectionHead({ eyebrow, title, sub, action, light = false, className }) {
  return (
    <div
      className={cn(
        'mb-8 border-t pt-6 sm:mb-10',
        light ? 'border-bean-50/15' : 'border-bean-900/15',
        className,
      )}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="max-w-2xl">
          {eyebrow && <div className={cn('sf-eyebrow mb-3', light && 'text-tan')}>{eyebrow}</div>}
          <h2 className={cn('sf-display text-2xl sm:text-3xl lg:text-4xl', light ? 'text-bean-50' : 'text-bean-900')}>
            {title}
          </h2>
          {sub && (
            <p className={cn('mt-3 max-w-xl text-sm leading-relaxed sm:text-base', light ? 'text-bean-50/65' : 'text-muted-foreground')}>
              {sub}
            </p>
          )}
        </div>
        {action}
      </div>
    </div>
  )
}

/* Empty state for search / filter / saved pages. */
export function EmptyState({ icon: Icon, title, sub, action }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-6 py-16 text-center">
      {Icon && (
        <div className="mb-6 grid h-24 w-20 place-items-center rounded-t-full bg-bean-100 text-primary">
          <Icon size={28} strokeWidth={1.6} />
        </div>
      )}
      <h3 className="sf-display text-2xl text-bean-900">{title}</h3>
      {sub && <p className="mt-2 text-sm text-muted-foreground">{sub}</p>}
      {action && <div className="mt-7">{action}</div>}
    </div>
  )
}

/* Product grid placeholder while a list is loading or filtering. */
export function GridSkeleton({ count = 8, className }) {
  return (
    <div className={cn('grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-4 lg:grid-cols-3 xl:grid-cols-4', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="aspect-[4/5] animate-pulse rounded-lg bg-bean-100" />
          <div className="mt-3 h-2.5 w-16 animate-pulse rounded-full bg-bean-100" />
          <div className="mt-2 h-3.5 w-4/5 animate-pulse rounded-full bg-bean-100" />
        </div>
      ))}
    </div>
  )
}

/* Page-level placeholder while the catalogue loads. Shown instead of a 404,
   so a valid address never flashes an error mid-fetch. */
export function PageSkeleton() {
  return (
    <div className="container-x py-10 lg:py-14">
      <div className="mb-3 h-3 w-40 animate-pulse rounded-full bg-bean-100" />
      <div className="mb-10 h-12 w-2/3 max-w-xl animate-pulse rounded-lg bg-bean-100" />
      <GridSkeleton />
    </div>
  )
}

/* Shown when the API cannot be reached at all. */
export function ConnectionError({ error, onRetry }) {
  const { t } = useLang()
  return (
    <div className="container-x py-24">
      <div className="mx-auto max-w-lg rounded-2xl bg-bean-900 p-10 text-center text-bean-50">
        <h2 className="sf-display text-2xl">{t.cannotReach}</h2>
        <p className="mt-3 text-sm text-bean-50/65">{error?.message ?? t.apiNoRespond}</p>
        {onRetry && (
          <Button type="button" variant="caramel" size="lg" onClick={onRetry} className="mt-7">
            {t.tryAgain}
          </Button>
        )}
      </div>
    </div>
  )
}
