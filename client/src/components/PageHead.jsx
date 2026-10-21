import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useLang } from '../context/LangContext'

/** Slash-separated trail; slashes need no mirroring in RTL. */
export function Breadcrumbs({ crumbs = [], className }) {
  const { t } = useLang()
  return (
    <nav aria-label="Breadcrumb" className={cn('flex flex-wrap items-center gap-2 text-xs text-muted-foreground', className)}>
      <Link to="/" className="sf-link hover:text-primary">
        {t.home}
      </Link>
      {crumbs.map((c, i) => (
        <Fragment key={`${c.label}-${i}`}>
          <span aria-hidden className="opacity-40">/</span>
          {c.to && i < crumbs.length - 1 ? (
            <Link to={c.to} className="sf-link hover:text-primary">
              {c.label}
            </Link>
          ) : (
            <span aria-current="page" className="clamp-1 max-w-[50vw] font-semibold opacity-90">
              {c.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  )
}

/**
 * Masthead for interior pages: breadcrumb, then a large title on the start
 * side with the supporting line (and any actions) set against the end.
 */
export default function PageHead({ eyebrow, title, sub, crumbs = [], children, className }) {
  return (
    <header className={cn('mb-10 border-b border-bean-900/15 pb-8 lg:mb-12 lg:pb-10', className)}>
      <Breadcrumbs crumbs={crumbs} />
      <div className="mt-8 grid items-end gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-12">
        <div>
          {eyebrow && <div className="sf-eyebrow mb-4">{eyebrow}</div>}
          <h1 className="sf-display text-3xl text-bean-900 sm:text-4xl lg:text-5xl">{title}</h1>
        </div>
        {(sub || children) && (
          <div className="flex flex-col items-start gap-5 lg:items-end lg:text-end">
            {sub && <p className="max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">{sub}</p>}
            {children}
          </div>
        )}
      </div>
    </header>
  )
}
