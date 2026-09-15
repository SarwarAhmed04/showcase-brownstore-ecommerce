import { lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ArrowRight, Clock, Leaf, MapPin, Package, ShieldCheck, Sparkles } from 'lucide-react'
import PageHead from '../components/PageHead'

import { Reveal, SectionHead } from '../components/ui'
import { useCatalog } from '../lib/catalogStore'
import { useMedia } from '../lib/hooks'
import { useStore } from '../store'

// Both are WebGL/effect-heavy and only exist on this page — no reason for them
// to sit in the bundle every shopper downloads.
const ScrollExpand = lazy(() => import('../components/ScrollExpand'))
const HalftoneReveal = lazy(() => import('../components/HalftoneReveal'))

import { imgUrl } from '../lib/img'

const PILLARS = [
  {
    Icon: Sparkles,
    title: 'We use it before we list it',
    body: 'Nothing reaches the shelf on a spec sheet alone. Someone here lives with it for a fortnight first, which is why the catalogue is forty-five items and not four thousand.',
  },
  {
    Icon: ShieldCheck,
    title: 'The warranty is ours, not a form',
    body: 'Two years, parts and labour, handled at the counter in Karrada. You will not be given a phone number for a distributor in another country.',
  },
  {
    Icon: Leaf,
    title: 'Repair before replace',
    body: 'We stock the seals, filters and brushes for everything we sell. A machine that dies in year three because a gasket cost nothing to replace is a failure on our part.',
  },
  {
    Icon: Package,
    title: 'One price, on the label',
    body: 'The number on the tag is the number you pay. No haggling theatre, no "special price for you", no discount that was never a discount.',
  },
]

export default function About() {
  const { categories, live: products } = useCatalog()
  const { theme } = useStore()
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)')

  // Counts come from the live catalogue, so they stay true as the admin
  // adds or removes products rather than going stale in a module constant.
  const STATS = [
    { n: String(products.length), l: 'products on the floor' },
    { n: String(categories.length), l: 'departments' },
    { n: '2yr', l: 'cover as standard' },
    { n: '2019', l: 'trading since' },
  ]

  return (
    <div className="container-x py-10 lg:py-14">
      <PageHead
        eyebrow="Since 2019"
        title={<>A small shop that <span className="gold-text">says no</span> a lot</>}
        sub="Brown Store is one showroom in Baghdad and a catalogue we keep deliberately short. This page explains how things get onto it."
        crumbs={[{ label: 'About' }]}
      />

      {/* ---------------- showroom frame ----------------
          `useWindowScroll` matters: without it ScrollExpand builds its own
          nested overflow-y-auto container and reads that scrollTop, so the
          frame would swallow the page scroll whenever the cursor was over it.
          Window-driven, it simply opens out as the page moves past.
          `enabled` is the reduced-motion off-switch — it falls back to a
          static frame rather than a slower animation. */}
      <div className="mb-14">
        <Suspense fallback={<div className="glass aspect-[21/9] w-full rounded-panel" />}>
        <ScrollExpand
          src={imgUrl('photo-1592078615290-033ee584e267', { w: 1800, h: 1000 })}
          alt="The Brown Store showroom floor"
          scrollHint="Keep scrolling"
          startWidth={56}
          startHeight={66}
          startRadius={28}
          endRadius={20}
          mediaZoom={1.18}
          scrollDistance={0.55}
          holdDistance={0.08}
          smoothing={0.12}
          overlayScrim={0.5}
          useWindowScroll
          enabled={!reducedMotion}
        >
          <div className="grid w-full grid-cols-2 gap-4 lg:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.l}>
                <div className="font-display text-3xl font-black text-primary sm:text-4xl">{s.n}</div>
                <div className="mt-1 text-2xs font-semibold uppercase tracking-wider text-foreground/75">
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </ScrollExpand>
        </Suspense>
      </div>

      {/* ---------------- the promise ---------------- */}
      <section id="promise" className="scroll-mt-40 py-8">
        <Reveal>
          <SectionHead
            eyebrow="The Brown promise"
            title="Four things we will not bend on"
            sub="These are the rules the buying decisions get measured against. When something fails one of them, it does not go on the floor."
          />
        </Reveal>

        <div className="grid gap-4 md:grid-cols-2">
          {PILLARS.map((p, i) => (
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

      {/* ---------------- showroom ---------------- */}
      <section id="showroom" className="scroll-mt-40 py-14">
        <Reveal>
          <div className="glass grid overflow-hidden rounded-panel lg:grid-cols-2">
            <div className="flex flex-col justify-center p-8 sm:p-12">
              <div className="eyebrow mb-5">
                <MapPin size={12} /> Karrada In, Baghdad
              </div>
              <h2 className="headline text-3xl sm:text-4xl">Come and press the buttons</h2>
              <p className="mt-5 text-base leading-relaxed text-foreground/75">
                Everything in this catalogue is on the floor, plugged in and switched on. Pull a
                shot, lift the vacuum, feel the weight of the watch. Nobody will follow you around
                the shop.
              </p>

              <dl className="mt-8 space-y-3.5">
                <div className="flex gap-3 text-sm">
                  <Clock size={16} className="mt-0.5 shrink-0 text-primary" />
                  <div>
                    <dt className="font-semibold">Open daily</dt>
                    <dd className="text-foreground/75">10:00 – 22:00, including Fridays</dd>
                  </div>
                </div>
                <div className="flex gap-3 text-sm">
                  <MapPin size={16} className="mt-0.5 shrink-0 text-primary" />
                  <div>
                    <dt className="font-semibold">Where</dt>
                    <dd className="text-foreground/75">Karrada In, Baghdad — collection point at the rear</dd>
                  </div>
                </div>
              </dl>

              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild variant="brand" size="lg">
                  <Link to="/contact">
                    Get in touch <ArrowRight />
                  </Link>
                </Button>
                <Button asChild variant="glass" size="lg">
                  <Link to="/shop">Browse the catalogue</Link>
                </Button>
              </div>
            </div>

            {/* One feature moment: the print-halftone rendering resolves into
                the photograph under the cursor. Hover-triggered, so it costs
                nothing until someone reaches for it. */}
            <div className="relative min-h-[300px] lg:min-h-full">
              <Suspense fallback={<div className="absolute inset-0 bg-muted" />}>
              <HalftoneReveal
                src={imgUrl('photo-1507473885765-e6ed057f782c', { w: 900, h: 900 })}
                inkColor={theme === 'cream' ? '#3a2418' : '#f0dcc4'}
                paperColor={theme === 'cream' ? '#f7ede0' : '#1b100c'}
                mode="mono"
                dotDensity={78}
                dotSize={1}
                angle={45}
                shape="circle"
                contrast={1.2}
                revealRadius={0.38}
                edge={0.75}
                follow={0.34}
                idleReveal={reducedMotion ? 1 : 0}
                trigger="hover"
                borderRadius="0px"
                className="absolute inset-0"
              />
              </Suspense>
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-background/70 to-transparent" />
            </div>
          </div>
        </Reveal>
      </section>

      {/* ---------------- departments ---------------- */}
      <section className="py-8">
        <Reveal>
          <SectionHead eyebrow="What we carry" title="Ten departments, no filler" />
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
