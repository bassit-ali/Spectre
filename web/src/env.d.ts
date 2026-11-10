/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SPECTRE_HTTP?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
