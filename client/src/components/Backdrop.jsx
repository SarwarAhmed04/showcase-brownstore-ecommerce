// Static wash behind every page. Animated full-viewport blurs and SVG grain
// were forcing constant compositing, so this stays still and cheap.
export default function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 80% at 50% -10%, rgb(var(--bg-2)) 0%, rgb(var(--bg)) 55%)",
        }}
      />
      <div
        className="absolute -left-24 -top-24 h-72 w-72 rounded-full opacity-40 blur-3xl"
        style={{ background: "radial-gradient(circle, rgb(var(--accent) / .35), transparent 70%)" }}
      />
      <div
        className="absolute -right-20 top-1/4 h-80 w-80 rounded-full opacity-25 blur-3xl"
        style={{ background: "radial-gradient(circle, rgb(196 124 60 / .35), transparent 70%)" }}
      />
      <div
        className="absolute inset-0 opacity-[.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgb(var(--stroke)) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--stroke)) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
        }}
      />
    </div>
  );
}
