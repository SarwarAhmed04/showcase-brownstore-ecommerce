import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ArrowRight, Clock } from 'lucide-react'
import Hero from '../components/Hero'
import ProductRail from '../components/ProductRail'
import CategoryTile from '../components/CategoryTile'
import CategoryShowcase from '../components/CategoryShowcase'
import { LogoLoop } from '../components/LogoLoop'
import ProductCard from '../components/ProductCard'
import { BannerSlider, BannerStrip } from '../components/HomeBanners'
import { Reveal, SectionHead } from '../components/ui'
import { useCatalog } from '../lib/catalogStore'
import { useLang } from '../context/LangContext'
import { api } from '../api'
import { useEffect, useState } from 'react'

function HomeCategories({ categories, layout, lang }) {
  if (layout && layout !== "mosaic") {
    const items = categories.map((category) => ({
      id: category.id,
      name: category.name,
      image: category.cover,
    }))
    return <CategoryShowcase categories={items} layout={layout} lang={lang} />
  }

  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3 sm:gap-4">
      {categories.map((category, index) => (
        <Reveal key={category.slug} delay={(index % 3) * 70}>
          <CategoryTile category={category} />
        </Reveal>
      ))}
    </div>
  )
}

export default function Home() {
  const { categories, byCategory, brands, featured, live: products, layout, categoryLimit } = useCatalog()
  const { t, lang } = useLang()
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

  const brandLogos = brands.map((b) => ({ name: b }))

  const renderBrand = (item) => (
    <Link
      to={`/shop?brand=${encodeURIComponent(item.name)}`}
      aria-label={item.name}
      className="whitespace-nowrap font-display text-xl font-bold text-muted-foreground transition-colors hover:text-primary sm:text-2xl"
    >
      {item.name}
    </Link>
  )

  return (
    <>
      {sliderBanners.length > 0 ? <BannerSlider banners={sliderBanners} /> : null}
      {bannersReady && sliderBanners.length === 0 ? <Hero /> : null}

      <section className="container-x py-14">
        <Reveal>
          <SectionHead
            eyebrow={t.departmentsEyebrow}
            title={t.shopByCategory}
            sub={t.categorySub}
            action={
              <Button asChild variant="glass">
                <Link to="/shop">
                  {t.allProducts} <ArrowRight />
                </Link>
              </Button>
            }
          />
        </Reveal>

        <HomeCategories
          categories={categoryLimit > 0 ? categories.slice(0, categoryLimit) : categories}
          layout={layout}
          lang={lang}
        />
      </section>

      <section className="container-x py-14">
        <Reveal>
          <SectionHead
            eyebrow={t.handPickedEyebrow}
            title={t.featured}
            sub={t.featuredSub}
            action={
              <Button asChild variant="glass">
                <Link to="/shop">
                  {t.viewAll} <ArrowRight />
                </Link>
              </Button>
            }
          />
        </Reveal>

        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {featured.slice(0, 8).map((p, i) => (
            <Reveal key={p.id} delay={(i % 4) * 70}>
              <ProductCard product={p} />
            </Reveal>
          ))}
        </div>
      </section>

      <BannerStrip banner={bannerFour} />

      {categories.slice(0, 3).map((cat) => (
        <Reveal key={cat.slug}>
          <ProductRail
            eyebrow={cat.tagline}
            title={cat.name}
            items={byCategory(cat.slug)}
            to={`/category/${cat.slug}`}
          />
        </Reveal>
      ))}

      <BannerStrip banner={bannerFive} />

      <section className="py-14">
        <div className="divider-glow mb-10" />
        <div className="relative h-16">
          <LogoLoop
            logos={brandLogos}
            renderItem={renderBrand}
            speed={38}
            direction="left"
            logoHeight={40}
            gap={72}
            hoverSpeed={0}
            scaleOnHover
            fadeOut
            fadeOutColor="rgb(var(--background))"
            ariaLabel="Brown Store"
          />
        </div>
        <div className="divider-glow mt-10" />
      </section>

      <Reveal>
        <ProductRail
          eyebrow={<><Clock size={12} /> {t.justLanded}</>}
          title={t.newInShowroom}
          items={newest}
          to="/shop?sort=new"
        />
      </Reveal>
    </>
  )
}
