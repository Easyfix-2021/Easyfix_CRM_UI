'use client';
import { useEffect, useState } from 'react';

/*
 * Plain debounce hook — return a delayed copy of `value`. Used to turn
 * keystroke-level search inputs into a single API call after typing settles.
 * 300ms is the sweet spot for search UIs: long enough to skip intermediate
 * keystrokes, short enough that the user still feels the list responding.
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [out, setOut] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return out;
}
