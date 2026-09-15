import { Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useReveal } from '../lib/hooks'

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
      <div className="flex items-center gap-[2px]">
        {[0, 1, 2, 3, 4].map((i) => {
          const fill = Math.max(0, Math.min(1, value - i))
          return (
            <span key={i} className="relative inline-block" style={{ width: size, height: size }}>
              <Star size={size} className="absolute inset-0 text-muted-foreground" strokeWidth={1.6} />
              <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
                <Star size={size} className="text-primary" fill="currentColor" strokeWidth={0} />
              </span>
            </span>
          )
        })}
      </div>
      <span className="text-2xs font-semibold text-foreground/75">{value.toFixed(1)}</span>
      {showCount && reviews != null && (
        <span className="text-2xs text-muted-foreground">({reviews})</span>
      )}
    </div>
  )
}

/* Section header used across every page. */
export function SectionHead({ eyebrow, title, sub, action }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
      <div className="max-w-2xl">
        {eyebrow && <div className="eyebrow mb-4">{eyebrow}</div>}
        <h2 className="headline text-3xl sm:text-4xl lg:text-4xl">{title}</h2>
        {sub && <p className="mt-3 text-sm leading-relaxed text-foreground/75 sm:text-base">{sub}</p>}
      </div>
      {action}
    </div>
  )
}

/* Corner badge on product imagery. */
export function Badge({ children, tone = 'accent' }) {
  const tones = {
    accent: 'bg-primary text-primary-foreground',
    dark: 'bg-black/65 text-white backdrop-blur-md',
    green: 'bg-emerald-500/90 text-white',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-2xs font-extrabold uppercase tracking-wider shadow-lg ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

/* Empty state for search / filter / saved pages. */
export function EmptyState({ icon: Icon, title, sub, action }) {
  return (
    <div className="glass mx-auto flex max-w-lg flex-col items-center rounded-panel px-8 py-16 text-center">
      {Icon && (
        <div className="mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-[rgb(var(--accent)/.12)] text-primary">
          <Icon size={28} />
        </div>
      )}
      <h3 className="headline text-2xl">{title}</h3>
      {sub && <p className="mt-2 text-sm text-foreground/75">{sub}</p>}
      {action && <div className="mt-7">{action}</div>}
    </div>
  )
}

/* Social glyphs — lucide dropped brand icons, so these are hand-drawn. */
export const Social = {
  Instagram: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...p}>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="17.6" cy="6.4" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  Facebook: (p) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M14 8.5V6.9c0-.8.2-1.2 1.3-1.2H17V2.6h-2.6c-3 0-4 1.5-4 4v1.9H8V12h2.4v9.4H14V12h2.5l.4-3.5H14Z" />
    </svg>
  ),
  X: (p) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M17.5 3h3l-6.6 7.5L21.8 21h-6l-4.7-6.1L5.7 21h-3l7-8-6.8-10h6.1l4.3 5.6L17.5 3Zm-1 16h1.6L7.6 4.6H5.8L16.5 19Z" />
    </svg>
  ),
  Youtube: (p) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M22.5 7.6a2.8 2.8 0 0 0-1.9-2C18.9 5.1 12 5.1 12 5.1s-6.9 0-8.6.5a2.8 2.8 0 0 0-1.9 2A29 29 0 0 0 1 12a29 29 0 0 0 .5 4.4 2.8 2.8 0 0 0 1.9 2c1.7.4 8.6.4 8.6.4s6.9 0 8.6-.4a2.8 2.8 0 0 0 1.9-2A29 29 0 0 0 23 12a29 29 0 0 0-.5-4.4ZM9.8 15.3V8.7l5.7 3.3-5.7 3.3Z" />
    </svg>
  ),
}

/* Page-level placeholder while the catalogue loads. Shown instead of a 404,
   so a valid address never flashes an error mid-fetch. */
export function PageSkeleton() {
  return (
    <div className="container-x py-14">
      <div className="shimmer mb-4 h-3 w-40 rounded-full" />
      <div className="shimmer mb-3 h-12 w-2/3 max-w-xl rounded-2xl" />
      <div className="shimmer mb-10 h-4 w-1/2 max-w-md rounded-full" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="glass overflow-hidden rounded-card">
            <div className="shimmer aspect-[4/5] w-full" />
            <div className="space-y-2.5 p-5">
              <div className="shimmer h-2.5 w-16 rounded-full" />
              <div className="shimmer h-3.5 w-full rounded-full" />
              <div className="shimmer h-5 w-24 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* Shown when the API cannot be reached at all. */
export function ConnectionError({ error, onRetry }) {
  return (
    <div className="container-x py-24">
      <div className="glass mx-auto max-w-lg rounded-panel p-10 text-center">
        <h2 className="headline text-2xl">Cannot reach the catalogue</h2>
        <p className="mt-3 text-sm text-foreground/75">
          {error?.message ?? 'The API did not respond.'}
        </p>
        <p className="mt-4 text-xs text-muted-foreground">
          If you are running this locally, start the API with{' '}
          <code className="rounded bg-[rgb(var(--surface)/.12)] px-1.5 py-0.5">npm run server</code>{' '}
          — or use <code className="rounded bg-[rgb(var(--surface)/.12)] px-1.5 py-0.5">npm run dev:all</code> to run both.
        </p>
        {onRetry && (
          <Button type="button" variant="brand" onClick={onRetry} className="mt-7">
            Try again
          </Button>
        )}
      </div>
    </div>
  )
}
