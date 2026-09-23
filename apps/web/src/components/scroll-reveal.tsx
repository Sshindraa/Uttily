'use client';

import * as React from 'react';
import styles from './scroll-reveal.module.css';

export interface ScrollRevealProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
  as?: React.ElementType | undefined;
  delay?: number | undefined;
  duration?: number | undefined;
  offset?: number | undefined;
  blur?: number | undefined;
  threshold?: number | undefined;
  rootMargin?: string | undefined;
  once?: boolean | undefined;
  className?: string | undefined;
}

/**
 * ScrollReveal: reveals content with a smooth vertical fade-up and progressive unblur
 * as it enters the viewport. Works in synergy with Lenis smooth inertial scrolling.
 */
export function ScrollReveal({
  children,
  as: Component = 'div',
  delay = 0,
  duration = 650,
  offset = 16,
  blur = 0,
  threshold = 0.08,
  rootMargin = '0px 0px -20px 0px',
  once = true,
  className = '',
  style,
  ...props
}: ScrollRevealProps): React.ReactElement {
  const ref = React.useRef<HTMLElement | null>(null);
  const [isRevealed, setIsRevealed] = React.useState(false);

  React.useEffect(() => {
    if (once && isRevealed) return;

    const el = ref.current;
    if (!el) return;

    // Respect reduced motion preference
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      setIsRevealed(true);
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      setIsRevealed(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          setIsRevealed(true);
          if (once) {
            observer.unobserve(el);
          }
        } else if (!once) {
          setIsRevealed(false);
        }
      },
      {
        threshold,
        rootMargin,
      },
    );

    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, [threshold, rootMargin, once, isRevealed]);

  const customStyle: React.CSSProperties = {
    ...style,
    '--reveal-delay': `${delay}ms`,
    '--reveal-duration': `${duration}ms`,
    '--reveal-offset': `${offset}px`,
    '--reveal-blur': `${blur}px`,
  } as React.CSSProperties;

  return (
    <Component
      ref={ref}
      className={`${className ? `${className} ` : ''}${styles.reveal} ${isRevealed ? styles.revealed : ''}`}
      style={customStyle}
      {...props}
    >
      {children}
    </Component>
  );
}
