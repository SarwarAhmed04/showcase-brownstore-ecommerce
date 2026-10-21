import { NavLink } from 'react-router-dom'
import { Heart, Home, LayoutGrid, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '../store'
import { useLang } from '../context/LangContext'

const itemClass = 'relative flex flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-semibold transition-colors'

export default function MobileNav() {
  const { saved, searchOpen, setSearchOpen } = useStore()
  const { t } = useLang()

  const tabs = [
    { to: '/', label: t.home, Icon: Home, end: true },
    { to: '/shop', label: t.shop, Icon: LayoutGrid },
  ]

  return (
    <nav
      className="fixed inset-x-3 bottom-3 z-40 lg:hidden"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      aria-label={t.primaryNav}
    >
      <div className="mx-auto grid max-w-md grid-cols-4 gap-1 rounded-2xl bg-bean-900 p-1.5 text-bean-50 shadow-[0_20px_40px_-14px_rgb(36_22_17/0.6)]">
        {tabs.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(itemClass, isActive ? 'bg-bean-50/10 text-tan' : 'text-bean-50/65')
            }
          >
            <Icon className="size-[18px]" />
            {label}
          </NavLink>
        ))}

        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label={t.searchShortcut}
          className={cn(itemClass, searchOpen ? 'bg-bean-50/10 text-tan' : 'text-bean-50/65')}
        >
          <Search className="size-[18px]" />
          {t.searchShortcut}
        </button>

        <NavLink
          to="/saved"
          className={({ isActive }) => cn(itemClass, isActive ? 'bg-bean-50/10 text-tan' : 'text-bean-50/65')}
        >
          <span className="relative">
            <Heart className="size-[18px]" />
            {saved.count > 0 && (
              <span className="absolute -end-2.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold leading-none text-primary-foreground">
                {saved.count}
              </span>
            )}
          </span>
          {t.savedItems}
        </NavLink>
      </div>
    </nav>
  )
}
