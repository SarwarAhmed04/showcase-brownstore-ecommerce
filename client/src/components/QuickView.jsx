import { Link } from 'react-router-dom'
import { ArrowRight, Heart } from 'lucide-react'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Badge, StockBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useCatalog } from '../lib/catalogStore'
import { imgUrl } from '../lib/img'
import { useStore } from '../store'
import { useLang } from '../context/LangContext'
import { Stars } from './ui'
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
      <DialogContent className="glass max-h-[92vh] gap-0 overflow-y-auto rounded-panel border-0 p-0 sm:max-w-4xl">
        {p && (
          <div className="grid sm:grid-cols-2">
            {/* image */}
            <div className="shot relative">
              <AspectRatio ratio={1} className="sm:h-full">
                <img
                  src={imgUrl(p.img, { w: 800, h: 800 })}
                  alt={p.name}
                  className="h-full w-full object-cover"
                />
              </AspectRatio>
              <div className="absolute left-4 top-4 flex flex-col items-start gap-2">
                {p.onDeal && <Badge variant="deal">{t.deals}</Badge>}
                {p.badge && <Badge variant="overlay">{p.badge}</Badge>}
              </div>
            </div>

            {/* detail */}
            <div className="flex flex-col gap-4 p-6 sm:p-8">
              <div className="pr-8">
                <Link
                  to={`/category/${p.category}`}
                  onClick={closeQuickView}
                  className="text-2xs font-bold uppercase tracking-[.18em] text-primary"
                >
                  {cat?.name}
                </Link>
                <DialogTitle className="headline mt-2 text-xl leading-tight sm:text-2xl">
                  {p.name}
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs">by {p.brand}</DialogDescription>
              </div>

              <div className="flex flex-wrap items-center gap-3">
              {p.rating > 0 ? <Stars value={p.rating} reviews={p.reviews} size={15} /> : null}
                <StockBadge status={p.stock} />
              </div>

              <p className="clamp-3 text-xs leading-relaxed text-muted-foreground">{p.desc}</p>

              <dl className="grid grid-cols-2 gap-2">
                {Object.entries(p.specs || {}).slice(0, 4).map(([k, v]) => (
                  <div key={k} className="glass-soft rounded-md px-3 py-2">
                    <dt className="text-2xs font-bold uppercase tracking-wider text-muted-foreground">
                      {k}
                    </dt>
                    <dd className="mt-0.5 text-xs font-medium">{v}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-auto space-y-2 pt-2">
                <div className="flex gap-2">
                  <Button asChild variant="brand" className="flex-1">
                    <Link to={`/product/${p.slug}`} onClick={closeQuickView}>
                      Full details <ArrowRight />
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    variant="glass"
                    size="icon"
                    onClick={() => saved.toggle(p.id)}
                    aria-pressed={isSaved}
                    aria-label={isSaved ? 'Remove from saved' : 'Save this item'}
                  >
                    <Heart
                      className={cn(isSaved && 'text-clay-400')}
                      fill={isSaved ? 'currentColor' : 'none'}
                    />
                  </Button>
                </div>
                <EnquiryDialog product={p} trigger={<Button variant="glass" className="w-full">Reserve or ask about this</Button>} />
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
