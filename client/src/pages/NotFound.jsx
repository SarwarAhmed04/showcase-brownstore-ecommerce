import { lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Home, Search } from 'lucide-react'
import { useCatalog } from '../lib/catalogStore'
import { useMedia } from '../lib/hooks'
import { useStore } from '../store'

// Only reachable on a 404 — keep it out of every other page's bundle.
const PixelSwap = lazy(() => import('../components/PixelSwap'))

export default function NotFound() {
  const { setSearchOpen } = useStore()
  const { categories } = useCatalog()
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)')

  const numeral = (
    <span className="headline gold-text text-5xl leading-none sm:text-6xl">404</span>
  )

  return (
    <div className="container-x flex min-h-[70vh] flex-col items-center justify-center py-20 text-center">
      <div className="glass w-full max-w-2xl rounded-panel p-10 sm:p-16">
        {/* The one place a novelty earns its keep: nothing is at stake on a
            404, so the numeral dissolves into a shrug when you hover it. */}
        <div className="mx-auto grid h-28 max-w-sm place-items-center sm:h-32">
          {reducedMotion ? (
            numeral
          ) : (
            <Suspense fallback={numeral}>
            <PixelSwap
              firstContent={<div className="grid h-full w-full place-items-center">{numeral}</div>}
              secondContent={
                <div className="grid h-full w-full place-items-center">
                  <span className="font-display text-xl font-bold text-muted-foreground sm:text-2xl">
                    Nothing on this shelf
                  </span>
                </div>
              }
              pixelSize={28}
              gap={2}
              pixelRadius={4}
              pixelScale={0.4}
              duration={900}
              pixelDuration={380}
              pattern="random"
              fade
              trigger="hover"
              aspectRatio="auto"
              className="h-full w-full"
            />
            </Suspense>
          )}
        </div>

        <h1 className="headline mt-4 text-3xl sm:text-4xl">This shelf is empty</h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-foreground/75">
          The page you were after has moved, or never existed. The catalogue is still where you
          left it.
        </p>

        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <Button asChild variant="brand" size="lg">
            <Link to="/">
              <Home /> Back to home
            </Link>
          </Button>
          <Button type="button" variant="glass" size="lg" onClick={() => setSearchOpen(true)}>
            <Search /> Search the catalogue
          </Button>
          <Button type="button" variant="glass" size="lg" onClick={() => window.history.back()}>
            <ArrowLeft /> Go back
          </Button>
        </div>

        <div className="mt-11 border-t border-border/60 pt-8">
          <div className="mb-3.5 text-2xs font-bold uppercase tracking-[.18em] text-muted-foreground">
            Or jump to a department
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {categories.map((c) => (
              <Link
                key={c.slug}
                to={`/category/${c.slug}`}
                className="glass-soft rounded-full px-3 py-1.5 text-xs font-medium transition hover:text-primary"
              >
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
