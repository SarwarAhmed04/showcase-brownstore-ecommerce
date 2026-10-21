import { Link } from 'react-router-dom'
import Catalog from '../components/Catalog'
import { Breadcrumbs } from '../components/PageHead'
import { PageSkeleton } from '../components/ui'
import { useCatalog } from '../lib/catalogStore'
import { useLang } from '../context/LangContext'

export default function Shop() {
  const { status, categories } = useCatalog()
  const { t } = useLang()
  if (status === 'loading') return <PageSkeleton />

  return (
    <>
      <section className="relative overflow-hidden bg-bean-900 text-bean-50">
        <div aria-hidden className="pointer-events-none absolute -bottom-32 end-[8%] h-80 w-56 rounded-t-full border border-tan/15" />
        <div className="container-x relative py-12 sm:py-16 lg:py-20">
          <Breadcrumbs crumbs={[{ label: t.shop }]} className="text-bean-50/55" />
          <p className="sf-eyebrow mt-8 text-tan">{t.shopEyebrow}</p>
          <h1 className="sf-display mt-4 max-w-3xl text-4xl sm:text-5xl lg:text-6xl">{t.shopTitle}</h1>
          {t.shopSub ? (
            <p className="mt-4 max-w-md text-sm leading-relaxed text-bean-50/65 sm:text-base">{t.shopSub}</p>
          ) : null}
        </div>
      </section>

      {categories.length > 0 && (
        <div className="border-b border-bean-900/10">
          <div className="container-x no-scrollbar flex gap-1 overflow-x-auto py-3">
            {categories.map((c) => (
              <Link
                key={c.slug}
                to={`/category/${c.slug}`}
                className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold text-bean-900/60 transition-colors hover:bg-bean-100 hover:text-bean-900"
              >
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="container-x py-10 lg:py-14">
        <Catalog query={{}} />
      </div>
    </>
  )
}
