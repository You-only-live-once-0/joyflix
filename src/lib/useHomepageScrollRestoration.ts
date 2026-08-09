import { RefObject, useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'homepageScrollPosition';
const CLEAR_EVENT = 'clearHomepageScroll';

export function useHomepageScrollRestoration(
  scrollContainerRef: RefObject<HTMLElement>
) {
  const getActualScrollContainer = useCallback(() => {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    return isMobile ? document.body : scrollContainerRef.current;
  }, [scrollContainerRef]);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scrollContainer = getActualScrollContainer();
    if (!scrollContainer) return;

    const savedPosition = sessionStorage.getItem(STORAGE_KEY);
    if (savedPosition) {
      const position = Number.parseInt(savedPosition, 10);
      if (Number.isFinite(position)) {
        scrollContainer.scrollTo(0, position);
      }
    }

    const handleScroll = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        sessionStorage.setItem(
          STORAGE_KEY,
          scrollContainer.scrollTop.toString()
        );
      }, 150);
    };

    const handleClearScroll = () => {
      sessionStorage.removeItem(STORAGE_KEY);
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener(CLEAR_EVENT, handleClearScroll);

    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      window.removeEventListener(CLEAR_EVENT, handleClearScroll);

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (scrollContainer.scrollTop > 0) {
        sessionStorage.setItem(
          STORAGE_KEY,
          scrollContainer.scrollTop.toString()
        );
      }
    };
  }, [getActualScrollContainer]);
}
