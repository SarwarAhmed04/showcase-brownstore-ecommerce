export default function Spinner({ label }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-fg-mute">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      {label ? <p className="text-sm">{label}</p> : null}
    </div>
  );
}
