export default function Logo({
  className = "h-11 w-11",
  title = "BrownStore",
  hd = false,
}) {
  return (
    <img
      src={hd ? "/logo-hero.png" : "/logo.png"}
      alt={title}
      className={`object-contain ${className}`}
      draggable={false}
    />
  );
}
