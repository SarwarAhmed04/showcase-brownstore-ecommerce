import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ArrowRight, Clock } from 'lucide-react'
import Hero from '../components/Hero'
import ProductRail from '../components/ProductRail'
import CategoryTile from '../components/CategoryTile'
import { LogoLoop } from '../components/LogoLoop'
import ProductCard from '../components/ProductCard'
import { BannerSlider, BannerStrip } from '../components/HomeBanners'
import { Reveal, SectionHead } from '../components/ui'
import { useCatalog } from '../lib/catalogStore'
import { imgUrl } from '../lib/img'
import { useLang } from '../context/LangContext'
import { api } from '../api'
import { useEffect, useState } from 'react'

export default function Home() {
  const { categories, byCategory, brands, featured, live: products } = useCatalog()
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

        <div className="grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-4">
          {categories.slice(0, 2).map((c, i) => (
            <Reveal key={c.slug} delay={i * 70} className="col-span-2 lg:row-span-2">
              <CategoryTile category={c} large />
            </Reveal>
          ))}
          {categories.slice(2).map((c, i) => (
            <Reveal key={c.slug} delay={140 + i * 60}>
              <CategoryTile category={c} />
            </Reveal>
          ))}
        </div>
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

      <section className="container-x py-14">
        <Reveal>
          <div className="glass grid overflow-hidden rounded-panel lg:grid-cols-2">
            <div className="relative min-h-[280px] lg:min-h-[440px]">
              <img
                src={imgUrl('photo-1495474472287-4d71bcdd2085', { w: 1000, h: 900 })}
                alt=""
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-transparent to-[rgb(var(--bg)/.65)] lg:to-[rgb(var(--bg)/.9)]" />
            </div>

            <div className="flex flex-col justify-center p-8 sm:p-12 lg:p-14">
              <div className="eyebrow mb-5">{t.editorialEyebrow}</div>
              <h2 className="headline text-3xl sm:text-4xl lg:text-4xl">
                {t.editorialTitle} <span className="gold-text">{t.editorialGold}</span>
              </h2>
              <p className="mt-5 text-base leading-relaxed text-foreground/75">
                {t.editorialBody}
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild variant="brand" size="lg">
                  <Link to="/shop">
                    {t.seeTheMachines} <ArrowRight />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

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
