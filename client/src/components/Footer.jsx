import { Link } from "react-router-dom";
import { useLang } from "../context/LangContext";

export default function Footer() {
  const { t } = useLang();
  return (
    <footer className="mt-auto border-t border-brown/10 bg-brown text-cream">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-3">
        <div>
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="" className="h-10 w-10 brightness-0 invert" />
            <p className="font-display text-xl">BrownStore</p>
          </div>
          <p className="mt-3 max-w-xs text-sm text-cream/70">{t.tagline}</p>
        </div>
        <div>
          <p className="mb-3 text-sm font-semibold text-tan">{t.home}</p>
          <div className="flex flex-col gap-2 text-sm text-cream/80">
            <Link to="/shop">{t.shop}</Link>
            <Link to="/about">{t.about}</Link>
            <Link to="/contact">{t.contact}</Link>
          </div>
        </div>
        <div>
          <p className="mb-3 text-sm font-semibold text-tan">{t.contact}</p>
          <p className="text-sm text-cream/80" dir="ltr">
            +964 773 802 9000
          </p>
          <p className="text-sm text-cream/80">info@ibsher.com</p>
          <Link
            to="/admin/login"
            className="mt-4 inline-block text-xs text-tan/80 hover:text-tan"
          >
            {t.admin}
          </Link>
        </div>
      </div>
      <div className="border-t border-white/10 py-4 text-center text-xs text-cream/50">
        © {new Date().getFullYear()} BrownStore · {t.footerRights}
      </div>
    </footer>
  );
}
