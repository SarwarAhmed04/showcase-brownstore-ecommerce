import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useLang } from "../context/LangContext";
import Logo from "./Logo";
import LanguageSwitcher from "./LanguageSwitcher";

const links = [
  { to: "/", end: true, key: "home" },
  { to: "/shop", key: "shop" },
  { to: "/about", key: "about" },
  { to: "/contact", key: "contact" },
];

function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export default function Header() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 8);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function onSearch(e) {
    e.preventDefault();
    const query = q.trim();
    navigate(query ? `/shop?q=${encodeURIComponent(query)}` : "/shop");
  }

  return (
    <header
      className={`sticky top-0 z-50 transition-shadow duration-500 ${
        scrolled ? "glass-bar shadow-2xl" : "bg-bg/70 backdrop-blur-md"
      }`}
    >
      <div className="container-x flex h-[70px] items-center gap-3 md:gap-4">
        <Link to="/" className="flex shrink-0 items-center gap-3" aria-label="Brown Store — home">
          <span className="grid size-10 place-items-center rounded-xl bg-primary/15 text-primary">
            <Logo className="h-8 w-8" />
          </span>
          <span className="leading-tight">
            <span className="font-display block text-lg font-bold tracking-tight text-fg">
              Brown Store
            </span>
            <span className="hidden text-[10px] font-semibold tracking-[0.18em] text-fg-mute uppercase sm:block">
              {t.tagline}
            </span>
          </span>
        </Link>

        <nav className="ms-2 hidden items-center gap-1 lg:flex">
          {links.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-full px-3.5 py-2 text-sm font-semibold transition-all ${
                  isActive
                    ? "bg-primary/15 text-primary"
                    : "text-fg-mute hover:bg-muted hover:text-fg"
                }`
              }
            >
              {t[item.key]}
            </NavLink>
          ))}
        </nav>

        <form
          onSubmit={onSearch}
          className="glass-soft ms-auto hidden max-w-sm flex-1 items-center gap-2.5 rounded-full px-4 py-2.5 md:flex"
        >
          <IconSearch />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.search}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-mute"
          />
        </form>

        <div className="ms-auto flex items-center gap-1.5 md:ms-0">
          <button
            type="button"
            onClick={() => navigate("/shop")}
            aria-label={t.searchShortcut}
            className="grid size-10 place-items-center rounded-full text-fg-mute transition hover:bg-muted hover:text-fg md:hidden"
          >
            <IconSearch />
          </button>
          <LanguageSwitcher />
        </div>
      </div>

      <div className="border-t border-border/30 px-3 py-2 lg:hidden">
        <nav className="flex justify-center gap-1 overflow-x-auto no-scrollbar">
          {links.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
                  isActive ? "bg-primary/15 text-primary" : "text-fg-mute"
                }`
              }
            >
              {t[item.key]}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
