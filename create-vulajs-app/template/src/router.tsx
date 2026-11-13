import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { getVulaRouteMatcher } from './wasm-router';

export type VulaRoute = {
  path: string;
  clientPath: string;
};

export type VulaRouteMatch = {
  route: VulaRoute;
  params: Record<string, string>;
};

export type VulaPage = VulaRouteMatch & {
  Component: React.ComponentType<any>;
  html?: string;
};

type NavigateOptions = {
  history?: boolean;
  replace?: boolean;
};

type VulaRouterProps = {
  routes: VulaRoute[];
  initialPage: VulaPage;
  layout?: React.ComponentType<{ children?: React.ReactNode }>;
};

const NavigationContext = createContext<((page: string, options?: NavigateOptions) => Promise<void>) | null>(null);

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export async function matchVulaRoute(routes: VulaRoute[], pathname: string): Promise<VulaRouteMatch | null> {
  const matcher = await getVulaRouteMatcher(routes);
  const route = matcher.match(pathname);
  if (!route) return null;
  const params = getVulaRouteParams(route.path, pathname);
  return params ? { route, params } : null;
}

export function getVulaRouteParams(routePath: string, pathname: string): Record<string, string> | null {
  const patternSegments = routePath.split('/').filter(Boolean);
  const pathSegments: string[] = [];
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return null;
  const encodedSegments = pathname.slice(1).split('/');
  if (encodedSegments.length === 1 && encodedSegments[0] === '') encodedSegments.length = 0;
  else if (encodedSegments[encodedSegments.length - 1] === '') encodedSegments.pop();
  if (encodedSegments.some((segment) => segment === '')) return null;
  try {
    for (const segment of encodedSegments) {
      const decoded = decodeURIComponent(segment);
      pathSegments.push(decoded);
    }
  } catch {
    return null;
  }

  const params: Record<string, string> = {};
  let pathIndex = 0;
  for (const pattern of patternSegments) {
    if (pattern.startsWith('*')) {
      params[pattern.slice(1) || 'wildcard'] = pathSegments.slice(pathIndex).join('/');
      pathIndex = pathSegments.length;
      break;
    }
    if (pathIndex >= pathSegments.length) return null;
    if (pattern.startsWith(':')) params[pattern.slice(1)] = pathSegments[pathIndex];
    pathIndex += 1;
  }
  return pathIndex === pathSegments.length ? params : null;
}

export async function loadVulaRoute(route: VulaRoute): Promise<React.ComponentType<any>> {
  const pageModule = await import(/* webpackInclude: /page\.(tsx|jsx)$/ */ `@app/${route.clientPath}`);
  return pageModule.default ?? pageModule;
}

export function VulaLink({
  page,
  onClick,
  target,
  download,
  children,
  ...anchorProps
}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
  page: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
}) {
  const navigate = useContext(NavigationContext);

  return (
    <a
      {...anchorProps}
      href={page}
      data-vula-link=""
      target={target}
      download={download}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          !navigate ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          target ||
          download
        ) {
          return;
        }

        const destination = new URL(page, window.location.href);
        if (destination.origin !== window.location.origin) return;
        if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;

        event.preventDefault();
        void navigate(`${destination.pathname}${destination.search}${destination.hash}`).catch((error) => {
          if (error?.name !== 'AbortError') {
            console.error('[vula] Client navigation failed; falling back to document navigation.', error);
            window.location.assign(destination.href);
          }
        });
      }}
    >
      {children}
    </a>
  );
}

export function VulaRouter({ routes, initialPage, layout: Layout = React.Fragment }: VulaRouterProps) {
  const [page, setPage] = useState(initialPage);
  const pageRoot = useRef<Root | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const requestId = useRef(0);

  const navigate = useCallback(async (destination: string, options: NavigateOptions = {}) => {
    const url = new URL(destination, window.location.href);
    if (url.origin !== window.location.origin) {
      window.location.assign(url.href);
      return;
    }

    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const id = ++requestId.current;
    const routeRequest = fetch(`/_vula/route?path=${encodeURIComponent(`${url.pathname}${url.search}`)}`, {
      headers: { Accept: 'text/html' },
      signal: controller.signal,
    }).then(
      (response) => ({ response }),
      (error: Error) => ({ error })
    );

    let routeMatch: VulaRouteMatch | null;
    try {
      routeMatch = await matchVulaRoute(routes, url.pathname);
    } catch (error) {
      controller.abort();
      throw error;
    }
    if (id !== requestId.current) return;
    if (!routeMatch) {
      controller.abort();
      window.location.assign(url.href);
      return;
    }

    const requestResult = await routeRequest;
    if ('error' in requestResult) throw requestResult.error;
    const [response, Component] = await Promise.all([
      Promise.resolve(requestResult.response),
      loadVulaRoute(routeMatch.route),
    ]);
    if (!response.ok) {
      throw new Error(`Vula route request failed (${response.status})`);
    }
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    const html = response.headers.get('x-vula-compression') === 'lzss-1'
      ? new TextDecoder().decode((await getVulaRouteMatcher(routes)).decompress(responseBytes))
      : new TextDecoder().decode(responseBytes);
    if (id !== requestId.current) return;

    pageRoot.current?.unmount();
    pageRoot.current = null;
    setPage({ ...routeMatch, Component, html });

    if (options.history !== false) {
      const method = options.replace ? 'replaceState' : 'pushState';
      (window as Window & { __vulaNavigationInProgress?: boolean }).__vulaNavigationInProgress = true;
      try {
        window.history[method]({}, '', `${url.pathname}${url.search}${url.hash}`);
      } finally {
        (window as Window & { __vulaNavigationInProgress?: boolean }).__vulaNavigationInProgress = false;
      }
    }

    if (url.hash) {
      requestAnimationFrame(() => {
        document.getElementById(decodePathSegment(url.hash.slice(1)) || '')?.scrollIntoView();
      });
    } else {
      window.scrollTo(0, 0);
    }
  }, [routes]);

  useEffect(() => {
    const onPopState = () => {
      void navigate(window.location.href, { history: false }).catch((error) => {
        if (error?.name !== 'AbortError') {
          console.error('[vula] Back/forward navigation failed; reloading the current route.', error);
          window.location.reload();
        }
      });
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      activeRequest.current?.abort();
      window.removeEventListener('popstate', onPopState);
    };
  }, [navigate]);

  useEffect(() => {
    if (page.html === undefined) return;
    const container = document.getElementById('vula-page-root');
    if (!container || pageRoot.current) return;
    pageRoot.current = hydrateRoot(
      container,
      <NavigationContext.Provider value={navigate}>
        <page.Component params={page.params} />
      </NavigationContext.Provider>
    );
  }, [navigate, page]);

  return (
    <NavigationContext.Provider value={navigate}>
      <Layout>
        <div
          id="vula-page-root"
          {...(page.html === undefined ? {} : { dangerouslySetInnerHTML: { __html: page.html } })}
        >
          {page.html === undefined ? <page.Component params={page.params} /> : null}
        </div>
      </Layout>
    </NavigationContext.Provider>
  );
}
