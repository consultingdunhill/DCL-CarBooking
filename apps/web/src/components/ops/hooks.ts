import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

/** Current time, refreshed every `intervalMs` so "time ago" texts keep ticking. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** True while the media query matches (e.g. '(min-width: 768px)'). */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Width of an element in CSS pixels, kept up to date with a ResizeObserver.
 * Returns a callback ref, so it also works for elements that mount later.
 */
export function useElementWidth<T extends HTMLElement = HTMLDivElement>(): [(el: T | null) => void, number, RefObject<T | null>] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  const ref = useRef<T | null>(null);
  const setRef = useCallback((node: T | null) => {
    ref.current = node;
    setEl(node);
  }, []);
  useEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setRef, width, ref];
}

/** A value that only updates after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
