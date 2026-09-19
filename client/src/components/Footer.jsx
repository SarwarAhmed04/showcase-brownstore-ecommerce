import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Mail, MapPin, Phone, Send } from 'lucide-react'
import { useCatalog } from '../lib/catalogStore'
import { useLang } from '../context/LangContext'
import { Wordmark } from './Navbar'

export default function Footer() {
  const { categories } = useCatalog()
  const { t } = useLang()
  const shop = [
    { to: '/shop', label: t.allProducts },
    { to: '/deals', label: t.dailyDeals },
    { to: '/shop?sort=new', label: t.newArrivals },
    { to: '/saved', label: t.savedItems },
  ]
  const company = [
    { to: '/about', label: t.ourStory },
    { to: '/about#showroom', label: t.visitShowroom },
    { to: '/contact', label: t.contactUs },
    { to: '/about#promise', label: t.brownPromise },
  ]

  return (
    <footer className="relative mt-28">
      <div className="divider-glow" />

      <div className="container-x pb-28 pt-16 lg:pb-16">
        <div className="glass mb-14 overflow-hidden rounded-panel p-8 sm:p-12">
          <div className="grid items-center gap-8 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <div className="eyebrow mb-4">{t.dispatchEyebrow}</div>
              <h3 className="headline text-3xl sm:text-4xl">
                {t.dispatchTitle} <span className="gold-text">{t.dispatchTitleGold}</span>
              </h3>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-foreground/75">
                {t.dispatchBody}
              </p>
            </div>

            <form
              onSubmit={(e) => e.preventDefault()}
              className="glass-soft flex items-center gap-2 rounded-full p-1.5 pl-5"
            >
              <input
                type="email"
                required
                placeholder="you@example.com"
                aria-label={t.email}
                className="w-full bg-transparent text-sm outline-none placeholder:text-[rgb(var(--text-mute))]"
              />
              <Button type="submit" variant="brand" className="shrink-0">
                {t.join} <Send />
              </Button>
            </form>
          </div>
        </div>

        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1.2fr]">
          <div>
            <Wordmark />
          </div>

          <FooterCol title={t.footerShop} links={shop} />
          <FooterCol title={t.footerCompany} links={company} />

          <div>
            <h4 className="mb-4 text-2xs font-bold uppercase tracking-[.18em] text-muted-foreground">
              {t.findUs}
            </h4>
            <ul className="space-y-3.5 text-sm text-foreground/75">
              <li className="flex gap-3">
                <MapPin size={16} className="mt-0.5 shrink-0 text-primary" />
                <span>Karrada, Baghdad</span>
              </li>
              <li className="flex gap-3">
                <Phone size={16} className="mt-0.5 shrink-0 text-primary" />
                <span dir="ltr">+964 773 802 9000</span>
              </li>
              <li className="flex gap-3">
                <Mail size={16} className="mt-0.5 shrink-0 text-primary" />
                <span>info@brownstore.com</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-wrap gap-1.5 border-t border-border/50 pt-8">
          {categories.map((c) => (
            <Link
              key={c.slug}
              to={`/category/${c.slug}`}
              className="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-primary"
            >
              {c.name}
            </Link>
          ))}
        </div>

        <div className="mt-8 border-t border-border/50 pt-7 text-xs text-muted-foreground">
          <p>© {new Date().getFullYear()} Brown Store.</p>
        </div>
      </div>
    </footer>
  )
}

function FooterCol({ title, links }) {
  return (
    <div>
      <h4 className="mb-4 text-2xs font-bold uppercase tracking-[.18em] text-muted-foreground">{title}</h4>
      <ul className="space-y-2.5">
        {links.map((l) => (
          <li key={l.to + l.label}>
            <Link to={l.to} className="text-sm text-foreground/75 transition-colors hover:text-primary">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
