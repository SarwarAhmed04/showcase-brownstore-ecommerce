import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Heart, Trash2 } from 'lucide-react'
import Catalog from '../components/Catalog'
import PageHead from '../components/PageHead'
import { adaptProduct } from '../lib/catalog'
import { useStore } from '../store'
import { api } from '../api'
import { useLang } from '../context/LangContext'

export default function Saved() {
  const { saved } = useStore()
  const { t, lang } = useLang()
  const [items, setItems] = useState([])

  useEffect(() => {
    if (!saved.ids.length) {
      setItems([])
      return undefined
    }
    let cancelled = false
    api
      .products({ ids: saved.ids.join(','), limit: 10 })
      .then((data) => {
        if (cancelled) return
        setItems((data.products || []).map((row) => adaptProduct(row, lang)).filter(Boolean))
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [saved.ids.join(','), lang])

  return (
    <div className="container-x py-10 lg:py-14">
      <PageHead
        eyebrow={<><Heart size={12} /> {t.savedEyebrow}</>}
        title={t.savedTitle}
        sub={t.savedSub}
        crumbs={[{ label: t.savedItems }]}
      >
        {items.length > 0 && (
          <Button
            type="button"
            variant="glass"
            onClick={() => items.forEach((p) => saved.toggle(p.id))}
          >
            <Trash2 /> {t.clearAll}
          </Button>
        )}
      </PageHead>

      <Catalog
        base={items}
        emptyIcon={Heart}
        emptyTitle={t.savedEmpty}
        emptySub={t.savedEmptySub}
        emptyAction={
          <Button asChild variant="brand">
            <Link to="/shop">{t.startBrowsing}</Link>
          </Button>
        }
      />
    </div>
  )
}
