import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { CategoryIcon } from '../lib/icons'
import { imgUrl } from '../lib/img'
import { useLang } from '../context/LangContext'

export default function CategoryTile({ category: c, large = false }) {
  const count = Number(c.count) || 0
  const { t } = useLang()

  return (
    <Link
      to={`/category/${c.slug}`}
      className={`group glass relative flex overflow-hidden rounded-card transition-all duration-500 hover:-translate-y-1.5 ${
        large ? 'min-h-[280px] flex-col justify-end p-7' : 'min-h-[150px] flex-col justify-end p-5'
      }`}
    >
      {/* photo */}
      <img
        src={imgUrl(c.cover, { w: large ? 800 : 500, h: large ? 700 : 400 })}
        alt=""
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover opacity-30 transition-all duration-700 group-hover:scale-110 group-hover:opacity-45"
      />
      {/* tone wash keyed to the category */}
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{
          background: `linear-gradient(to top, rgb(var(--bg)) 8%, rgb(var(--bg) / .78) 45%, rgb(${c.tone} / .18) 100%)`,
        }}
      />

      <div className="relative">
        <span
          className={`mb-3 grid place-items-center rounded-xl transition-transform duration-500 group-hover:-translate-y-1 ${
            large ? 'h-12 w-12' : 'h-10 w-10'
          }`}
          style={{ background: `rgb(${c.tone} / .18)`, color: `rgb(${c.tone})` }}
        >
          <CategoryIcon name={c.icon} size={large ? 22 : 18} />
        </span>

        <h3 className={`font-display font-bold leading-tight ${large ? 'text-2xl' : 'text-base'}`}>
          {c.name}
        </h3>

        {large && <p className="mt-1.5 text-sm text-foreground/75">{c.tagline}</p>}

        <div className="mt-2 flex items-center gap-1.5 text-2xs font-semibold text-muted-foreground transition-colors group-hover:text-primary">
          {count} {count === 1 ? t.itemOne : t.itemsMany}
          <ArrowRight size={12} className="transition-transform group-hover:translate-x-1" />
        </div>
      </div>
    </Link>
  )
}
