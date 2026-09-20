import { Link } from 'react-router-dom'
import { ArrowRight, Eye, Heart } from 'lucide-react'
import { Badge, StockBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useCatalog } from '../lib/catalogStore'
import { imgUrl } from '../lib/img'
import { useStore } from '../store'
import { useLang } from '../context/LangContext'
import { Stars } from './ui'

/** List-view counterpart to ProductCard — same data, more room for the copy. */
export default function ProductRow({ product: p }) {
  const { saved, openQuickView } = useStore()
  const { categoryBySlug } = useCatalog()
  const { t } = useLang()
  const isSaved = saved.has(p.id)
  const cat = categoryBySlug[p.category]

  return (
    <Card className="group glass flex gap-4 overflow-hidden rounded-card border-0 p-3 transition-all duration-300 hover:-translate-y-1 sm:gap-6 sm:p-4">
      <Link
        to={`/product/${p.slug}`}
        aria-label={p.name}
        className="shot h-28 w-24 shrink-0 overflow-hidden rounded-md sm:h-40 sm:w-40"
      >
        <img
          src={imgUrl(p.img, { w: 400, h: 400 })}
          alt={p.name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col py-1">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-2xs font-bold uppercase tracking-[.16em] text-muted-foreground">
                {p.brand}
              </span>
              {p.badge && <Badge variant="muted">{p.badge}</Badge>}
              {p.stock !== 'in' && <StockBadge status={p.stock} />}
            </div>

            <h3 className="clamp-1 text-sm font-semibold sm:text-base">
              <Link to={`/product/${p.slug}`} className="transition-colors hover:text-primary">
                {p.name}
              </Link>
            </h3>

            <div className="mt-1.5">
              <Stars value={p.rating} reviews={p.reviews} />
            </div>

            <p className="clamp-2 mt-2 hidden text-xs leading-relaxed text-muted-foreground sm:block">
              {p.desc}
            </p>
          </div>

          <div className="hidden shrink-0 gap-1.5 sm:flex">
            <Button
              type="button"
              variant="glass"
              size="icon-sm"
              onClick={() => saved.toggle(p.id)}
              aria-pressed={isSaved}
              aria-label={isSaved ? t.removeFromSaved : t.saveThisItem}
            >
              <Heart
                className={cn(isSaved && 'text-clay-400')}
                fill={isSaved ? 'currentColor' : 'none'}
              />
            </Button>
            <Button
              type="button"
              variant="glass"
              size="icon-sm"
              onClick={() => openQuickView(p)}
              aria-label={`${t.details} ${p.name}`}
            >
              <Eye />
            </Button>
          </div>
        </div>

        <div className="mt-auto flex flex-wrap items-end justify-end gap-3 pt-3">
          <div className="flex items-center gap-3">
            <Link
              to={`/category/${p.category}`}
              className="hidden text-2xs font-semibold text-muted-foreground transition hover:text-primary sm:block"
            >
              {cat?.name}
            </Link>
            <Button asChild variant="outline" size="sm" className="rounded-pill">
              <Link to={`/product/${p.slug}`}>
                Details <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}
