import { Link } from 'react-router-dom'
import { ArrowLeft, Eye, Heart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useCatalog } from '../lib/catalogStore'
import { imgUrl } from '../lib/img'
import { useStore } from '../store'
import { useLang } from '../context/LangContext'
import { Stars, StockDot } from './ui'

/** List-view counterpart to ProductCard — same data, more room for the copy. */
export default function ProductRow({ product: p }) {
  const { saved, openQuickView } = useStore()
  const { categoryBySlug } = useCatalog()
  const { t } = useLang()
  const isSaved = saved.has(p.id)
  const cat = categoryBySlug[p.category]
  const href = `/product/${p.slug}`

  return (
    <article className="group flex gap-4 border-b border-bean-900/10 pb-5 sm:gap-6">
      <Link
        to={href}
        tabIndex={-1}
        aria-hidden="true"
        className="sf-tile h-28 w-24 shrink-0 overflow-hidden rounded-lg sm:h-36 sm:w-32"
      >
        <img
          src={imgUrl(p.img, { w: 400, h: 480 })}
          alt=""
          loading="lazy"
          className="h-full w-full object-contain p-2.5 transition-transform duration-700 group-hover:scale-[1.05] sm:p-3.5"
        />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col py-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {cat?.name && (
            <Link to={`/category/${p.category}`} className="text-2xs font-semibold text-primary hover:underline">
              {cat.name}
            </Link>
          )}
          {p.brand && <span className="text-2xs font-semibold text-muted-foreground">{p.brand}</span>}
          <StockDot stock={p.stock} />
        </div>

        <h3 className="clamp-2 mt-1.5 text-sm font-semibold leading-snug text-bean-900 sm:text-base">
          <Link to={href} className="transition-colors hover:text-primary">
            {p.name}
          </Link>
        </h3>

        {p.rating > 0 && (
          <div className="mt-1.5">
            <Stars value={p.rating} reviews={p.reviews} />
          </div>
        )}

        {p.desc && <p className="clamp-2 mt-2 hidden text-xs leading-relaxed text-muted-foreground sm:block">{p.desc}</p>}

        <div className="mt-auto flex items-center gap-2 pt-3">
          <Button asChild variant="ink" size="sm">
            <Link to={href}>
              {t.details} <ArrowLeft className="ltr:rotate-180" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="line"
            size="icon-sm"
            onClick={() => saved.toggle(p.id)}
            aria-pressed={isSaved}
            aria-label={isSaved ? t.removeFromSaved : t.saveThisItem}
          >
            <Heart className={cn(isSaved && 'text-primary')} fill={isSaved ? 'currentColor' : 'none'} />
          </Button>
          <Button
            type="button"
            variant="line"
            size="icon-sm"
            onClick={() => openQuickView(p)}
            aria-label={`${t.quickView} — ${p.name}`}
            className="hidden sm:inline-flex"
          >
            <Eye />
          </Button>
        </div>
      </div>
    </article>
  )
}
