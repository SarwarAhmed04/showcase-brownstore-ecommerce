import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ArrowRight, Clock, Leaf, MapPin, Package, ShieldCheck, Sparkles } from 'lucide-react'
import PageHead from '../components/PageHead'

import { Reveal, SectionHead } from '../components/ui'
import { useCatalog } from '../lib/catalogStore'
import { useLang } from '../context/LangContext'

export default function About() {
  const { categories, live: products } = useCatalog()
  const { t } = useLang()

  const pillars = [
    { Icon: Sparkles, title: t.pillarUseTitle, body: t.pillarUseBody },
    { Icon: ShieldCheck, title: t.pillarWarrantyTitle, body: t.pillarWarrantyBody },
    { Icon: Leaf, title: t.pillarRepairTitle, body: t.pillarRepairBody },
    { Icon: Package, title: t.pillarPriceTitle, body: t.pillarPriceBody },
  ]

  const stats = [
    { n: String(products.length), l: t.productsOnFloor },
    { n: String(categories.length), l: t.departments },
    { n: '2yr', l: t.coverStandard },
    { n: '2019', l: t.tradingSince },
  ]

  return (
    <div className="container-x py-10 lg:py-14">
      <PageHead
        eyebrow={t.aboutSince}
        title={
          <>
            {t.aboutHeadlineBefore} <span className="gold-text">{t.aboutHeadlineGold}</span> {t.aboutHeadlineAfter}
          </>
        }
        sub={t.aboutPageSub}
        crumbs={[{ label: t.about }]}
      />

      <div className="mb-14 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.l} className="glass rounded-card p-5">
            <div className="font-display text-3xl font-black text-primary sm:text-4xl">{s.n}</div>
            <div className="mt-1 text-2xs font-semibold uppercase tracking-wider text-foreground/75">
              {s.l}
            </div>
          </div>
        ))}
      </div>

      <section id="promise" className="scroll-mt-40 py-8">
        <Reveal>
          <SectionHead
            eyebrow={t.brownPromise}
            title={t.promiseTitle}
            sub={t.promiseSub}
          />
        </Reveal>

        <div className="grid gap-4 md:grid-cols-2">
          {pillars.map((p, i) => (
            <Reveal key={p.title} delay={i * 80}>
              <article className="glass h-full rounded-card p-7">
                <span className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-[rgb(var(--accent)/.13)] text-primary">
                  <p.Icon size={21} />
                </span>
                <h3 className="font-display text-xl font-bold">{p.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-foreground/75">{p.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="showroom" className="scroll-mt-40 py-14">
        <Reveal>
          <div className="glass overflow-hidden rounded-panel">
            <div className="flex flex-col justify-center p-8 sm:p-12">
              <div className="eyebrow mb-5">
                <MapPin size={12} /> {t.showroomAddress}
              </div>
              <h2 className="headline text-3xl sm:text-4xl">{t.comePressButtons}</h2>
              <p className="mt-5 text-base leading-relaxed text-foreground/75">{t.comePressBody}</p>

              <dl className="mt-8 space-y-3.5">
                <div className="flex gap-3 text-sm">
                  <Clock size={16} className="mt-0.5 shrink-0 text-primary" />
                  <div>
                    <dt className="font-semibold">{t.openDaily}</dt>
                    <dd className="text-foreground/75">{t.hoursIncludingFriday}</dd>
                  </div>
                </div>
                <div className="flex gap-3 text-sm">
                  <MapPin size={16} className="mt-0.5 shrink-0 text-primary" />
                  <div>
                    <dt className="font-semibold">{t.where}</dt>
                    <dd className="text-foreground/75">{t.showroomWhereDetail}</dd>
                  </div>
                </div>
              </dl>

              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild variant="brand" size="lg">
                  <Link to="/contact">
                    {t.contactUs} <ArrowRight />
                  </Link>
                </Button>
                <Button asChild variant="glass" size="lg">
                  <Link to="/shop">{t.browseCatalogue}</Link>
                </Button>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      <section className="py-8">
        <Reveal>
          <SectionHead eyebrow={t.whatWeCarry} title={t.tenDepartments} />
        </Reveal>
        <div className="flex flex-wrap gap-2">
          {categories.map((c, i) => (
            <Reveal key={c.slug} delay={i * 40}>
              <Link
                to={`/category/${c.slug}`}
                className="glass flex items-center gap-2.5 rounded-full py-2.5 pl-3 pr-5 transition-all hover:-translate-y-1"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: `rgb(${c.tone})` }}
                />
                <span className="text-sm font-semibold">{c.name}</span>
              </Link>
            </Reveal>
          ))}
        </div>
      </section>
    </div>
  )
}
