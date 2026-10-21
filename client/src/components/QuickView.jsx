import { Link } from 'react-router-dom'
import { ArrowLeft, Heart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useCatalog } from '../lib/catalogStore'
import { imgUrl } from '../lib/img'
import { useStore } from '../store'
import { useLang } from '../context/LangContext'
import { Stars, StockDot } from './ui'
import EnquiryDialog from './EnquiryDialog'

export default function QuickView() {
  const { quickView: p, closeQuickView, saved } = useStore()
  const { categoryBySlug } = useCatalog()
  const { t } = useLang()

  const open = Boolean(p)
  const cat = p ? categoryBySlug[p.category] : null
  const isSaved = p ? saved.has(p.id) : false

  return (
    <Dialog open={open} onOpenChange={(v) => !v && closeQuickView()}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto rounded-2xl border-0 bg-background p-0 sm:max-w-3xl">
        {p && (
          <div className="grid sm:grid-cols-2">
            <div className="sf-tile relative">
              <div className="aspect-square">
                <img
                  src={imgUrl(p.img, { w: 800, h: 800 })}
                  alt={p.name}
                  className="h-full w-full object-contain p-8"
                />
              </div>
              {p.badge && (
                <span className="absolute start-4 top-4 rounded-sm bg-bean-900 px-2 py-1 text-[10px] font-bold leading-none text-bean-50">
                  {p.badge === 'New' ? t.newBadge : p.badge}
                </span>
              )}
            </div>

            <div className="flex flex-col gap-4 p-6 sm:p-8">
              <div className="pe-8">
                {cat?.name && (
                  <Link
                    to={`/category/${p.category}`}
                    onClick={closeQuickView}
                    className="sf-eyebrow"
                  >
                    {cat.name}
                  </Link>
                )}
                <DialogTitle className="sf-display mt-3 text-xl leading-tight text-bean-900 sm:text-2xl">
                  {p.name}
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs">
                  {t.byBrand.replace('{brand}', p.brand)}
                </DialogDescription>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {p.rating > 0 ? <Stars value={p.rating} reviews={p.reviews} size={15} /> : null}
                <StockDot stock={p.stock} />
              </div>

              {p.desc ? (
                <p className="clamp-3 text-xs leading-relaxed text-muted-foreground">{p.desc}</p>
              ) : null}

              {p.specs && Object.keys(p.specs).length > 0 && (
                <dl className="grid grid-cols-2 gap-2">
                  {Object.entries(p.specs).slice(0, 4).map(([k, v]) => (
                    <div key={k} className="rounded-md bg-bean-50 px-3 py-2">
                      <dt className="text-2xs font-bold text-muted-foreground">{k}</dt>
                      <dd className="mt-0.5 text-xs font-medium text-bean-900">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <div className="mt-auto space-y-2 pt-2">
                <div className="flex gap-2">
                  <Button asChild variant="ink" className="flex-1">
                    <Link to={`/product/${p.slug}`} onClick={closeQuickView}>
                      {t.fullDetails} <ArrowLeft className="ltr:rotate-180" />
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    variant="line"
                    size="icon"
                    onClick={() => saved.toggle(p.id)}
                    aria-pressed={isSaved}
                    aria-label={isSaved ? t.removeFromSaved : t.saveThisItem}
                  >
                    <Heart
                      className={cn(isSaved && 'text-primary')}
                      fill={isSaved ? 'currentColor' : 'none'}
                    />
                  </Button>
                </div>
                <EnquiryDialog
                  product={p}
                  trigger={
                    <Button variant="line" className="w-full">
                      {t.reserveOrAskThis}
                    </Button>
                  }
                />
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
