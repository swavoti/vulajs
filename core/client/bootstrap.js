import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import {
  VulaRouter,
  getVulaRouteParams,
  loadVulaRoute,
  registerVulaRouteLoader,
} from './router.js';

export class Vula {
  static async server(name, ...args) {
    const res = await fetch('/_vula/server-component', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server component "${name}" failed`);
    }
    const { result } = await res.json();
    return result;
  }

  static async api(path, options = {}) {
    const url = path.startsWith('/') ? path : `/api/${path}`;
    const res = await fetch(url, options);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `API ${path} returned ${res.status}`);
    }
    return res.json();
  }
}

class ErrorOverlay extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (typeof console !== 'undefined' && console.error) {
      console.error(error);
    }
  }

  render() {
    if (this.state.error) {
      return null;
    }
    return this.props.children;
  }
}

/**
 * Hydrates the single server-matched route into #root inside the framework runtime.
 */
export async function bootstrapVula({ Layout = React.Fragment, loadRoute }) {
  const bootStartMs = Date.now();
  registerVulaRouteLoader(loadRoute);
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Vula could not find the #root container');
  rootElement.setAttribute('data-vula-dom', 'incoming');
  const routePath = rootElement.dataset.vulaRoutePath;
  const routeClientPath = rootElement.dataset.vulaRouteClientPath;
  const route = routePath && routeClientPath
    ? { path: routePath, clientPath: routeClientPath }
    : undefined;
  if (!route) throw new Error('Vula could not resolve the server-rendered route');
  const params = getVulaRouteParams(route.path, window.location.pathname);
  if (!params) throw new Error('Vula could not resolve route parameters for the server-rendered page');
  const Component = await loadVulaRoute(route);
  const initialPage = { route, params, Component };

  hydrateRoot(
    rootElement,
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        ErrorOverlay,
        null,
        React.createElement(VulaRouter, { initialPage, layout: Layout })
      )
    )
  );
  rootElement.setAttribute('data-vula-dom', 'ready');
  if (typeof console !== 'undefined' && console.log) {
    console.log(`[vula] interactive DOM ready (${window.location.pathname}) in ${Date.now() - bootStartMs}ms`);
  }
}
