// The fixed atmosphere behind every page: three slow-drifting warm blobs, a
// fine grain overlay, and a faint grid. All of it sits behind the glass, which
// is what gives the frosted panels something to refract.
export default function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* base wash */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 80% at 50% -10%, rgb(var(--bg-2)) 0%, rgb(var(--bg)) 55%)',
        }}
      />

      {/* drifting light pools */}
      <div
        className="absolute -left-40 -top-40 h-[560px] w-[560px] rounded-full opacity-[.55] blur-[110px] animate-drift"
        style={{ background: 'radial-gradient(circle, rgb(var(--accent) / .5), transparent 68%)' }}
      />
      <div
        className="absolute -right-32 top-1/4 h-[620px] w-[620px] rounded-full opacity-40 blur-[130px] animate-float"
        style={{ background: 'radial-gradient(circle, rgb(196 124 60 / .55), transparent 68%)' }}
      />
      <div
        className="absolute bottom-0 left-1/3 h-[520px] w-[520px] rounded-full opacity-30 blur-[120px] animate-drift"
        style={{
          animationDelay: '-8s',
          background: 'radial-gradient(circle, rgb(130 88 56 / .6), transparent 70%)',
        }}
      />

      {/* hairline grid — reads as structure under the blur */}
      <div
        className="absolute inset-0 opacity-[.055]"
        style={{
          backgroundImage:
            'linear-gradient(rgb(var(--stroke)) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--stroke)) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(100% 70% at 50% 0%, #000, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(100% 70% at 50% 0%, #000, transparent 80%)',
        }}
      />

      {/* film grain, so the gradients never band */}
      <svg className="absolute inset-0 h-full w-full opacity-[.16] mix-blend-overlay">
        <filter id="bs-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#bs-grain)" />
      </svg>
    </div>
  )
}
