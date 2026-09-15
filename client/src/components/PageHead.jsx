import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Home } from 'lucide-react'

/**
 * Breadcrumb + title block shared by every interior page.
 *
 * Sizes come from the type scale: page titles are `3xl` stepping to `4xl`,
 * which leaves `5xl` reserved for the hero. Before the scale existed these
 * were hand-tuned per page and competed with it.
 */
export default function PageHead({ eyebrow, title, sub, crumbs = [], children }) {
  return (
    <header className="mb-9">
      <nav
        aria-label="Breadcrumb"
        className="mb-6 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Link to="/" className="flex items-center gap-1.5 transition-colors hover:text-primary">
          <Home className="size-3.5" /> Home
        </Link>
        {crumbs.map((c, i) => (
          <Fragment key={c.label}>
            <ChevronRight className="size-3.5 opacity-50" />
            {c.to && i < crumbs.length - 1 ? (
              <Link to={c.to} className="transition-colors hover:text-primary">
                {c.label}
              </Link>
            ) : (
              <span className="font-semibold text-foreground/80">{c.label}</span>
            )}
          </Fragment>
        ))}
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          {eyebrow && <div className="eyebrow mb-4">{eyebrow}</div>}
          <h1 className="headline text-3xl sm:text-4xl">{title}</h1>
          {sub && <p className="mt-4 text-base leading-relaxed text-muted-foreground">{sub}</p>}
        </div>
        {children}
      </div>
    </header>
  )
}
