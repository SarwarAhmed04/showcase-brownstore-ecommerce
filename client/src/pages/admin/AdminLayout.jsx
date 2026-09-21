import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity,
  Image,
  LayoutGrid,
  LogOut,
  Menu,
  Package,
  Percent,
  Search,
  SquareArrowOutUpRight,
  Tags,
  Users,
  X,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import AdminBrand from "../../components/AdminBrand";
import LanguageSwitcher from "../../components/LanguageSwitcher";
import Spinner from "../../components/Spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

function productsSearch(params, q) {
  const next = new URLSearchParams(params);
  if (q) next.set("q", q);
  else next.delete("q");
  next.delete("page");
  const search = next.toString();
  return search ? `?${search}` : "";
}

function ProductSearch() {
  const { t } = useLang();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qParam = params.get("q") || "";
  const paramString = params.toString();
  const [query, setQuery] = useState(qParam);
  const typed = useRef(false);

  useEffect(() => {
    if (document.activeElement?.type === "search") return;
    if (location.pathname.startsWith("/admin/products")) setQuery(qParam);
  }, [location.pathname, qParam]);

  useEffect(() => {
    if (!typed.current) return undefined;
    const id = setTimeout(() => {
      const q = query.trim();
      if (location.pathname === "/admin/products" && q === qParam) return;
      navigate(
        { pathname: "/admin/products", search: productsSearch(paramString, q) },
        { replace: true }
      );
    }, 220);
    return () => clearTimeout(id);
  }, [query, location.pathname, navigate, qParam, paramString]);

  return (
    <form
      className="relative min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        typed.current = true;
        const q = query.trim();
        navigate(
          { pathname: "/admin/products", search: productsSearch(paramString, q) },
          { replace: true }
        );
      }}
    >
      <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-brown/35">
        <Search className="h-4 w-4" strokeWidth={1.8} />
      </span>
      <input
        type="search"
        value={query}
        autoComplete="off"
        onChange={(event) => {
          typed.current = true;
          setQuery(event.target.value);
        }}
        placeholder={t.search}
        className="w-full max-w-xl rounded-full border border-brown/10 bg-white py-2 ps-10 pe-4 text-sm text-brown outline-none ring-tan/40 placeholder:text-brown/35 focus:ring-2"
      />
    </form>
  );
}

export default function AdminLayout() {
  const { t } = useLang();
  const { user, ready, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  if (!ready) return <Spinner label={t.loading} />;
  if (!user) return <Navigate to="/admin/login" replace />;

  const links = [
    { to: "/admin", end: true, label: t.dashboard, icon: LayoutGrid },
    { to: "/admin/products", label: t.products, icon: Package },
    { to: "/admin/categories", label: t.categoriesPage, icon: Tags },
    { to: "/admin/platforms", label: t.platforms, icon: Percent },
    { to: "/admin/activity", label: t.activity, icon: Activity },
    { to: "/admin/banners", label: t.banners, icon: Image },
    { to: "/admin/accounts", label: t.accounts, icon: Users },
  ];

  function onLogout() {
    logout();
    navigate("/admin/login");
  }

  const itemClass = ({ isActive }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
      isActive
        ? "bg-white text-brown shadow-[0_1px_2px_rgb(61_35_23/0.06)]"
        : "text-brown/50 hover:bg-brown/[0.04] hover:text-brown"
    }`;

  return (
    <div data-theme="cream" className="min-h-svh bg-[#faf4ec] text-brown">
      {open ? (
        <button
          type="button"
          aria-label={t.menu}
          className="fixed inset-0 z-40 bg-brown/25 lg:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 z-50 flex w-[15.5rem] flex-col border-e border-brown/[0.06] bg-[#f3ebe0] transition-[inset-inline-start] duration-200 ${
          open ? "start-0" : "-start-[15.5rem] lg:start-0"
        }`}
      >
        <div className="px-5 pb-4 pt-6">
          <AdminBrand />
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 px-3">
          {links.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={itemClass}>
              <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto px-3 pb-4">
          <Link
            to="/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-brown/50 transition hover:bg-brown/[0.04] hover:text-brown"
          >
            <SquareArrowOutUpRight className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
            {t.viewStore}
          </Link>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-brown/50 transition hover:bg-brown/[0.04] hover:text-brown"
              >
                <LogOut className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
                {t.logout}
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent className="max-w-sm rounded-2xl border-brown/10 bg-[#faf4ec] text-brown">
              <AlertDialogHeader className="text-start">
                <AlertDialogTitle className="font-display text-brown">
                  {t.logoutConfirmTitle}
                </AlertDialogTitle>
                <AlertDialogDescription className="text-brown/60">
                  {t.logoutConfirmBody}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="gap-2 sm:space-x-0">
                <AlertDialogCancel className="rounded-xl border-brown/15 bg-white text-brown hover:bg-brown/[0.04]">
                  {t.cancel}
                </AlertDialogCancel>
                <AlertDialogAction
                  className="rounded-xl bg-brown text-white hover:bg-brown/90"
                  onClick={onLogout}
                >
                  {t.logout}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <div className="mt-3 rounded-2xl bg-white/70 px-3.5 py-3 ring-1 ring-brown/[0.04]">
            <p className="truncate text-sm font-semibold text-brown">
              {String(user.email || "admin").split("@")[0]}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-brown/40">
              {t.signedIn} · {t.localApi}
            </p>
          </div>
        </div>
      </aside>

      <div className="min-w-0 lg:ms-[15.5rem]">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 bg-[#faf4ec]/90 px-5 backdrop-blur-md md:px-8">
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="rounded-xl p-2 text-brown lg:hidden hover:bg-brown/[0.06]"
              onClick={() => setOpen((v) => !v)}
              aria-label={t.menu}
            >
              {open ? <X className="h-5 w-5" strokeWidth={1.8} /> : <Menu className="h-5 w-5" strokeWidth={1.8} />}
            </button>
            <h1 className="font-display text-lg text-brown/80 md:text-xl">
              {t.adminHeader}
            </h1>
          </div>
          {location.pathname.startsWith("/admin/products") ? (
            <ProductSearch />
          ) : (
            <div className="min-w-0 flex-1" />
          )}
          <div className="flex shrink-0 items-center gap-2">
            <LanguageSwitcher />
          </div>
        </header>
        <main className="px-5 pb-10 pt-2 md:px-8 md:pb-12">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
