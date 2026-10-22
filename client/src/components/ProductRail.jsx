import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import ProductCard from './ProductCard'
import { ArrowLink, RailArrows, SectionHead } from './ui'
import { useRail } from '../lib/hooks'
import { useLang } from '../context/LangContext'

const CARD = 'w-[44vw] max-w-[230px] sm:w-[230px]'

export default function ProductRail({ title, eyebrow, sub, items, to }) {
  const { t } = useLang()
  const rail = useRail(items?.length ?? 0)

  if (!items?.length) return null

  return (
    <section className="py-10 sm:py-14">
      <div className="container-x">
        <SectionHead
          eyebrow={eyebrow}
          title={title}
          sub={sub}
          action={
            <div className="flex items-center gap-5">
              {to && (
                <ArrowLink to={to} className="hidden sm:inline-flex">
                  {t.viewAll}
                </ArrowLink>
              )}
              <RailArrows rail={rail} label={typeof title === 'string' ? title : ''} />
            </div>
          }
        />
      </div>

      <div
        ref={rail.ref}
        data-fade-start={rail.canPrev || undefined}
        data-fade-end={rail.canNext || undefined}
        className="rail container-x scroll-px-4 sm:scroll-px-6 lg:scroll-px-10"
      >
        {items.map((p) => (
          <ProductCard key={p.id} product={p} className={CARD} compact />
        ))}
        {to && (
          <Link
            to={to}
            className={`group flex aspect-[4/5] flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-bean-900/25 px-6 text-center transition-colors duration-300 hover:border-bean-900 hover:bg-bean-900 hover:text-bean-50 ${CARD}`}
          >
            <span className="grid size-14 place-items-center rounded-full bg-bean-900 text-bean-50 transition-colors duration-300 group-hover:bg-tan group-hover:text-bean-900">
              <ArrowLeft className="size-5 ltr:rotate-180" />
            </span>
            <span className="text-sm font-semibold">{t.seeEverything}</span>
          </Link>
        )}
      </div>
    </section>
  )
}
