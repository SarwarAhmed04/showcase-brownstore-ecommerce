import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getCookie, setCookie } from './cookies'

/* -------------------------------------------------------------------- cookies
   Wrapped in try/catch: private windows and blocked cookies both throw on
   access, and a saved-items list is never worth taking the page down for. */
export function useCookieState(key, initial, maxAgeSec) {
  const [value, setValue] = useState(() => {
    try {
      const raw = getCookie(key)
      return raw ? JSON.parse(raw) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      setCookie(key, JSON.stringify(value), maxAgeSec)
    } catch {
      /* cookies unavailable — keep the in-memory value */
    }
  }, [key, value, maxAgeSec])

  return [value, setValue]
}

export const SAVED_LIMIT = 10
const SAVED_MAX_AGE_SEC = 60 * 60 * 24 * 7

function trimSaved(ids) {
  return ids.map(String).slice(-SAVED_LIMIT)
}

/* ------------------------------------------------------- saved / wishlist */
export function useSaved() {
  const [ids, setIds] = useCookieState('bs:saved', [], SAVED_MAX_AGE_SEC)
  const list = trimSaved(ids)

  useEffect(() => {
    if (ids.length > SAVED_LIMIT) setIds(trimSaved(ids))
  }, [ids, setIds])

  const has = useCallback((id) => list.includes(String(id)), [list])
  const toggle = useCallback(
    (id) =>
      setIds((cur) => {
        const sid = String(id)
        const next = cur.map(String)
        if (next.includes(sid)) return next.filter((x) => x !== sid)
        return trimSaved([...next, sid])
      }),
    [setIds],
  )
  return { ids: list, has, toggle, count: list.length }
}

/* ------------------------------------------------- scroll-reveal on mount
   Reveal-on-scroll is decoration, so it must never be the only path to a
   visible page. Three guarantees, in order:
     1. reduced-motion, or no IntersectionObserver  -> show immediately
     2. already within the viewport at mount        -> show immediately
     3. observer never fires (background/hidden tab,
        throttled rAF, bfcache restore)             -> show after a timeout
   Anything else and the observer handles it normally. */
const REVEAL_FALLBACK_MS = 1200

export function useReveal() {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const show = () => el.classList.add('in')

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced || !('IntersectionObserver' in window)) {
      show()
      return
    }

    // Already on screen when mounted — no need to wait for a scroll.
    const box = el.getBoundingClientRect()
    if (box.top < window.innerHeight && box.bottom > 0) {
      show()
      return
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          show()
          io.disconnect()
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    )
    io.observe(el)

    // Safety net: if nothing has fired by now, stop hiding the content.
    const failsafe = setTimeout(() => {
      show()
      io.disconnect()
    }, REVEAL_FALLBACK_MS)

    return () => {
      clearTimeout(failsafe)
      io.disconnect()
    }
  }, [])

  return ref
}

/* --------------------------------------------- has the page scrolled past N */
export function useScrolled(threshold = 12) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold])
  return scrolled
}

/* ------------------------------------------------- lock body scroll (modals) */
export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return
    const html = document.documentElement
    const body = document.body
    const prevHtml = html.style.overflow
    const prevBody = body.style.overflow
    const prevPad = body.style.paddingRight
    const gap = window.innerWidth - html.clientWidth
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    if (gap > 0) body.style.paddingRight = `${gap}px`

    const allowInside = (target) =>
      target instanceof Element && target.closest('[data-scroll-lock-ignore]')

    const block = (event) => {
      if (allowInside(event.target)) return
      event.preventDefault()
    }

    window.addEventListener('wheel', block, { passive: false })
    window.addEventListener('touchmove', block, { passive: false })

    return () => {
      html.style.overflow = prevHtml
      body.style.overflow = prevBody
      body.style.paddingRight = prevPad
      window.removeEventListener('wheel', block)
      window.removeEventListener('touchmove', block)
    }
  }, [active])
}

/* ---------------------------------------------------------- close on Escape */
export function useEscape(handler, active = true) {
  useEffect(() => {
    if (!active) return
    const onKey = (e) => e.key === 'Escape' && handler()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handler, active])
}

/* --------------------------------------------------------- media query hook */
// useSyncExternalStore keeps this in step with the browser without an effect
// that re-renders on mount, and gives the right answer on the first paint.
export function useMedia(query) {
  const subscribe = useCallback(
    (onChange) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false, // server / pre-hydration: assume the narrow layout
  )
}
