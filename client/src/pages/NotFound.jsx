import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Home, Search } from 'lucide-react'
import { useCatalog } from '../lib/catalogStore'
import { useStore } from '../store'
import { useLang } from '../context/LangContext'

export default function NotFound() {
  const { setSearchOpen } = useStore()
  const { categories } = useCatalog()
  const { t } = useLang()

  return (
    <div className="container-x flex min-h-[70vh] flex-col items-center justify-center py-20 text-center">
      <p dir="ltr" className="sf-display text-[7rem] leading-none text-bean-900/10 sm:text-[9rem]">
        404
      </p>
      <h1 className="sf-display mt-2 text-3xl text-bean-900 sm:text-4xl">{t.shelfEmpty}</h1>
      <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-muted-foreground">
        {t.shelfEmptyBody}
      </p>

      <div className="mt-9 flex flex-wrap justify-center gap-3">
        <Button asChild variant="ink" size="lg">
          <Link to="/">
            <Home /> {t.backToHome}
          </Link>
        </Button>
        <Button type="button" variant="line" size="lg" onClick={() => setSearchOpen(true)}>
          <Search /> {t.searchShortcut}
        </Button>
        <Button type="button" variant="line" size="lg" onClick={() => window.history.back()}>
          <ArrowLeft className="ltr:rotate-180" /> {t.goBack}
        </Button>
      </div>

      <div className="mt-12 max-w-xl">
        <div className="sf-eyebrow mb-4 justify-center">{t.jumpDepartment}</div>
        <div className="flex flex-wrap justify-center gap-1.5">
          {categories.map((c) => (
            <Link
              key={c.slug}
              to={`/category/${c.slug}`}
              className="rounded-full border border-bean-900/15 px-3 py-1.5 text-xs font-medium text-bean-900 transition-colors hover:border-bean-900 hover:bg-bean-900 hover:text-bean-50"
            >
              {c.name}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
