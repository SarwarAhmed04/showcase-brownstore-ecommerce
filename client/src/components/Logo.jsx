export default function Logo({
  className = "h-11 w-11",
  title = "BrownStore",
}) {
  return (
    <img
      src="/logo.png"
      alt={title}
      className={`object-contain ${className}`}
      draggable={false}
      decoding="async"
    />
  );
}
