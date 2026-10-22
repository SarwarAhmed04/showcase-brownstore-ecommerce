import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Hero from '../components/Hero'
import ProductRail from '../components/ProductRail'
import CategoryShowcase from '../components/CategoryShowcase'
import { LogoLoop } from '../components/LogoLoop'
import ProductCard, { FeatureCard } from '../components/ProductCard'
import { BannerSlider, BannerStrip } from '../components/HomeBanners'
import { ArrowLink, Reveal, SectionHead } from '../components/ui'
import { useCatalog } from '../lib/catalogStore'
import { useLang } from '../context/LangContext'
import { api } from '../api'

function FeaturedBento({ items }) {
  const [lead, ...rest] = items
  if (!lead) return null
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-4 lg:grid-cols-4">
      <Reveal className="col-span-2 lg:row-span-2">
        <FeatureCard product={lead} />
      </Reveal>
      {rest.slice(0, 8).map((p, i) => (
        <Reveal key={p.id} delay={(i % 4) * 70}>
          <ProductCard product={p} />
        </Reveal>
      ))}
    </div>
  )
}

function BrandsBand({ brands }) {
  const { t } = useLang()
  if (brands.length < 3) return null

  return (
    <section className="my-10 bg-bean-100 py-10 sm:my-14 sm:py-14">
      <div className="container-x mb-7 flex items-center justify-between gap-4">
        <span className="sf-eyebrow">{t.brandsWeCarry}</span>
        <span className="font-display text-sm font-bold tabular-nums text-bean-900/40" dir="ltr">
          {String(brands.length).padStart(2, '0')}
        </span>
      </div>
      <div dir="ltr" className="relative h-14">
        <LogoLoop
          logos={brands.map((name) => ({ name }))}
          renderItem={(item) => (
            <Link
              to={`/shop?brand=${encodeURIComponent(item.name)}`}
              aria-label={item.name}
              className="whitespace-nowrap font-display text-2xl font-extrabold tracking-[-0.03em] text-bean-900/35 transition-colors hover:text-bean-900 sm:text-[2rem]"
            >
              {item.name}
            </Link>
          )}
          speed={36}
          direction="left"
          logoHeight={40}
          gap={64}
          hoverSpeed={0}
          fadeOut
          fadeOutColor="rgb(var(--sand))"
          ariaLabel={t.brandsWeCarry}
        />
      </div>
    </section>
  )
}

export default function Home() {
  const { categories, byCategory, brands, featured, live: products, layout, categoryLimit } = useCatalog()
  const { t } = useLang()
  const [banners, setBanners] = useState([])
  const [bannersReady, setBannersReady] = useState(false)
  const newest = [...products].sort((a, b) => String(b.id).localeCompare(String(a.id))).slice(0, 10)

  useEffect(() => {
    api
      .banners()
      .then((data) => setBanners(data.banners || []))
      .catch(() => setBanners([]))
      .finally(() => setBannersReady(true))
  }, [])

  const sliderBanners = banners.filter((item) => item.slot <= 3)
  const bannerFour = banners.find((item) => item.slot === 4)
  const bannerFive = banners.find((item) => item.slot === 5)
  const shownCategories = categoryLimit > 0 ? categories.slice(0, categoryLimit) : categories

  return (
    <>
      {bannersReady && sliderBanners.length > 0 ? (
        <BannerSlider banners={sliderBanners} />
      ) : (
        <Hero />
      )}

      <section className="container-x pt-14 sm:pt-20">
        <Reveal>
          <SectionHead
            eyebrow={t.departmentsEyebrow}
            title={t.shopByCategory}
            sub={t.categorySub}
            action={<ArrowLink to="/shop">{t.allProducts}</ArrowLink>}
          />
        </Reveal>
        <CategoryShowcase categories={shownCategories} layout={layout} />
      </section>

      {featured.length > 0 && (
        <section className="container-x pt-16 sm:pt-24">
          <Reveal>
            <SectionHead
              eyebrow={t.handPickedEyebrow}
              title={t.featured}
              sub={t.featuredSub}
              action={<ArrowLink to="/shop">{t.viewAll}</ArrowLink>}
            />
          </Reveal>
          <FeaturedBento items={featured} />
        </section>
      )}

      <div className="pt-8">
        <BannerStrip banner={bannerFour} />
      </div>

      {categories.slice(0, 3).map((cat) => (
        <ProductRail
          key={cat.slug}
          eyebrow={t.departmentsEyebrow}
          title={cat.name}
          items={byCategory(cat.slug)}
          to={`/category/${cat.slug}`}
        />
      ))}

      <BrandsBand brands={brands} />

      <BannerStrip banner={bannerFive} />

      <ProductRail eyebrow={t.justLanded} title={t.newInShowroom} items={newest} to="/shop?sort=new" />
    </>
  )
}
