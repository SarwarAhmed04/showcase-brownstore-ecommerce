import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, LayoutGrid, Rows3, SlidersHorizontal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import { EmptyState, GridSkeleton, Reveal } from './ui'

const SORT_API = {
  featured: 'featured',
  new: 'newest',
  rating: 'newest',
  discount: 'discount',
}

/**
 * Filter rail + sorted grid. Filter state lives in the URL so a view is
 * shareable. One component serves Shop, Category, Search and Saved.
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
  const { t, lang, dir } = useLang()
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

  const chips = [
    ...pickedCats.map((slug) => ({
      key: `cat-${slug}`,
      label: catsHere.find((c) => c.slug === slug)?.name || slug,
      onRemove: () => toggleMulti('cat', slug),
    })),
    ...pickedBrands.map((brand) => ({
      key: `brand-${brand}`,
      label: brandsHere.find((b) => b.value === brand || b.label === brand)?.label || brand,
      onRemove: () => toggleMulti('brand', brand),
    })),
  ]

  const filters = (
    <div className="space-y-8">
      {!lockCategory && catsHere.length > 1 && (
        <FilterGroup title={t.category}>
          {catsHere.map((c) => (
            <CheckRow
              key={c.slug}
              id={`cat-${c.slug}`}
              label={c.name}
              checked={pickedCats.includes(c.slug)}
              onChange={() => toggleMulti('cat', c.slug)}
            />
          ))}
        </FilterGroup>
      )}

      {brandsHere.length > 1 && (
        <FilterGroup title={t.productBrand}>
          {brandsHere.map((b) => (
            <CheckRow
              key={b.value}
              id={`brand-${String(b.value).replace(/\s+/g, '-')}`}
              label={b.label}
              checked={pickedBrands.includes(b.value) || pickedBrands.includes(b.label)}
              onChange={() => toggleMulti('brand', b.value)}
            />
          ))}
        </FilterGroup>
      )}

      {activeCount > 0 && (
        <button
          type="button"
          onClick={clearAll}
          className="sf-link text-sm font-semibold text-primary"
        >
          {t.clearFilters}
        </button>
      )}
    </div>
  )

  return (
    <div className="grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start">
      {isDesktop && (
        <aside className="hidden lg:sticky lg:top-[8.5rem] lg:block">
          <h2 className="sf-eyebrow mb-6">{t.filters}</h2>
          {filters}
        </aside>
      )}

      <div className="min-w-0">
        <div className="mb-6 flex flex-wrap items-center gap-3 border-b border-bean-900/10 pb-4">
          {!isDesktop && (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="line" size="sm">
                  <SlidersHorizontal /> {t.filters}
                  {activeCount > 0 && (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-bean-900 px-1.5 text-[10px] font-bold text-bean-50">
                      {activeCount}
                    </span>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent
                side={dir === 'rtl' ? 'right' : 'left'}
                className="w-[320px] overflow-y-auto border-0 bg-background sm:w-[360px]"
              >
                <SheetHeader>
                  <SheetTitle className="sf-eyebrow text-start">{t.filters}</SheetTitle>
                </SheetHeader>
                <div className="mt-8">{filters}</div>
                <Button variant="ink" className="mt-8 w-full" onClick={() => setSheetOpen(false)}>
                  {t.seeResults}
                </Button>
              </SheetContent>
            </Sheet>
          )}

          <div className="ms-auto flex items-center gap-2">
            <Select value={sort} onValueChange={(v) => setParam('sort', v === 'featured' ? null : v)}>
              <SelectTrigger className="h-9 w-auto min-w-[8.5rem] gap-2 rounded-md border-bean-900/20 bg-transparent text-xs font-semibold">
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

            <div className="hidden items-center border border-bean-900/20 sm:flex">
              {[
                { key: 'grid', Icon: LayoutGrid, label: t.gridView },
                { key: 'list', Icon: Rows3, label: t.listView },
              ].map(({ key, Icon, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setParam('view', key === 'grid' ? null : key)}
                  aria-label={label}
                  aria-pressed={view === key}
                  className={cn(
                    'grid size-9 place-items-center transition-colors',
                    view === key ? 'bg-bean-900 text-bean-50' : 'text-bean-900/50 hover:text-bean-900',
                  )}
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {chips.length > 0 && (
          <div className="mb-6 flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onRemove}
                className="inline-flex items-center gap-1.5 rounded-full border border-bean-900/15 bg-card py-1 pe-2 ps-3 text-xs font-semibold text-bean-900 transition-colors hover:border-bean-900"
              >
                {chip.label}
                <X className="size-3.5 opacity-50" />
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <GridSkeleton count={12} />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle ?? t.nothingMatches}
            sub={emptySub ?? t.widenFilters}
            action={
              emptyAction ??
              (activeCount > 0 && (
                <Button variant="ink" onClick={clearAll}>
                  {t.clearFilters}
                </Button>
              ))
            }
          />
        ) : view === 'list' ? (
          <div className="space-y-5">
            {shown.map((p, i) => (
              <Reveal key={p.id} delay={Math.min(i, 6) * 40}>
                <ProductRow product={p} />
              </Reveal>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-4 lg:grid-cols-3 xl:grid-cols-4">
            {shown.map((p, i) => (
              <Reveal key={p.id} delay={Math.min(i, 8) * 40}>
                <ProductCard product={p} />
              </Reveal>
            ))}
          </div>
        )}

        {remote && remotePages > 1 && !loading && (
          <nav className="mt-12 flex flex-wrap items-center justify-center gap-2" aria-label={t.page}>
            <Button
              type="button"
              variant="line"
              size="sm"
              disabled={page <= 1}
              onClick={() => setParam('page', page - 1)}
            >
              <ChevronRight className="ltr:rotate-180" /> {t.scrollPrev}
            </Button>
            <span className="px-3 text-sm tabular-nums text-muted-foreground">
              {page} {t.of} {remotePages}
            </span>
            <Button
              type="button"
              variant="line"
              size="sm"
              disabled={page >= remotePages}
              onClick={() => setParam('page', page + 1)}
            >
              {t.scrollNext} <ChevronLeft className="ltr:rotate-180" />
            </Button>
          </nav>
        )}
      </div>
    </div>
  )
}

function FilterGroup({ title, children }) {
  return (
    <div>
      <h3 className="mb-3 text-xs font-semibold text-bean-900 ltr:uppercase ltr:tracking-[.14em]">{title}</h3>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function CheckRow({ id, label, checked, onChange }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} className="rounded-[3px] shadow-none" />
      <Label htmlFor={id} className="flex flex-1 cursor-pointer items-center gap-2 text-sm font-normal text-bean-900">
        <span className="flex-1 leading-snug">{label}</span>
      </Label>
    </div>
  )
}
