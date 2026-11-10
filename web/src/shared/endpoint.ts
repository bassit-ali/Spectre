/**
 * Single source of truth for where the SPECTRE local server lives.
 * The server itself is NOT part of this project (UI only).
 *
 * Override at build/dev time with:  VITE_SPECTRE_HTTP=http://127.0.0.1:9000
 */
const envHttp = (import.meta.env?.VITE_SPECTRE_HTTP as string | undefined)?.replace(/\/+$/, '');

export const LOCAL_HTTP = envHttp || 'http://127.0.0.1:9000';
export const LOCAL_WS = LOCAL_HTTP.replace(/^http/i, 'ws') + '/ws';

/** Text shown in every endpoint chip: `LOCAL http://127.0.0.1:9000` */
export const ENDPOINT_CHIP_TEXT = `LOCAL ${LOCAL_HTTP}`;

/** Where the server is expected to serve the two pages (assumed - adjust when the server exists). */
export const CONSOLE_URL = `${LOCAL_HTTP}/`;
export const WIDGET_URL = `${LOCAL_HTTP}/widget.html`;

export const PRODUCT = {
  name: 'SPECTRE',
  subtitle: 'PAN-TILT PEDESTAL CONTROLLER',
  credit: '26 SIG BN R&D WING',
  version: __APP_VERSION__,
} as const;
