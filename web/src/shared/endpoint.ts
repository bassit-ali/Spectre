/**
 * Single source of truth for where the SPECTRE local server lives.
 * User-facing UI shows port only (no host/IP). Wire URLs derive from
 * the page origin when served by SPECTRE, or from VITE_SPECTRE_HTTP in dev.
 */

export const HTTP_PORT_MIN = 9000;
export const HTTP_PORT_MAX = 15000;
export const DEFAULT_HTTP_PORT = 9000;

const envHttp = (import.meta.env?.VITE_SPECTRE_HTTP as string | undefined)?.replace(/\/+$/, '');

function parsePortFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes('://') ? url : `http://${url}`);
    const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Clamp operator-selected listen port into the supported range. */
export function clampHttpPort(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_HTTP_PORT;
  return Math.max(HTTP_PORT_MIN, Math.min(HTTP_PORT_MAX, Math.round(n)));
}

/**
 * Prefer same-origin when the UI is served by SPECTRE so a saved httpPort
 * after restart is picked up without a rebuild. Fall back to build-time env.
 */
export function resolveLocalHttp(): string {
  if (typeof window !== 'undefined' && window.location?.protocol?.startsWith('http')) {
    const { protocol, hostname, port } = window.location;
    // file:// or empty host → fall through
    if (hostname) {
      const hostPort = port ? `${hostname}:${port}` : hostname;
      return `${protocol}//${hostPort}`.replace(/\/+$/, '');
    }
  }
  return envHttp || `http://127.0.0.1:${DEFAULT_HTTP_PORT}`;
}

export function resolveLocalWs(): string {
  const http = resolveLocalHttp();
  return http.replace(/^http/i, 'ws') + '/ws';
}

export function resolveHttpPort(): number {
  if (typeof window !== 'undefined' && window.location?.port) {
    const p = Number(window.location.port);
    if (Number.isFinite(p) && p >= HTTP_PORT_MIN && p <= HTTP_PORT_MAX) return p;
  }
  const fromEnv = parsePortFromUrl(envHttp);
  if (fromEnv != null) return clampHttpPort(fromEnv);
  return DEFAULT_HTTP_PORT;
}

/** @deprecated Prefer resolveLocalHttp() — kept for callers that import a constant. */
export const LOCAL_HTTP = resolveLocalHttp();
/** @deprecated Prefer resolveLocalWs() */
export const LOCAL_WS = resolveLocalWs();

/** Text shown in every endpoint chip — port only, no host/IP. */
export function endpointChipText(port: number = resolveHttpPort()): string {
  return `Available on port ${clampHttpPort(port)}`;
}

export const ENDPOINT_CHIP_TEXT = endpointChipText();

export const CONSOLE_URL = `${resolveLocalHttp()}/`;
export const WIDGET_URL = `${resolveLocalHttp()}/widget.html`;

export const PRODUCT = {
  name: 'SPECTRE',
  subtitle: 'PAN-TILT PEDESTAL CONTROLLER',
  version: __APP_VERSION__,
} as const;
