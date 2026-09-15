import { NavLink } from 'react-router-dom'
import { Flame, Heart, Home, LayoutGrid, Search } from 'lucide-react'
import { useStore } from '../store'

// Mirrors the reference site's bottom tab bar — the pattern shoppers on phones
// already expect. Hidden from lg upward, where the header carries everything.
const TABS = [
  { to: '/', label: 'Home', Icon: Home, end: true },
  { to: '/shop', label: 'Shop', Icon: LayoutGrid },
  { to: '/deals', label: 'Deals', Icon: Flame },
  { to: '/saved', label: 'Saved', Icon: Heart, badge: true },
]

export default function MobileNav() {
  const { saved, setSearchOpen } = useStore()

  return (
    <nav
      className="glass-bar fixed inset-x-0 bottom-0 z-40 lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Primary"
    >
      <div className="grid grid-cols-5">
        {TABS.slice(0, 2).map((t) => (
          <Tab key={t.to} {...t} count={saved.count} />
        ))}

        {/* centre search key */}
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="Search"
          className="flex flex-col items-center justify-center py-2"
        >
          <span
            className="grid h-11 w-11 -translate-y-3 place-items-center rounded-2xl text-primary-foreground shadow-xl"
            style={{ background: 'linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-2)))' }}
          >
            <Search size={20} strokeWidth={2.4} />
          </span>
          <span className="-mt-2 text-2xs font-semibold text-muted-foreground">Search</span>
        </button>

        {TABS.slice(2).map((t) => (
          <Tab key={t.to} {...t} count={saved.count} />
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
