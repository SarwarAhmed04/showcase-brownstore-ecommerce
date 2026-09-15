import { useEffect, useState } from 'react'
import { Flame } from 'lucide-react'
import Catalog from '../components/Catalog'
import PageHead from '../components/PageHead'
import { useLang } from '../context/LangContext'

function useMidnightCountdown() {
  const [left, setLeft] = useState(() => msUntilMidnight())
  useEffect(() => {
    const t = setInterval(() => setLeft(msUntilMidnight()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor(left / 1000))
  return {
    h: String(Math.floor(s / 3600)).padStart(2, '0'),
    m: String(Math.floor((s % 3600) / 60)).padStart(2, '0'),
    s: String(s % 60).padStart(2, '0'),
  }
}

function msUntilMidnight() {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  return midnight - now
}

export default function Deals() {
  const { h, m, s } = useMidnightCountdown()
  const { t } = useLang()
  const [total, setTotal] = useState(0)

  return (
    <div className="container-x py-10 lg:py-14">
      <PageHead
        eyebrow={<><Flame size={12} /> {t.dealsEyebrow}</>}
        title={t.dealsTitle}
        sub={(t.dealsSub || '').replace('{n}', String(total))}
        crumbs={[{ label: t.deals }]}
      >
        <div className="glass flex items-center gap-3 rounded-2xl px-6 py-4">
          {[
            { v: h, l: t.hoursShort },
            { v: m, l: t.minutesShort },
            { v: s, l: t.secondsShort },
          ].map((u, i) => (
            <div key={u.l} className="flex items-center gap-3">
              {i > 0 && <span className="pb-4 font-display text-xl text-muted-foreground">:</span>}
              <div className="text-center">
                <div className="font-display text-2xl font-black tabular-nums text-primary sm:text-3xl">
                  {u.v}
                </div>
                <div className="text-2xs font-bold uppercase tracking-[.16em] text-muted-foreground">{u.l}</div>
              </div>
            </div>
          ))}
        </div>
      </PageHead>

      <Catalog
        query={{ deals: 1 }}
        emptyIcon={Flame}
        emptyTitle={t.nothingMatches}
        emptySub={t.widenFilters}
        onMeta={({ total: next }) => setTotal(next)}
      />
    </div>
  )
}
