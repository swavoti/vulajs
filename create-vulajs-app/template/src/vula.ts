export class Vula {
  static async server(name: string, ...args: any[]) {
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

  static async api(path: string, options: RequestInit = {}) {
    const url = path.startsWith('/') ? path : `/api/${path}`;
    const res = await fetch(url, options);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `API ${path} returned ${res.status}`);
    }
    return res.json();
  }
}

export { VulaLink, VulaRouter, getVulaRouteParams, loadVulaRoute, matchVulaRoute } from './router';
export type { VulaPage, VulaRoute, VulaRouteMatch } from './router';
export { VulaStreamSurface } from './stream';
export type { VulaStreamSurfaceProps } from './stream';
