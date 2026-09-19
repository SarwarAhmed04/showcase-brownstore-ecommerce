import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useEscape, useScrollLock } from "../../lib/hooks";

export default function AdminModal({ onClose, children }) {
  useScrollLock(true);
  useEscape(onClose);

  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return undefined;
    const prevInert = root.inert;
    const prevPointer = root.style.pointerEvents;
    const prevAria = root.getAttribute("aria-hidden");
    root.inert = true;
    root.style.pointerEvents = "none";
    root.setAttribute("aria-hidden", "true");
    return () => {
      root.inert = prevInert;
      root.style.pointerEvents = prevPointer;
      if (prevAria == null) root.removeAttribute("aria-hidden");
      else root.setAttribute("aria-hidden", prevAria);
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-brown/55" aria-hidden="true" />
      <div
        className="relative z-10 flex max-h-[92vh] w-full justify-center overflow-y-auto overscroll-contain"
        data-scroll-lock-ignore
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
