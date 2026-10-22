import { Link } from 'react-router-dom'
import { Mail, MapPin, Phone } from 'lucide-react'
import { useCatalog } from '../lib/catalogStore'
import { useLang } from '../context/LangContext'
import { EMAIL, LangSwitch, PHONE, Wordmark } from './Navbar'

export default function Footer() {
  const { categories } = useCatalog()
  const { t } = useLang()

  const shop = [
    { to: '/shop', label: t.allProducts },
    { to: '/shop?sort=new', label: t.newArrivals },
    { to: '/saved', label: t.savedItems },
    { to: '/contact', label: t.contactUs },
  ]

  return (
    <footer className="mt-24 overflow-hidden bg-bean-900 text-bean-50 lg:mt-32">
      <div className="container-x pb-28 pt-16 lg:pb-10 lg:pt-20">
        <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-[1.35fr_1fr_1.2fr_1.15fr]">
          <div className="max-w-sm">
            <Wordmark light />
          </div>

          <div>
            <FooterTitle>{t.footerShop}</FooterTitle>
            <ul className="space-y-3">
              {shop.map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className="sf-link text-sm text-bean-50/75 hover:text-bean-50">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <FooterTitle>{t.departments}</FooterTitle>
            <ul className="space-y-3">
              {categories.slice(0, 9).map((c) => (
                <li key={c.slug}>
                  <Link to={`/category/${c.slug}`} className="sf-link text-sm text-bean-50/75 hover:text-bean-50">
                    {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <FooterTitle>{t.findUs}</FooterTitle>
            <ul className="space-y-4 text-sm text-bean-50/75">
              <li className="flex gap-3">
                <MapPin className="mt-0.5 size-4 shrink-0 text-tan" />
                <span>{t.addressKarrada}</span>
              </li>
              <li className="flex gap-3">
                <Phone className="mt-0.5 size-4 shrink-0 text-tan" />
                <a href={`tel:${PHONE.replace(/\s+/g, '')}`} dir="ltr" className="sf-link hover:text-bean-50">
                  {PHONE}
                </a>
              </li>
              <li className="flex gap-3">
                <Mail className="mt-0.5 size-4 shrink-0 text-tan" />
                <a href={`mailto:${EMAIL}`} className="sf-link hover:text-bean-50">
                  {EMAIL}
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-bean-50/10 pt-6 text-xs text-bean-50/50">
          <p>
            © {new Date().getFullYear()} Brown Store. {t.footerRights}
          </p>
          <LangSwitch light />
        </div>

        <div
          aria-hidden
          dir="ltr"
          className="pointer-events-none mt-8 select-none whitespace-nowrap text-center font-display text-[19vw] font-extrabold leading-[0.78] tracking-[-0.06em] text-bean-50/[0.06] lg:text-[248px]"
        >
          brownstore
        </div>
      </div>
    </footer>
  )
}

function FooterTitle({ children }) {
  return <h2 className="mb-5 text-xs font-semibold text-tan ltr:uppercase ltr:tracking-[.16em]">{children}</h2>
}
