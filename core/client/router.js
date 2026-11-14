import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { decompressVulaPayload, getVulaRouteMatcher } from './wasm-router.js';

const NavigationContext = createContext(null);
let registeredRouteLoader = null;

/**
 * Registers the app-level dynamic importer so route chunks resolve relative to the user's @app alias.
 */
export function registerVulaRouteLoader(loader) {
  registeredRouteLoader = typeof loader === 'function' ? loader : null;
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export async function matchVulaRoute(routes, pathname) {
  const matcher = await getVulaRouteMatcher(routes);
  const route = matcher.match(pathname);
  if (!route) return null;
  const params = getVulaRouteParams(route.path, pathname);
  return params ? { route, params } : null;
}

export function getVulaRouteParams(routePath, pathname) {
  const patternSegments = routePath.split('/').filter(Boolean);
  const pathSegments = [];
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return null;
  const encodedSegments = pathname.slice(1).split('/');
  if (encodedSegments.length === 1 && encodedSegments[0] === '') encodedSegments.length = 0;
  else if (encodedSegments[encodedSegments.length - 1] === '') encodedSegments.pop();
  if (encodedSegments.some((segment) => segment === '')) return null;
  try {
    for (const segment of encodedSegments) {
      pathSegments.push(decodeURIComponent(segment));
    }
  } catch {
    return null;
  }

  const params = {};
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

export async function loadVulaRoute(route) {
  if (!registeredRouteLoader) {
    throw new Error('Vula route loader has not been initialized via bootstrapVula()');
  }
  const pageModule = await registeredRouteLoader(route.clientPath);
  return pageModule.default ?? pageModule;
}

export function VulaLink({
  page,
  onClick,
  target,
  download,
  children,
  ...anchorProps
}) {
  const navigate = useContext(NavigationContext);

  return React.createElement(
    'a',
    {
      ...anchorProps,
      href: page,
      'data-vula-link': '',
      target,
      download,
      onClick: (event) => {
        if (onClick) onClick(event);
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
        event.preventDefault();
        if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;

        void navigate(`${destination.pathname}${destination.search}${destination.hash}`).catch((error) => {
          if (error?.name !== 'AbortError') {
            console.error('[vula] Client navigation failed; falling back to document navigation.', error);
            window.location.assign(destination.href);
          }
        });
      },
    },
    children
  );
}

export function VulaRouter({ initialPage, layout: Layout = React.Fragment }) {
  const [page, setPage] = useState(initialPage);
  const activeRequest = useRef(null);
  const requestId = useRef(0);

  const navigate = useCallback(async (destination, options = {}) => {
    const url = new URL(destination, window.location.href);
    if (url.origin !== window.location.origin) {
      window.location.assign(url.href);
      return;
    }

    if (activeRequest.current) activeRequest.current.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const id = ++requestId.current;
    const navStartMs = Date.now();

    if (!options.isHmr && typeof console !== 'undefined' && console.log) {
      console.log(`[vula] compiling ${url.pathname}...`);
    }

    const response = await fetch(`/_vula/route?path=${encodeURIComponent(`${url.pathname}${url.search}`)}`, {
      cache: 'no-store',
      headers: { Accept: 'text/html' },
      signal: controller.signal,
    });
    if (id !== requestId.current) return;
    if (response.status === 404) {
      window.location.assign(url.href);
      return;
    }
    if (!response.ok) {
      throw new Error(`Vula route request failed (${response.status})`);
    }

    const routePath = response.headers.get('x-vula-route-path');
    const routeClientPath = response.headers.get('x-vula-route-client-path');
    const serverCompileMs = response.headers.get('x-vula-compile-ms');
    if (!routePath || !routeClientPath) {
      throw new Error('Vula route response missing route metadata');
    }
    const route = { path: routePath, clientPath: routeClientPath };
    const params = getVulaRouteParams(route.path, url.pathname);
    if (!params) {
      throw new Error(`Vula route parameters could not be resolved for ${url.pathname}`);
    }

    const [responseBytes, Component] = await Promise.all([
      response.arrayBuffer().then((buf) => new Uint8Array(buf)),
      loadVulaRoute(route),
    ]);
    if (id !== requestId.current) return;

    const html = response.headers.get('x-vula-compression') === 'lzss-1'
      ? new TextDecoder().decode(await decompressVulaPayload(responseBytes))
      : new TextDecoder().decode(responseBytes);
    if (id !== requestId.current) return;

    const totalMs = serverCompileMs || String(Date.now() - navStartMs);
    if (typeof console !== 'undefined' && console.log) {
      console.log(`[vula] compiled ${url.pathname} in ${totalMs}ms`);
    }

    if (options.history !== false) {
      const method = options.replace ? 'replaceState' : 'pushState';
      window.__vulaNavigationInProgress = true;
      try {
        window.history[method]({}, '', `${url.pathname}${url.search}${url.hash}`);
      } finally {
        window.__vulaNavigationInProgress = false;
      }
    }

    window.dispatchEvent(new CustomEvent('vula:navigate', {
      detail: { path: `${url.pathname}${url.search}${url.hash}` },
    }));

    setPage({ route, params, Component, html });

    if (options.preserveScroll) {
      return;
    }
    if (url.hash) {
      setTimeout(() => {
        const targetId = decodePathSegment(url.hash.slice(1)) || '';
        const targetEl = document.getElementById(targetId);
        if (targetEl) targetEl.scrollIntoView();
      }, 0);
    } else {
      window.scrollTo(0, 0);
    }
  }, []);

  useEffect(() => {
    window.__vulaNavigate = navigate;
    window.__vulaHmrRefresh = () => {
      void navigate(window.location.href, { history: false, preserveScroll: true, isHmr: true }).catch(() => {});
    };
    const onPopState = () => {
      window.dispatchEvent(new CustomEvent('vula:navigate', {
        detail: { path: `${window.location.pathname}${window.location.search}${window.location.hash}` },
      }));
      void navigate(window.location.href, { history: false }).catch((error) => {
        if (error?.name !== 'AbortError') {
          console.error('[vula] Back/forward navigation failed; reloading the current route.', error);
          window.location.reload();
        }
      });
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      if (activeRequest.current) activeRequest.current.abort();
      window.removeEventListener('popstate', onPopState);
    };
  }, [navigate]);

  return React.createElement(
    NavigationContext.Provider,
    { value: navigate },
    React.createElement(
      Layout,
      null,
      React.createElement(
        'div',
        { id: 'vula-page-root' },
        React.createElement(page.Component, { params: page.params })
      )
    )
  );
}
