import { NavLink } from 'react-router-dom'
import { Flame, Heart, Home, LayoutGrid, Search } from 'lucide-react'
import { useStore } from '../store'
import { useLang } from '../context/LangContext'

export default function MobileNav() {
  const { saved, setSearchOpen } = useStore()
  const { t } = useLang()

  const tabs = [
    { to: '/', label: t.home, Icon: Home, end: true },
    { to: '/shop', label: t.shop, Icon: LayoutGrid },
    { to: '/deals', label: t.deals, Icon: Flame },
    { to: '/saved', label: t.savedItems, Icon: Heart, badge: true },
  ]

  return (
    <nav
      className="glass-bar fixed inset-x-0 bottom-0 z-40 lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label={t.primaryNav}
    >
      <div className="grid grid-cols-5">
        {tabs.slice(0, 2).map((item) => (
          <Tab key={item.to} {...item} count={saved.count} />
        ))}

        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label={t.searchShortcut}
          className="flex flex-col items-center justify-center py-2"
        >
          <span
            className="grid h-11 w-11 -translate-y-3 place-items-center rounded-2xl text-primary-foreground shadow-xl"
            style={{ background: 'linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-2)))' }}
          >
            <Search size={20} strokeWidth={2.4} />
          </span>
          <span className="-mt-2 text-2xs font-semibold text-muted-foreground">{t.searchShortcut}</span>
        </button>

        {tabs.slice(2).map((item) => (
          <Tab key={item.to} {...item} count={saved.count} />
        ))}
      </div>
    </nav>
  )
}

function Tab({ to, label, Icon, end, badge, count }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex flex-col items-center gap-1 py-3 text-2xs font-semibold transition-colors ${
          isActive ? 'text-primary' : 'text-muted-foreground'
        }`
      }
    >
      <span className="relative">
        <Icon size={19} />
        {badge && count > 0 && (
          <span className="absolute -right-2 -top-1.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-primary px-1 text-2xs font-black text-primary-foreground">
            {count}
          </span>
        )}
      </span>
      {label}
    </NavLink>
  )
}
