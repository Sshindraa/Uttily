'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

export interface SmoothScrollProps {
  children?: React.ReactNode;
}

/**
 * SmoothScroll component using Lenis.
 * Replicates the exact momentum / inertial smooth scrolling of https://www.orbix.studio/
 * Configuration:
 * - lerp: 0.08 (creates the prolonged, elegant gliding inertia)
 * - smoothWheel: true (intercepts and cushions mouse wheel movements)
 * - syncTouch: false (preserves 100% native responsiveness on mobile touch screens)
 */
export function SmoothScroll({ children }: SmoothScrollProps): React.ReactElement {
  const pathname = usePathname();
  const lenisRef = React.useRef<Lenis | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    // Respect prefers-reduced-motion for accessibility
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      return;
    }

    const lenis = new Lenis({
      lerp: 0.08,
      smoothWheel: true,
      syncTouch: false,
    });

    lenisRef.current = lenis;

    let rafId: number;
    function raf(time: number): void {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }

    rafId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, []);

  // Reset scroll to top on pathname changes
  React.useEffect(() => {
    if (lenisRef.current) {
      lenisRef.current.scrollTo(0, { immediate: true });
    }
  }, [pathname]);

  return <>{children}</>;
}
