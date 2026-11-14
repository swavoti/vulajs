import type React from 'react';

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

export type BootstrapVulaOptions = {
  Layout?: React.ComponentType<{ children?: React.ReactNode }>;
  loadRoute: (clientPath: string) => Promise<any>;
};

export class Vula {
  static server(name: string, ...args: any[]): Promise<any>;
  static api(path: string, options?: RequestInit): Promise<any>;
}

export function bootstrapVula(options: BootstrapVulaOptions): Promise<void>;
export function registerVulaRouteLoader(loader: (clientPath: string) => Promise<any>): void;
export function matchVulaRoute(routes: VulaRoute[], pathname: string): Promise<VulaRouteMatch | null>;
export function getVulaRouteParams(routePath: string, pathname: string): Record<string, string> | null;
export function loadVulaRoute(route: VulaRoute): Promise<React.ComponentType<any>>;
export function VulaLink(
  props: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
    page: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  }
): React.ReactElement;
export function VulaRouter(props: {
  routes?: VulaRoute[];
  initialPage: VulaPage;
  layout?: React.ComponentType<{ children?: React.ReactNode }>;
}): React.ReactElement;
export function VulaStreamSurface(props: VulaStreamSurfaceProps): React.ReactElement;
export function decompressVulaPayload(input: Uint8Array): Promise<Uint8Array>;
export function getVulaRouteMatcher(routes: VulaRoute[]): Promise<{
  match(pathname: string): VulaRoute | null;
  decompress(input: Uint8Array): Uint8Array;
}>;
