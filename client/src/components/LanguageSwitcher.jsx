import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLang } from "../context/LangContext";

const langs = [
  { id: "ku", label: "کوردی" },
  { id: "en", label: "EN" },
  { id: "ar", label: "عربي" },
];

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const SIZE_MOTION = [
  `width 0.4s ${EASE}`,
  `grid-template-columns 0.4s ${EASE}`,
  `column-gap 0.4s ${EASE}`,
  `padding 0.4s ${EASE}`,
].join(", ");
const SHELL_MOTION = `width 0.4s ${EASE}, box-shadow 0.34s ease`;

export default function LanguageSwitcher() {
  const { lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  const [filled, setFilled] = useState(true);
  const wrapRef = useRef(null);
  const shellRef = useRef(null);
  const trackRef = useRef(null);
  const closeTimer = useRef(null);
  const fillTimer = useRef(null);
  const measured = useRef(false);
  const current = langs.find((item) => item.id === lang) || langs[0];

  useEffect(() => {
    return () => {
      clearTimeout(closeTimer.current);
      clearTimeout(fillTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (!wrapRef.current?.contains(event.target)) close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const track = trackRef.current;
    if (!shell || !track) return;
    const buttons = [...track.querySelectorAll("button")];
    const widths = langs.map((item, i) => {
      const show = open || item.id === lang;
      return show ? buttons[i].scrollWidth : 0;
    });
    const visible = widths.filter((w) => w > 0).length;
    const gap = open ? 4 : 0;
    const pad = open ? 8 : 0;
    const total =
      widths.reduce((sum, w) => sum + w, 0) +
      Math.max(0, visible - 1) * gap +
      pad;

    track.style.gridTemplateColumns = widths.map((w) => `${w}px`).join(" ");
    track.style.columnGap = `${gap}px`;
    track.style.padding = open ? "4px" : "0px";
    if (!measured.current) {
      shell.style.transition = "none";
      track.style.transition = "none";
      shell.style.width = `${total}px`;
      shell.getBoundingClientRect();
      shell.style.transition = SHELL_MOTION;
      track.style.transition = SIZE_MOTION;
      measured.current = true;
      return;
    }
    shell.style.width = `${total}px`;
  }, [open, lang]);

  function show() {
    clearTimeout(closeTimer.current);
    clearTimeout(fillTimer.current);
    setFilled(false);
    setOpen(true);
  }

  function close() {
    clearTimeout(closeTimer.current);
    clearTimeout(fillTimer.current);
    setOpen(false);
    fillTimer.current = setTimeout(() => setFilled(true), 400);
  }

  function hideSoon() {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(close, 80);
  }

  function pick(id) {
    setLang(id);
    close();
  }

  return (
    <div
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
    >
      <span
        aria-hidden
        className="invisible pointer-events-none inline-flex h-7 items-center whitespace-nowrap rounded-full px-3 text-xs font-semibold"
      >
        {current.label}
      </span>
      <div
        ref={shellRef}
        className="absolute top-1/2 end-0 z-50 -translate-y-1/2 rounded-full"
        style={{
          boxShadow: filled
            ? "0 0 0 1px rgb(var(--stroke) / 0.2)"
            : "0 0 0 1px rgb(var(--stroke) / 0.28)",
          transition: SHELL_MOTION,
        }}
      >
        <div className="glass-soft relative w-full overflow-hidden rounded-full">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full bg-primary"
            style={{
              opacity: filled ? 1 : 0,
              transition: "opacity 0.34s ease",
            }}
          />
          <div
            ref={trackRef}
            className="relative z-10 inline-grid w-full items-center"
            style={{
              gridTemplateColumns: langs.map(() => "0px").join(" "),
              columnGap: "0px",
              padding: "0px",
              transition: SIZE_MOTION,
            }}
          >
            {langs.map((item) => {
              const active = item.id === lang;
              const shown = open || active;
              return (
                <div key={item.id} className="min-w-0 overflow-hidden rounded-full">
                  <button
                    type="button"
                    tabIndex={shown ? 0 : -1}
                    aria-hidden={!shown}
                    onClick={() => (active && !open ? show() : pick(item.id))}
                    className={`flex h-7 items-center justify-center whitespace-nowrap rounded-full px-3 text-xs font-semibold leading-none ${
                      active
                        ? filled
                          ? "text-primary-foreground"
                          : "bg-primary text-primary-foreground"
                        : "bg-transparent text-fg-mute hover:text-fg"
                    } ${shown ? "opacity-100" : "opacity-0"} ${
                      active ? "" : "transition-opacity duration-150 ease-out"
                    }`}
                  >
                    {item.label}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
