import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { ChevronDown, Heart, Menu, Search } from 'lucide-react'
import LanguageSwitcher from './LanguageSwitcher'
import Logo from './Logo'
import { useLang } from '../context/LangContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { useCatalog } from '../lib/catalogStore'
import { useScrolled } from '../lib/hooks'
import { useStore } from '../store'

export function Wordmark({ compact = false }) {
  const { t } = useLang()
  return (
    <Link to="/" className="group flex items-center gap-2.5" aria-label={t.brand}>
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-gradient-to-br from-caramel-400 to-caramel-600 shadow-lg transition-transform duration-500 group-hover:-rotate-6">
        <Logo className="h-8 w-8" />
      </span>
      {!compact && (
        <span className="leading-none">
          <span className="block whitespace-nowrap font-display text-lg font-black tracking-tight">
            Brown<span className="gold-text"> Store</span>
          </span>
          <span className="hidden whitespace-nowrap text-2xs font-bold uppercase tracking-[.28em] text-muted-foreground sm:block">
            {t.tagline}
          </span>
        </span>
      )}
    </Link>
  )
}

export default function Navbar() {
  const scrolled = useScrolled(10)
  const [menuOpen, setMenuOpen] = useState(false)
  const [catOpen, setCatOpen] = useState(false)
  const { saved, setSearchOpen } = useStore()
  const { categories } = useCatalog()
  const { t } = useLang()

  const NAV_ITEMS = [
    { to: '/', label: t.home, end: true },
    { to: '/shop', label: t.shop },
    { to: '/about', label: t.about },
    { to: '/contact', label: t.contact },
  ]

  const navLinkClass = ({ isActive }) =>
    cn(
      'rounded-pill px-3.5 py-2 text-sm font-semibold transition-all',
      isActive
        ? 'bg-primary/15 text-primary'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
    )

  return (
    <header
      className={cn('sticky top-0 z-50 transition-shadow duration-300', scrolled && 'glass-bar shadow-md')}
      onMouseLeave={() => setCatOpen(false)}
    >
      <div className="container-x flex h-[70px] items-center gap-4">
        <Wordmark />

        <nav className="ml-4 hidden items-center gap-1 lg:flex">
          {NAV_ITEMS.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={navLinkClass}>
              {n.label}
            </NavLink>
          ))}

          <button
            type="button"
            onMouseEnter={() => setCatOpen(true)}
            onClick={() => setCatOpen((v) => !v)}
            aria-expanded={catOpen}
            className="flex items-center gap-1.5 rounded-pill px-3.5 py-2 text-sm font-semibold text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
          >
            {t.categoriesLabel}
            <ChevronDown className={cn('size-4 transition-transform', catOpen && 'rotate-180')} />
          </button>
        </nav>

        {/* Search opens the command palette — one search path, not two. */}
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="glass-soft ml-auto hidden max-w-sm flex-1 items-center gap-2.5 rounded-pill px-4 py-2.5 text-left transition-all hover:bg-foreground/[.1] md:flex"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm text-muted-foreground">{t.search}</span>
        </button>

        {/* actions */}
        <div className="ml-auto flex items-center gap-1.5 md:ml-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSearchOpen(true)}
            aria-label={t.searchShortcut}
            className="rounded-pill md:hidden"
          >
            <Search />
          </Button>

          <LanguageSwitcher />

          <Button asChild variant="ghost" size="icon" className="relative rounded-pill">
            <Link to="/saved" aria-label={`${t.savedItems} (${saved.count})`}>
              <Heart />
              {saved.count > 0 && (
                <Badge
                  variant="deal"
                  className="absolute -right-1 -top-1 min-w-[18px] justify-center px-1 py-0 text-2xs"
                >
                  {saved.count}
                </Badge>
              )}
            </Link>
          </Button>

          {/* ------- mobile menu ------- */}
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t.menu} className="rounded-pill lg:hidden">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[300px] overflow-y-auto sm:w-[340px]">
              <SheetHeader>
                <SheetTitle>
                  <Wordmark />
                </SheetTitle>
              </SheetHeader>

              <nav className="mt-8 grid gap-1.5">
                {NAV_ITEMS.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.end}
                    onClick={() => setMenuOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        'rounded-md px-4 py-3 text-sm font-semibold transition',
                        isActive ? 'bg-primary/15 text-primary' : 'glass-soft',
                      )
                    }
                  >
                    {n.label}
                  </NavLink>
                ))}
              </nav>

              <Separator className="my-6" />

              <div className="mb-2 px-1 text-2xs font-bold uppercase tracking-[.18em] text-muted-foreground">
                {t.categoriesLabel}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {categories.map((c) => (
                  <Button
                    key={c.slug}
                    asChild
                    variant="glass"
                    size="xs"
                    onClick={() => setMenuOpen(false)}
                  >
                    <Link to={`/category/${c.slug}`}>{c.name}</Link>
                  </Button>
                ))}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* ------- category rail (desktop) ------- */}
      <div className="hidden border-t border-border/40 lg:block">
        <div className="container-x no-bar flex items-center gap-1 overflow-x-auto py-2">
          {categories.map((c) => (
            <NavLink
              key={c.slug}
              to={`/category/${c.slug}`}
              className={({ isActive }) =>
                cn(
                  'whitespace-nowrap rounded-pill px-3 py-1.5 text-xs font-medium transition-all',
                  isActive
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              {c.name}
            </NavLink>
          ))}
        </div>
      </div>

      {/* ------- mega menu ------- */}
      {catOpen && (
        <div className="absolute inset-x-0 top-full hidden animate-fadeIn px-6 lg:block">
          <div className="glass container-x rounded-b-panel border-t-0 p-6">
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-5">
              {categories.map((c) => (
                <Link
                  key={c.slug}
                  to={`/category/${c.slug}`}
                  onClick={() => setCatOpen(false)}
                  className="group rounded-md p-3 transition-all hover:bg-accent"
                >
                  <div
                    className="mb-2 h-1 w-8 rounded-pill transition-all group-hover:w-14"
                    style={{ background: `rgb(${c.tone})` }}
                  />
                  <div className="text-sm font-semibold">{c.name}</div>
                  <div className="mt-0.5 text-2xs text-muted-foreground">{c.tagline}</div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
