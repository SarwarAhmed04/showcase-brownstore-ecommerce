import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react'
import ProductCard from './ProductCard'

// A horizontally-scrolling shelf, the way the reference site presents each
// category. Arrows appear only when there is actually somewhere to scroll.
export default function ProductRail({ title, eyebrow, sub, items, to, cardWidth = 250 }) {
  const scroller = useRef(null)
  const [edges, setEdges] = useState({ start: true, end: false })

  const measure = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setEdges({
      start: scrollLeft <= 4,
      end: scrollLeft + clientWidth >= scrollWidth - 4,
    })
  }, [])

  useEffect(() => {
    measure()
    const el = scroller.current
    if (!el) return
    el.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      el.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [measure, items])

  const nudge = (dir) => {
    scroller.current?.scrollBy({ left: dir * (cardWidth + 20) * 2, behavior: 'smooth' })
  }

  if (!items?.length) return null

  return (
    <section className="py-10">
      <div className="container-x">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            {eyebrow && <div className="eyebrow mb-3">{eyebrow}</div>}
            <h2 className="headline text-2xl sm:text-3xl">{title}</h2>
            {sub && <p className="mt-2 max-w-xl text-sm text-foreground/75">{sub}</p>}
          </div>

          <div className="flex items-center gap-2">
            {to && (
              <Link
                to={to}
                className="mr-1 hidden items-center gap-1.5 text-sm font-semibold text-primary transition hover:gap-2.5 sm:flex"
              >
                View all <ArrowRight size={15} />
              </Link>
            )}
            <button
              type="button"
              onClick={() => nudge(-1)}
              disabled={edges.start}
              aria-label={`Scroll ${title} left`}
              className="glass-soft grid h-9 w-9 place-items-center rounded-full transition-all hover:text-primary disabled:opacity-30"
            >
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              onClick={() => nudge(1)}
              disabled={edges.end}
              aria-label={`Scroll ${title} right`}
              className="glass-soft grid h-9 w-9 place-items-center rounded-full transition-all hover:text-primary disabled:opacity-30"
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      </div>

      {/* full-bleed rail so cards run to the screen edge */}
      <div className="relative">
        <div ref={scroller} className="rail container-x">
          {items.map((p) => (
            <ProductCard key={p.id} product={p} width={cardWidth} compact />
          ))}
          {to && (
            <Link
              to={to}
              className="glass grid place-items-center rounded-card px-8 text-center transition-all hover:-translate-y-1.5"
              style={{ width: cardWidth }}
            >
              <span className="flex flex-col items-center gap-3">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-[rgb(var(--accent)/.14)] text-primary">
                  <ArrowRight size={20} />
                </span>
                <span className="text-sm font-semibold">See everything</span>
              </span>
            </Link>
          )}
        </div>
      </div>
    </section>
  )
}
