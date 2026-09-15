import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, LayoutGrid, Rows3, SlidersHorizontal, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { useCatalog } from '../lib/catalogStore'
import { adaptProduct } from '../lib/catalog'
import { useMedia } from '../lib/hooks'
import { api } from '../api'
import { tName } from '../i18n'
import { useLang } from '../context/LangContext'
import ProductCard from './ProductCard'
import ProductRow from './ProductRow'
import { EmptyState, PageSkeleton, Reveal } from './ui'

const SORT_API = {
  featured: 'featured',
  new: 'newest',
  rating: 'newest',
  discount: 'discount',
}

/**
 * The catalogue surface: filter rail + sorted, filtered grid.
 *
 * Filter state lives in the URL, so a filtered view is shareable, bookmarkable
 * and correct through the back button. One component serves Shop, Category,
 * Deals, Search and Saved. Shop-scale lists fetch from /api/products.
 */
export default function Catalog({
  base,
  query,
  lockCategory = false,
  emptyIcon,
  emptyTitle,
  emptySub,
  emptyAction,
  onMeta,
}) {
  const [params, setParams] = useSearchParams()
  const [sheetOpen, setSheetOpen] = useState(false)
  const isDesktop = useMedia('(min-width: 1024px)')
  const { categories } = useCatalog()
  const { t, lang } = useLang()
  const remote = query != null

  const [remoteItems, setRemoteItems] = useState([])
  const [remoteTotal, setRemoteTotal] = useState(0)
  const [remotePages, setRemotePages] = useState(1)
  const [facets, setFacets] = useState({ brands: [], categories: [] })
  const [loading, setLoading] = useState(Boolean(remote))

  const sort = params.get('sort') ?? 'featured'
  const view = params.get('view') ?? 'grid'
  const page = Math.max(1, Number(params.get('page') || 1))
  const pickedCats = params.getAll('cat')
  const pickedBrands = params.getAll('brand')

  const SORTS = [
    { key: 'featured', label: t.sortFeatured || t.featured },
    { key: 'new', label: t.newest },
    { key: 'discount', label: t.sortDiscount },
  ]

  useEffect(() => {
    if (!remote) return undefined
    let cancelled = false
    setLoading(true)
    const category = lockCategory
      ? query.category
      : pickedCats.length
        ? pickedCats
        : query.category
    api
      .products({
        page,
        limit: 24,
        q: query.q || undefined,
        deals: query.deals ? 1 : undefined,
        ids: query.ids || undefined,
        category,
        brand: pickedBrands,
        sort: SORT_API[sort] || 'newest',
      })
      .then((data) => {
        if (cancelled) return
        const items = (data.products || []).map((row) => adaptProduct(row, lang)).filter(Boolean)
        setRemoteItems(items)
        setRemoteTotal(Number(data.pagination?.total) || items.length)
        setRemotePages(Number(data.pagination?.pages) || 1)
        setFacets({
          brands: data.facets?.brands || [],
          categories: data.facets?.categories || [],
        })
        onMeta?.({
          total: Number(data.pagination?.total) || items.length,
          page: Number(data.pagination?.page) || page,
        })
      })
      .catch(() => {
        if (cancelled) return
        setRemoteItems([])
        setRemoteTotal(0)
        setRemotePages(1)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    remote,
    lang,
    page,
    sort,
    pickedCats.join('|'),
    pickedBrands.join('|'),
    query?.q,
    query?.category,
    query?.deals,
    query?.ids,
    lockCategory,
  ])

  const brandsHere = useMemo(() => {
    if (remote) {
      return facets.brands
        .map((b) => ({ label: tName(b.name, lang) || b.id, value: b.id || tName(b.name, lang), count: b.count }))
        .filter((b) => b.value)
    }
    return [...new Set((base || []).map((p) => p.brand))]
      .filter(Boolean)
      .sort()
      .map((label) => ({
        label,
        value: label,
        count: (base || []).filter((p) => p.brand === label).length,
      }))
  }, [remote, facets.brands, base, lang])

  const catsHere = useMemo(() => {
    if (remote) {
      const countMap = Object.fromEntries(facets.categories.map((c) => [c.id, c.count]))
      return categories
        .filter((c) => countMap[c.slug] > 0 || pickedCats.includes(c.slug))
        .map((c) => ({ ...c, count: countMap[c.slug] || 0 }))
    }
    return categories
      .filter((c) => (base || []).some((p) => p.category === c.slug))
      .map((c) => ({ ...c, count: (base || []).filter((p) => p.category === c.slug).length }))
  }, [remote, facets.categories, categories, base, pickedCats])

  const setParam = (key, value) => {
    const next = new URLSearchParams(params)
    if (value === null || value === '' || value === 0) next.delete(key)
    else next.set(key, String(value))
    if (key !== 'page' && key !== 'view') next.delete('page')
    setParams(next, { replace: true })
  }

  const toggleMulti = (key, value) => {
    const next = new URLSearchParams(params)
    const cur = next.getAll(key)
    next.delete(key)
    const updated = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
    updated.forEach((v) => next.append(key, v))
    next.delete('page')
    setParams(next, { replace: true })
  }

  const clearAll = () => {
    const next = new URLSearchParams()
    const q = params.get('q')
    if (q) next.set('q', q)
    if (sort !== 'featured') next.set('sort', sort)
    setParams(next, { replace: true })
  }

  const activeCount = pickedCats.length + pickedBrands.length

  const shown = useMemo(() => {
    if (remote) return remoteItems
    const list = (base || []).filter((p) => {
      if (pickedCats.length && !pickedCats.includes(p.category)) return false
      if (pickedBrands.length && !pickedBrands.includes(p.brand)) return false
      return true
    })

    const by = {
      new: (a, b) => String(b.id).localeCompare(String(a.id)),
      discount: (a, b) => Number(b.onDeal) - Number(a.onDeal),
      featured: (a, b) => Number(b.featured) - Number(a.featured),
    }
    return [...list].sort(by[sort] ?? by.featured)
  }, [remote, remoteItems, base, pickedCats, pickedBrands, sort])

  const resultCount = remote ? remoteTotal : shown.length

  const filters = (
    <div className="space-y-6">
      {!lockCategory && catsHere.length > 1 && (
        <FilterGroup title={t.category}>
          {catsHere.map((c) => (
            <CheckRow
              key={c.slug}
              id={`cat-${c.slug}`}
              label={c.name}
              count={c.count}
              checked={pickedCats.includes(c.slug)}
              onChange={() => toggleMulti('cat', c.slug)}
            />
          ))}
        </FilterGroup>
      )}

      {brandsHere.length > 1 && (
        <>
          {!lockCategory && catsHere.length > 1 && <Separator />}
          <FilterGroup title={t.productBrand}>
            {brandsHere.map((b) => (
              <CheckRow
                key={b.value}
                id={`brand-${String(b.value).replace(/\s+/g, '-')}`}
                label={b.label}
                count={b.count}
                checked={pickedBrands.includes(b.value) || pickedBrands.includes(b.label)}
                onChange={() => toggleMulti('brand', b.value)}
              />
            ))}
          </FilterGroup>
        </>
      )}

      {activeCount > 0 && (
        <Button type="button" variant="glass" onClick={clearAll} className="w-full">
          {t.clearFilters} <X />
        </Button>
      )}
    </div>
  )

  return (
    <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
      {isDesktop && (
        <aside className="hidden lg:block">
          <div className="glass sticky top-[190px] rounded-card p-6">
            <h2 className="mb-5 flex items-center gap-2 text-sm font-bold">
              <SlidersHorizontal className="size-4 text-primary" /> {t.filters}
            </h2>
            {filters}
          </div>
        </aside>
      )}

      <div>
        <div className="glass mb-6 flex flex-wrap items-center gap-3 rounded-card px-4 py-3">
          {!isDesktop && (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="glass" size="sm">
                  <SlidersHorizontal /> {t.filters}
                  {activeCount > 0 && (
                    <Badge variant="deal" className="ml-1 px-1.5 py-0">
                      {activeCount}
                    </Badge>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[320px] overflow-y-auto sm:w-[380px]">
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    <SlidersHorizontal className="size-4 text-primary" /> {t.filters}
                  </SheetTitle>
                </SheetHeader>
                <div className="mt-6">{filters}</div>
                <Button variant="brand" className="mt-7 w-full" onClick={() => setSheetOpen(false)}>
                  {resultCount} {resultCount === 1 ? t.productOne : t.productsMany}
                </Button>
              </SheetContent>
            </Sheet>
          )}

          <span className="text-xs text-muted-foreground">
            <strong className="font-bold text-foreground">{resultCount}</strong>{' '}
            {resultCount === 1 ? t.productOne : t.productsMany}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <Select value={sort} onValueChange={(v) => setParam('sort', v === 'featured' ? null : v)}>
              <SelectTrigger className="h-9 w-auto gap-2 rounded-pill border-border/70 bg-foreground/[.06] text-xs font-semibold">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => (
                  <SelectItem key={s.key} value={s.key} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="hidden items-center gap-1 sm:flex">
              {[
                { key: 'grid', Icon: LayoutGrid },
                { key: 'list', Icon: Rows3 },
              ].map(({ key, Icon }) => (
                <Button
                  key={key}
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setParam('view', key === 'grid' ? null : key)}
                  aria-label={`${key} view`}
                  aria-pressed={view === key}
                  className={cn(
                    'rounded-pill',
                    view === key ? 'bg-primary/15 text-primary' : 'text-muted-foreground',
                  )}
                >
                  <Icon />
                </Button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <PageSkeleton />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle ?? t.nothingMatches}
            sub={emptySub ?? t.widenFilters}
            action={
              emptyAction ??
              (activeCount > 0 && (
                <Button variant="brand" onClick={clearAll}>
                  {t.clearFilters}
                </Button>
              ))
            }
          />
        ) : view === 'list' ? (
          <div className="space-y-3.5">
            {shown.map((p, i) => (
              <Reveal key={p.id} delay={Math.min(i, 6) * 50}>
                <ProductRow product={p} />
              </Reveal>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3.5 sm:gap-5 xl:grid-cols-3 2xl:grid-cols-4">
            {shown.map((p, i) => (
              <Reveal key={p.id} delay={Math.min(i, 8) * 45}>
                <ProductCard product={p} />
              </Reveal>
            ))}
          </div>
        )}

        {remote && remotePages > 1 && !loading && (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              variant="glass"
              size="sm"
              disabled={page <= 1}
              onClick={() => setParam('page', page - 1)}
            >
              <ChevronLeft /> {t.scrollPrev}
            </Button>
            <span className="px-3 text-xs text-muted-foreground" dir="ltr">
              {t.page} {page} {t.of} {remotePages}
            </span>
            <Button
              type="button"
              variant="glass"
              size="sm"
              disabled={page >= remotePages}
              onClick={() => setParam('page', page + 1)}
            >
              {t.scrollNext} <ChevronRight />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function FilterGroup({ title, children }) {
  return (
    <div>
      <h3 className="mb-3 text-2xs font-bold uppercase tracking-[.18em] text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function CheckRow({ id, label, count, checked, onChange }) {
  return (
    <div className="flex items-center gap-2.5">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <Label
        htmlFor={id}
        className="flex flex-1 cursor-pointer items-center gap-2 text-xs font-normal"
      >
        <span className="flex-1">{label}</span>
        <span className="text-2xs text-muted-foreground">{count}</span>
      </Label>
    </div>
  )
}
