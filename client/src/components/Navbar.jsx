import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { ArrowUpRight, ChevronDown, Heart, Mail, Menu, Phone, Search } from 'lucide-react'
import Logo from './Logo'
import { useLang } from '../context/LangContext'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { useCatalog } from '../lib/catalogStore'
import { useScrolled } from '../lib/hooks'
import { imgUrl } from '../lib/img'
import { useStore } from '../store'

export const PHONE = '+964 7738029000'
export const EMAIL = 'info@brownstore.net'

const LANGS = [
  { id: 'ku', label: 'کوردی' },
  { id: 'ar', label: 'عربي' },
  { id: 'en', label: 'EN' },
]

export function Wordmark({ light = false, className }) {
  const { t } = useLang()
  return (
    <Link
      to="/"
      aria-label={t.brand}
      className={cn('group inline-flex min-w-0 shrink items-center gap-1.5 sm:gap-2.5', className)}
    >
      <Logo className="h-7 w-7 shrink-0 transition-transform duration-500 group-hover:-rotate-6 sm:h-9 sm:w-9" />
      <span
        dir="ltr"
        className={cn(
          'truncate font-display text-[1.15rem] font-extrabold leading-none tracking-[-0.045em] sm:text-[1.4rem]',
          light ? 'text-bean-50' : 'text-bean-900',
        )}
      >
        brown<span className="text-primary">store</span>
      </span>
    </Link>
  )
}

export function LangSwitch({ light = false, className }) {
  const { lang, setLang } = useLang()
  return (
    <div className={cn('flex items-center', className)} role="group" aria-label="Language">
      {LANGS.map((item, i) => (
        <span key={item.id} className="flex items-center">
          {i > 0 && (
            <span aria-hidden className={cn('mx-2 h-3 w-px', light ? 'bg-bean-50/20' : 'bg-bean-900/15')} />
          )}
          <button
            type="button"
            onClick={() => setLang(item.id)}
            aria-pressed={lang === item.id}
            className={cn(
              'text-xs font-semibold transition-colors',
              lang === item.id
                ? light
                  ? 'text-tan'
                  : 'text-primary'
                : light
                  ? 'text-bean-50/55 hover:text-bean-50'
                  : 'text-bean-900/50 hover:text-bean-900',
            )}
          >
            {item.label}
          </button>
        </span>
      ))}
    </div>
  )
}

function MegaMenu({ categories, onClose }) {
  const { t } = useLang()
  return (
    <div
      id="sf-mega"
      className="absolute inset-x-0 top-full hidden animate-dropIn rounded-b-xl border-t border-bean-900/10 bg-[rgb(var(--bg))] shadow-[0_40px_60px_-40px_rgb(36_22_17/0.45)] lg:block"
    >
      <div className="grid grid-cols-[1fr_300px] gap-10 px-5 py-8">
        <ul className="grid grid-cols-3 gap-x-6 gap-y-1 xl:grid-cols-4">
          {categories.map((c) => (
            <li key={c.slug}>
              <Link
                to={`/category/${c.slug}`}
                onClick={onClose}
                className="group flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-accent"
              >
                <span className="size-12 shrink-0 overflow-hidden rounded-md border border-bean-900/10 bg-bean-100">
                  {c.cover ? (
                    <img
                      src={imgUrl(c.cover, { w: 120, h: 120 })}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
                    />
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-bean-900 transition-colors group-hover:text-primary">
                    {c.name}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <Link
          to="/shop"
          onClick={onClose}
          className="group relative flex flex-col justify-between overflow-hidden rounded-lg bg-bean-900 p-6 text-bean-50"
        >
          <span
            aria-hidden
            className="absolute -bottom-16 -end-10 h-48 w-36 rounded-t-full border border-tan/25 transition-transform duration-700 group-hover:-translate-y-3"
          />
          <span>
            <span className="sf-eyebrow text-tan">{t.shopEyebrow}</span>
            <span className="sf-display mt-3 block text-2xl">{t.shopTitle}</span>
            <span className="mt-2 block text-sm text-bean-50/65">{t.shopSub}</span>
          </span>
          <span className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-tan">
            {t.allProducts}
            <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 ltr:group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" />
          </span>
        </Link>
      </div>
    </div>
  )
}

function MobileMenu({ open, onOpenChange }) {
  const { categories } = useCatalog()
  const { saved } = useStore()
  const { t, dir } = useLang()

  const links = [
    { to: '/', label: t.home, end: true },
    { to: '/shop', label: t.shop },
    { to: '/saved', label: t.savedItems, count: saved.count },
    { to: '/contact', label: t.contact },
  ]

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={t.menu}
          className="grid size-9 place-items-center rounded-md text-bean-900 transition-colors hover:bg-accent sm:size-10 lg:hidden"
        >
          <Menu className="size-5" />
        </button>
      </SheetTrigger>
      <SheetContent
        side={dir === 'rtl' ? 'right' : 'left'}
        aria-describedby={undefined}
        className="flex w-[88vw] max-w-sm flex-col gap-0 overflow-y-auto border-0 bg-background p-0"
      >
        <SheetTitle className="sr-only">{t.menu}</SheetTitle>
        <div className="flex h-16 shrink-0 items-center border-b px-5 pr-14">
          <Wordmark />
        </div>

        <nav className="px-5 py-4" aria-label={t.primaryNav}>
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              onClick={() => onOpenChange(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center justify-between border-b border-bean-900/10 py-3.5 font-display text-xl font-bold',
                  isActive ? 'text-primary' : 'text-bean-900',
                )
              }
            >
              {l.label}
              {l.count > 0 ? (
                <span className="grid h-6 min-w-6 place-items-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground">
                  {l.count}
                </span>
              ) : (
                <ArrowUpRight className="size-4 opacity-40 rtl:-scale-x-100" />
              )}
            </NavLink>
          ))}
        </nav>

        <div className="px-5 pb-4">
          <div className="sf-eyebrow mb-3">{t.categoriesLabel}</div>
          <ul className="grid grid-cols-2 gap-2">
            {categories.map((c) => (
              <li key={c.slug}>
                <Link
                  to={`/category/${c.slug}`}
                  onClick={() => onOpenChange(false)}
                  className="flex items-center gap-2.5 rounded-md bg-card p-2 text-xs font-semibold text-bean-900 ring-1 ring-bean-900/10"
                >
                  <span className="size-9 shrink-0 overflow-hidden rounded-md border border-bean-900/10 bg-bean-100">
                    {c.cover ? (
                      <img src={imgUrl(c.cover, { w: 80, h: 80 })} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : null}
                  </span>
                  <span className="clamp-2 leading-snug">{c.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto space-y-3 bg-bean-900 px-5 py-5 text-sm text-bean-50/75">
          <LangSwitch light />
          <a href={`tel:${PHONE.replace(/\s+/g, '')}`} className="flex items-center gap-2.5">
            <Phone className="size-4 text-tan" /> <span dir="ltr">{PHONE}</span>
          </a>
          <a href={`mailto:${EMAIL}`} className="flex items-center gap-2.5">
            <Mail className="size-4 text-tan" /> {EMAIL}
          </a>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default function Navbar() {
  const scrolled = useScrolled(40)
  const [menuOpen, setMenuOpen] = useState(false)
  const [megaOpen, setMegaOpen] = useState(false)
  const { saved, setSearchOpen } = useStore()
  const { categories } = useCatalog()
  const { t } = useLang()
  const { pathname, search } = useLocation()

  useEffect(() => {
    setMegaOpen(false)
    setMenuOpen(false)
  }, [pathname, search])

  useEffect(() => {
    if (!megaOpen) return undefined
    const onKey = (e) => e.key === 'Escape' && setMegaOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [megaOpen])

  const navClass = 'sf-link py-1 text-sm font-semibold text-bean-900/65 hover:text-bean-900 aria-[current=page]:text-bean-900'

  return (
    <>
      <header
        className="pointer-events-none fixed inset-x-0 top-5 z-50"
        onMouseLeave={() => setMegaOpen(false)}
      >
        <div className="pointer-events-auto relative isolate mx-auto w-full max-w-[1400px] px-3 sm:px-5 lg:px-10">
          <div
            className={cn(
              'rounded-xl border border-bean-900/10 bg-[rgb(var(--bg))]/90 backdrop-blur-md transition-shadow duration-300',
              scrolled && 'shadow-[0_18px_40px_-28px_rgb(36_22_17/0.55)]',
            )}
          >
        <div className="grid h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 sm:h-16 sm:gap-3 sm:px-4 lg:h-[76px] lg:grid-cols-[1fr_auto_1fr] lg:px-5">
          <div className="flex items-center gap-7">
            <MobileMenu open={menuOpen} onOpenChange={setMenuOpen} />
            <nav className="hidden items-center gap-7 lg:flex" aria-label={t.primaryNav}>
              <NavLink to="/" end className={navClass}>
                {t.home}
              </NavLink>
              <NavLink to="/shop" className={navClass}>
                {t.shop}
              </NavLink>
              <button
                type="button"
                onMouseEnter={() => setMegaOpen(true)}
                onClick={() => setMegaOpen((v) => !v)}
                aria-expanded={megaOpen}
                aria-controls="sf-mega"
                className={cn(
                  'flex items-center gap-1 py-1 text-sm font-semibold transition-colors',
                  megaOpen ? 'text-primary' : 'text-bean-900/65 hover:text-bean-900',
                )}
              >
                {t.categoriesLabel}
                <ChevronDown className={cn('size-4 transition-transform duration-300', megaOpen && 'rotate-180')} />
              </button>
              <NavLink to="/contact" className={navClass}>
                {t.contact}
              </NavLink>
            </nav>
          </div>

          <Wordmark className="justify-self-center" />

          <div className="flex items-center justify-end gap-0.5 sm:gap-1.5">
            <LangSwitch className="me-2 hidden lg:flex" />
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="hidden h-10 w-full max-w-[220px] items-center gap-2.5 rounded-md border border-input bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-bean-900/40 lg:flex"
            >
              <Search className="size-4 shrink-0" />
              <span className="flex-1 truncate text-start">{t.search}</span>
            </button>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label={t.searchShortcut}
              className="grid size-9 place-items-center rounded-md text-bean-900 transition-colors hover:bg-accent sm:size-10 lg:hidden"
            >
              <Search className="size-5" />
            </button>
            <Link
              to="/saved"
              aria-label={`${t.savedItems} (${saved.count})`}
              className="relative grid size-9 place-items-center rounded-md text-bean-900 transition-colors hover:bg-accent sm:size-10"
            >
              <Heart className="size-5" />
              {saved.count > 0 && (
                <span className="absolute end-0.5 top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground">
                  {saved.count}
                </span>
              )}
            </Link>
          </div>
        </div>

        {megaOpen && <MegaMenu categories={categories} onClose={() => setMegaOpen(false)} />}
          </div>
        </div>
      </header>
    </>
  )
}
