import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { imgUrl } from '../lib/img'
import { useLang } from '../context/LangContext'

export default function CategoryTile({ category: c, large = false }) {
  const { t } = useLang()

  return (
    <Link
      to={`/category/${c.slug}`}
      className={`group relative flex h-full overflow-hidden rounded-card bg-muted shadow-sm ring-1 ring-foreground/10 transition duration-500 hover:-translate-y-1 ${
        large ? 'min-h-[300px] sm:min-h-[420px]' : 'aspect-[3/1] min-h-[96px]'
      }`}
    >
      {c.cover ? (
        <img
          src={imgUrl(c.cover, { w: large ? 1200 : 700, h: large ? 900 : 520 })}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-105"
        />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/10" />
      <div className={`relative mt-auto ${large ? 'p-6 sm:p-8' : 'p-3 sm:p-3.5'}`}>
        <h3 className={`font-display font-bold leading-tight text-white ${large ? 'text-3xl' : 'text-sm'}`}>
          {c.name}
        </h3>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-white/80 transition-colors group-hover:text-white">
          {t.shop}
          <ArrowRight size={14} className="transition-transform group-hover:translate-x-1" />
        </div>
      </div>
    </Link>
  )
}
