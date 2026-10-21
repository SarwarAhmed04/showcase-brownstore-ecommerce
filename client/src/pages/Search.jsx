import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SearchX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Catalog from '../components/Catalog'
import PageHead from '../components/PageHead'
import { useCatalog } from '../lib/catalogStore'
import { useLang } from '../context/LangContext'

export default function Search() {
  const [params] = useSearchParams()
  const { categories } = useCatalog()
  const { t } = useLang()
  const q = params.get('q') ?? ''
  const [total, setTotal] = useState(null)

  return (
    <div className="container-x py-10 lg:py-14">
      <PageHead
        eyebrow={t.searchShortcut}
        title={
          <>
            {t.searchResults} <span className="text-primary">“{q}”</span>
          </>
        }
        sub={total === 0 ? t.searchNoMatch : undefined}
        crumbs={[{ label: t.searchShortcut }]}
      />

      {total === 0 && (
        <div className="mb-8 flex flex-wrap gap-1.5">
          <span className="py-1.5 text-xs text-muted-foreground">{t.tryDepartment}</span>
          {categories.map((c) => (
            <Link
              key={c.slug}
              to={`/category/${c.slug}`}
              className="rounded-full border border-bean-900/15 px-3 py-1.5 text-xs font-semibold text-bean-900 transition-colors hover:border-bean-900 hover:bg-bean-900 hover:text-bean-50"
            >
              {c.name}
            </Link>
          ))}
        </div>
      )}

      <Catalog
        query={{ q }}
        emptyIcon={SearchX}
        emptyTitle={`${t.searchNoMatch} “${q}”`}
        emptySub={t.widenFilters}
        emptyAction={
          <Button asChild variant="ink">
            <Link to="/shop">{t.startBrowsing}</Link>
          </Button>
        }
        onMeta={({ total: next }) => setTotal(next)}
      />
    </div>
  )
}
