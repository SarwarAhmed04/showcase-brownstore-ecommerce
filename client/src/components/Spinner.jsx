export default function Spinner({ label }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-brown/60">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-tan border-t-brown" />
      {label ? <p className="text-sm">{label}</p> : null}
    </div>
  );
}
