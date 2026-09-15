import Catalog from '../components/Catalog'
import PageHead from '../components/PageHead'
import { PageSkeleton } from '../components/ui'
import { useCatalog } from '../lib/catalogStore'
import { useLang } from '../context/LangContext'

export default function Shop() {
  const { total, status } = useCatalog()
  const { t } = useLang()
  if (status === 'loading') return <PageSkeleton />

  return (
    <div className="container-x py-10 lg:py-14">
      <PageHead
        eyebrow={t.shopEyebrow}
        title={t.shopTitle}
        sub={(t.shopSub || '').replace('{n}', String(total || 0))}
        crumbs={[{ label: t.shop }]}
      />
      <Catalog query={{}} />
    </div>
  )
}
