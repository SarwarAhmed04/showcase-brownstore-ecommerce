import { Link, NavLink } from "react-router-dom";
import { useLang } from "../context/LangContext";

const langs = [
  { id: "ku", label: "کوردی" },
  { id: "en", label: "EN" },
  { id: "ar", label: "عربي" },
];

export default function Header() {
  const { t, lang, setLang } = useLang();
  const linkClass = ({ isActive }) =>
    `rounded-full px-3 py-1.5 text-sm font-medium transition ${
      isActive
        ? "bg-brown text-cream"
        : "text-brown/80 hover:bg-tan/20 hover:text-brown"
    }`;

  return (
    <header className="sticky top-0 z-40 border-b border-brown/10 bg-cream/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link to="/" className="flex items-center gap-3">
          <img
            src="/logo.png"
            alt="BrownStore"
            className="h-11 w-11 object-contain"
          />
          <div className="leading-tight">
            <p className="font-display text-lg font-semibold text-brown">
              BrownStore
            </p>
            <p className="hidden text-xs text-brown/60 sm:block">{t.tagline}</p>
          </div>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          <NavLink to="/" end className={linkClass}>
            {t.home}
          </NavLink>
          <NavLink to="/shop" className={linkClass}>
            {t.shop}
          </NavLink>
          <NavLink to="/about" className={linkClass}>
            {t.about}
          </NavLink>
          <NavLink to="/contact" className={linkClass}>
            {t.contact}
          </NavLink>
        </nav>

        <div className="flex items-center gap-1 rounded-full bg-white p-1 shadow-sm ring-1 ring-brown/10">
          {langs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setLang(item.id)}
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                lang === item.id
                  ? "bg-brown text-cream"
                  : "text-brown/70 hover:text-brown"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <nav className="flex items-center justify-center gap-1 border-t border-brown/5 px-3 py-2 md:hidden">
        <NavLink to="/" end className={linkClass}>
          {t.home}
        </NavLink>
        <NavLink to="/shop" className={linkClass}>
          {t.shop}
        </NavLink>
        <NavLink to="/about" className={linkClass}>
          {t.about}
        </NavLink>
        <NavLink to="/contact" className={linkClass}>
          {t.contact}
        </NavLink>
      </nav>
    </header>
  );
}
