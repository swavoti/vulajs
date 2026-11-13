import React, { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    VulaStream?: {
      mount: (
        container: HTMLElement,
        options: {
          surface: string;
          params?: Record<string, unknown>;
          onReady?: (info: { transport: string; codec: string; width: number; height: number }) => void;
          onError?: (err: Error) => void;
        }
      ) => { destroy: () => void };
    };
    __vulaStreamLoader?: Promise<void>;
  }
}

function loadStreamClient(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.VulaStream) return Promise.resolve();
  if (!window.__vulaStreamLoader) {
    window.__vulaStreamLoader = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/_vula/stream/client.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        window.__vulaStreamLoader = undefined;
        reject(new Error('Failed to load Vula WebRTC stream client'));
      };
      document.head.appendChild(script);
    });
  }
  return window.__vulaStreamLoader;
}

export type VulaStreamSurfaceProps = {
  surface: string;
  params?: Record<string, unknown>;
  active?: boolean;
  className?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
  onReady?: (info: { transport: string; codec: string; width: number; height: number }) => void;
  onError?: (err: Error) => void;
};

/**
 * On-demand WebRTC / WebCodecs frame stream surface.
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
}: VulaStreamSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !containerRef.current) return;
    let cancelled = false;
    let instance: { destroy: () => void } | null = null;

    loadStreamClient()
      .then(() => {
        if (cancelled || !containerRef.current || !window.VulaStream) return;
        instance = window.VulaStream.mount(containerRef.current, {
          surface,
          params,
          onReady: (info) => {
            if (!cancelled) setReady(true);
            onReady?.(info);
          },
          onError: (err) => {
            if (!cancelled) setError(err.message);
            onError?.(err);
          },
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      cancelled = true;
      setReady(false);
      instance?.destroy();
    };
  }, [surface, active, JSON.stringify(params || {})]);

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '320px',
        background: '#050509',
        ...style,
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {!ready && !error && fallback ? (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{fallback}</div>
      ) : null}
      {error ? (
        <div
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#fca5a5',
            fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            fontSize: '0.85rem',
            padding: '1rem',
            background: 'rgba(10, 10, 15, 0.9)',
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
