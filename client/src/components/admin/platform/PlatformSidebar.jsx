import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { imgUrl } from "../../../lib/img";

export const PLATFORM_SECTIONS = [
  ["overview", "overviewTab"],
  ["mapping", "categoryMapping"],
  ["availability", "availabilityTab"],
  ["commissions", "existingCommissions"],
  ["products", "products"],
  ["excel", "excelTab"],
  ["api", "partnerApi"],
];

export function platformSectionsFor(partnerSlug) {
  if (partnerSlug === "miswag") {
    return [
      ["connection", "miswagApiConnection"],
      ["syncAll", "miswagSyncAllTitle"],
      ["mappingCategories", "miswagMappingCategories"],
      ...PLATFORM_SECTIONS.filter(([id]) => id !== "mapping"),
    ];
  }
  return PLATFORM_SECTIONS;
}

function PlatformMark({ image, name }) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) {
    return (
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brown font-display text-lg text-cream">
        {(name || "?").slice(0, 1)}
      </div>
    );
  }
  return (
    <img
      src={imgUrl(image)}
      alt=""
      onError={() => setFailed(true)}
      className="h-12 w-12 rounded-2xl bg-white object-cover ring-1 ring-brown/10"
    />
  );
}

function SectionButton({ active, label, onClick, disabled, badge }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-start text-sm font-semibold transition disabled:opacity-40 ${
        active ? "bg-brown text-cream" : "text-brown/60 hover:bg-brown/[0.04] hover:text-brown"
      }`}
    >
      <span className="min-w-0 flex-1">{label}</span>
      {badge > 0 ? (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function PlatformNavBody({ nav, t, onNavigate }) {
  const partner = nav?.partner;
  const sections = platformSectionsFor(partner?.slug);
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-4 pt-6">
        <Link
          to="/admin/platforms"
          onClick={onNavigate}
          className="inline-flex items-center gap-2 text-sm font-semibold text-brown/55 transition hover:text-brown"
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
          {t.backToPlatforms}
        </Link>
        <button
          type="button"
          onClick={nav?.onEdit}
          disabled={!nav?.onEdit}
          aria-label={t.editPlatform}
          className="mt-4 flex w-full items-center gap-3 rounded-xl text-start transition hover:bg-brown/[0.04] disabled:cursor-default disabled:hover:bg-transparent"
        >
          <PlatformMark image={partner?.image} name={partner?.name} />
          <span className="min-w-0 flex-1 truncate font-display text-xl">{partner?.name || "…"}</span>
        </button>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-6">
        {sections.map(([id, labelKey]) => (
          <SectionButton
            key={id}
            active={nav?.tab === id}
            disabled={!nav?.setTab}
            label={t[labelKey]}
            badge={
              id === "mapping" || id === "mappingCategories" ? Number(nav?.noticeCount) || 0 : 0
            }
            onClick={() => {
              nav?.setTab?.(id);
              onNavigate?.();
            }}
          />
        ))}
      </nav>
    </div>
  );
}

export default function PlatformSidebar({ nav, t, mobileOpen, onClose }) {
  return (
    <>
      <aside className="fixed top-0 z-40 hidden h-svh w-[13.5rem] flex-col border-e border-brown/[0.06] bg-[#faf4ec] start-[13.5rem] lg:flex">
        <PlatformNavBody nav={nav} t={t} />
      </aside>
      {mobileOpen ? (
        <div className="lg:hidden">
          <button
            type="button"
            aria-label={t.close}
            className="fixed inset-0 z-40 bg-brown/25"
            onClick={onClose}
          />
          <aside className="fixed inset-y-0 z-50 flex w-[13.5rem] flex-col bg-[#faf4ec] shadow-xl start-0">
            <PlatformNavBody nav={nav} t={t} onNavigate={onClose} />
          </aside>
        </div>
      ) : null}
    </>
  );
}
