/**
 * Vula.js client-side bridge.
 * Connects your frontend to API routes and server components
 * running in the same codebase.
 */
export class Vula {
  /**
   * Call a server component by name.
   * Server components live in app/ as *.sever.comp.ts files.
   */
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

  /**
   * Call an API route. Maps short paths to /api/ prefix automatically.
   * Usage: Vula.api('hello') -> GET /api/hello
   *        Vula.api('/api/hello', { method: 'POST', body: ... })
   */
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
