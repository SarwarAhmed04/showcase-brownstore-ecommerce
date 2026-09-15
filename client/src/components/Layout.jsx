import { useEffect, useLayoutEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Backdrop from "./Backdrop";
import Footer from "./Footer";
import MobileNav from "./MobileNav";
import Navbar from "./Navbar";
import QuickView from "./QuickView";
import SearchOverlay from "./SearchOverlay";
import { ConnectionError } from "./ui";
import { Toaster } from "@/components/ui/sonner";
import { useCatalog } from "../lib/catalogStore";
import { useLang } from "../context/LangContext";

export default function Layout() {
  const { pathname, hash } = useLocation();
  const { status, error, refresh } = useCatalog();
  const { t } = useLang();

  useLayoutEffect(() => {
    if (!hash) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname, hash]);

  useEffect(() => {
    if (!hash) return;
    const el = document.querySelector(hash);
    if (el) setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }, [hash, pathname]);

  return (
    <>
      <Backdrop />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[100] focus:rounded-pill focus:bg-primary focus:px-5 focus:py-2.5 focus:text-sm focus:font-bold focus:text-primary-foreground"
      >
        {t.skipToContent || "Skip to content"}
      </a>

      <div className="flex min-h-screen flex-col">
        <Navbar />
        <main id="main" className="flex-1">
          {status === "error" ? <ConnectionError error={error} onRetry={refresh} /> : <Outlet />}
        </main>
        <Footer />
      </div>

      <MobileNav />
      <QuickView />
      <SearchOverlay />
      <Toaster position="bottom-right" closeButton richColors={false} />
    </>
  );
}
