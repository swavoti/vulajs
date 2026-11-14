import React, { useEffect, useRef, useState } from 'react';

function loadStreamClient() {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.VulaStream) return Promise.resolve();
  if (!window.__vulaStreamLoader) {
    window.__vulaStreamLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/_vula/stream/client.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        window.__vulaStreamLoader = undefined;
        reject(new Error('Failed to load Vula stream client'));
      };
      document.head.appendChild(script);
    });
  }
  return window.__vulaStreamLoader;
}

/**
 * On-demand Vula server stream surface.
 * Keeps all surface logic strictly on the server while rendering live interactive frames.
 */
export function VulaStreamSurface({
  surface,
  params,
  active = true,
  className,
  style,
  fallback = null,
  onReady,
  onError,
}) {
  const containerRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!active || !containerRef.current) return;
    let cancelled = false;
    let instance = null;

    loadStreamClient()
      .then(() => {
        if (cancelled || !containerRef.current || !window.VulaStream) return;
        instance = window.VulaStream.mount(containerRef.current, {
          surface,
          params,
          onReady: (info) => {
            if (!cancelled) setReady(true);
            if (onReady) onReady(info);
          },
          onError: (err) => {
            if (!cancelled) setError(err.message);
            if (onError) onError(err);
          },
        });
      })
      .catch((err) => {
        const normalized = err instanceof Error ? err : new Error(String(err));
        if (!cancelled) setError(normalized.message);
        if (onError) onError(normalized);
      });

    return () => {
      cancelled = true;
      setReady(false);
      if (instance) instance.destroy();
    };
  }, [surface, active, JSON.stringify(params || {})]);

  return React.createElement(
    'div',
    {
      className,
      style: {
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '320px',
        background: '#050509',
        ...style,
      },
    },
    React.createElement('div', {
      ref: containerRef,
      'data-vula-stream': surface,
      style: { width: '100%', height: '100%' },
    }),
    !ready && !error && fallback
      ? React.createElement(
          'div',
          { style: { position: 'absolute', inset: 0, pointerEvents: 'none' } },
          fallback
        )
      : null,
    error
      ? React.createElement(
          'div',
          {
            role: 'alert',
            style: {
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: '#fca5a5',
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: '0.85rem',
              padding: '1rem',
              background: 'rgba(10, 10, 15, 0.9)',
            },
          },
          error
        )
      : null
  );
}
