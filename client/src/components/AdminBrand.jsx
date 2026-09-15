import { ShoppingBag } from "lucide-react";

export default function AdminBrand({ className = "" }) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-brown text-cream shadow-[0_1px_2px_rgb(61_35_23/0.18)]">
        <ShoppingBag className="h-[18px] w-[18px]" strokeWidth={1.7} />
      </span>
      <div className="min-w-0 leading-none text-start">
        <p className="font-display text-[17px] font-semibold tracking-[-0.02em] text-brown">
          Brown Store
        </p>
        <p className="mt-1 text-[10px] font-semibold tracking-[0.24em] text-brown/40">
          ADMIN
        </p>
      </div>
    </div>
  );
}

