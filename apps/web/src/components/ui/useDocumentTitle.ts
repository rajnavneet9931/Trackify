import { useEffect } from 'react';

/** Sets the browser tab title ("Page · Trackify") while the page is shown. */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · Trackify`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
