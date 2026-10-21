import { Link } from 'react-router-dom'
import { imgUrl } from '../lib/img'
import Logo from './Logo'

/** Arch-topped category tile — the storefront's signature shape. */
export default function CategoryTile({ category: c }) {
  return (
    <Link to={`/category/${c.slug}`} className="group block text-center">
      <span className="relative block aspect-[3/4] overflow-hidden rounded-t-full bg-bean-100">
        {c.cover ? (
          <img
            src={imgUrl(c.cover, { w: 600, h: 800 })}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.06]"
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center">
            <Logo className="h-12 w-12 opacity-40" />
          </span>
        )}
        <span className="absolute inset-0 bg-bean-900/0 transition-colors duration-500 group-hover:bg-bean-900/10" />
      </span>
      <span className="mt-4 block font-display text-base font-bold leading-snug text-bean-900 transition-colors group-hover:text-primary sm:text-lg">
        {c.name}
      </span>
    </Link>
  )
}
