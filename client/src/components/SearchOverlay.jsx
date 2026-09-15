import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Search, TrendingUp } from 'lucide-react'
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { useCatalog } from '../lib/catalogStore'
import { adaptProduct } from '../lib/catalog'
import { imgUrl } from '../lib/img'
import { useStore } from '../store'
import { api } from '../api'
import { useLang } from '../context/LangContext'

export default function SearchOverlay() {
  const { searchOpen, setSearchOpen } = useStore()
  const { categories, live: products } = useCatalog()
  const { t, lang } = useLang()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState([])
  const navigate = useNavigate()
  const trending = Array.isArray(t.trendingTerms) ? t.trendingTerms : []

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSearchOpen])

  useEffect(() => {
    if (!searchOpen) return undefined
    const term = query.trim()
    if (!term) {
      setHits(products.slice(0, 6))
      return undefined
    }
    const handle = setTimeout(() => {
      api
        .products({ q: term, limit: 8 })
        .then((data) => {
          setHits((data.products || []).map((row) => adaptProduct(row, lang)).filter(Boolean))
        })
        .catch(() => setHits([]))
    }, 220)
    return () => clearTimeout(handle)
  }, [query, searchOpen, lang, products])

  const close = () => {
    setSearchOpen(false)
    setQuery('')
  }

  const go = (to) => {
    close()
    navigate(to)
  }

  return (
    <CommandDialog
      open={searchOpen}
      onOpenChange={(v) => (v ? setSearchOpen(true) : close())}
      className="glass rounded-panel border-0"
      shouldFilter={false}
      title={t.searchShortcut}
      description={t.searchPalette}
    >
      <CommandInput
        placeholder={t.searchPalette}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty className="py-10 text-center text-xs text-muted-foreground">
          {t.searchEmpty}
        </CommandEmpty>

        {hits.length > 0 && (
          <CommandGroup heading={query ? t.products : t.popularNow}>
            {hits.map((p) => (
              <CommandItem
                key={p.id}
                value={`${p.name} ${p.brand} ${p.id}`}
                onSelect={() => go(`/product/${p.slug}`)}
                className="gap-3"
              >
                <img
                  src={imgUrl(p.img, { w: 96, h: 96 })}
                  alt=""
                  className="size-9 shrink-0 rounded-md object-cover"
                />
                <div className="min-w-0 flex-1">
                  <div className="clamp-1 text-xs font-semibold">{p.name}</div>
                  <div className="text-2xs text-muted-foreground">{p.brand}</div>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />

        <CommandGroup heading={t.departments}>
          {categories.map((c) => (
            <CommandItem
              key={c.slug}
              value={`${c.name} ${c.slug}`}
              onSelect={() => go(`/category/${c.slug}`)}
            >
              <span
                className="mr-2 size-2 shrink-0 rounded-pill"
                style={{ background: `rgb(${c.tone})` }}
              />
              <span className="flex-1 text-xs">{c.name}</span>
              <ArrowRight className="size-3 opacity-50" />
            </CommandItem>
          ))}
        </CommandGroup>

        {!query && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t.trendingSearches}>
              {trending.map((term) => (
                <CommandItem key={term} value={term} onSelect={() => setQuery(term)}>
                  <TrendingUp className="mr-2 size-3.5 opacity-60" />
                  <span className="text-xs">{term}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {query.trim() && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value={`see-all-${query}`}
                onSelect={() => go(`/search?q=${encodeURIComponent(query.trim())}`)}
                className="justify-center text-primary"
              >
                <Search className="mr-2 size-3.5" />
                <span className="text-xs font-semibold">
                  {t.seeAllResults} “{query}”
                </span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
