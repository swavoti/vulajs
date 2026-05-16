import { useEffect } from 'react';

/**
 * Registers the Vula service worker for asset caching.
 * Drop <VulaCache /> anywhere in your app to enable it.
 */
export function VulaCache() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/vula-sw.js').catch(() => {});
    }
  }, []);

  return null;
}

export default VulaCache;
