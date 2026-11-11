import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Launch / stop the always-on-top Electron pip-shell that hosts widget.html
 * as a real Windows desktop overlay (not a browser popup).
 */
export class PipShellManager {
  private child: ChildProcess | null = null;
  private starting = false;

  constructor(
    private readonly projectRoot: string,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void,
    private readonly widgetUrl: string,
    private readonly getAutoDock: () => boolean = () => true,
    private readonly getPinned: () => boolean = () => true,
    private readonly getOpacity: () => number = () => 0.95,
  ) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode == null && !this.child.killed;
  }

  async open(): Promise<{ ok: boolean; detail: string }> {
    if (this.running) {
      this.log('info', 'pip-shell already running');
      return { ok: true, detail: 'already running' };
    }
    if (this.starting) return { ok: true, detail: 'starting' };
    // Headless Linux/systemd has no desktop session — browser widget still works.
    if (
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
    ) {
      return { ok: false, detail: 'no display — open the widget page on the SPECTRE listen port' };
    }
    this.starting = true;
    try {
      const pipDir = path.join(this.projectRoot, 'pip-shell');
      const mainJs = path.join(pipDir, 'main.js');
      if (!fs.existsSync(mainJs)) {
        const detail = `pip-shell missing at ${pipDir}`;
        this.log('warn', detail);
        return { ok: false, detail };
      }

      const electronExec = resolveElectron(pipDir, this.projectRoot);
      if (!electronExec) {
        const detail =
          'Electron binary not found. Run: npm --prefix pip-shell install';
        this.log('warn', detail);
        return { ok: false, detail };
      }

      const url = this.widgetUrl.includes('?')
        ? `${this.widgetUrl}&bg=transparent`
        : `${this.widgetUrl}?bg=transparent`;

      const opacity = Math.max(0.4, Math.min(1, Number(this.getOpacity()) || 0.95));
      this.log(
        'info',
        `starting pip-shell (auto-dock=${this.getAutoDock() ? 'on' : 'off'} pin=${this.getPinned() ? 'on' : 'off'} opacity=${opacity})`,
      );
      const child = spawn(electronExec, ['.'], {
        cwd: pipDir,
        env: {
          ...process.env,
          SPECTRE_WIDGET_URL: url,
          SPECTRE_WIDGET_AUTO_DOCK: this.getAutoDock() ? '1' : '0',
          SPECTRE_WIDGET_PINNED: this.getPinned() ? '1' : '0',
          SPECTRE_WIDGET_OPACITY: String(opacity),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      });
      this.child = child;

      child.stdout?.on('data', (buf) => {
        const line = String(buf).trim();
        if (line) this.log('info', `pip-shell: ${line}`);
      });
      child.stderr?.on('data', (buf) => {
        const line = String(buf).trim();
        if (line) this.log('warn', `pip-shell: ${line}`);
      });
      child.on('exit', (code, signal) => {
        this.log('info', `pip-shell exited code=${code} signal=${signal ?? '-'}`);
        if (this.child === child) this.child = null;
      });
      child.on('error', (err) => {
        this.log('error', `pip-shell spawn error: ${err.message}`);
        if (this.child === child) this.child = null;
      });

      return { ok: true, detail: 'started' };
    } finally {
      this.starting = false;
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode != null) return;
    this.log('info', 'stopping pip-shell');
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 1500).unref();
      }
    } catch (err) {
      this.log('warn', `pip-shell stop failed: ${String(err)}`);
    }
  }
}

function resolveElectron(pipDir: string, projectRoot: string): string | null {
  const pkgDirs = [
    path.join(pipDir, 'node_modules', 'electron'),
    path.join(projectRoot, 'node_modules', 'electron'),
  ];
  for (const dir of pkgDirs) {
    const indexJs = path.join(dir, 'index.js');
    if (!fs.existsSync(indexJs)) continue;
    try {
      // electron's index.js exports the absolute path to the binary
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electronPath = require(indexJs) as string;
      if (typeof electronPath === 'string' && fs.existsSync(electronPath)) {
        return electronPath;
      }
    } catch {
      /* try dist fallback */
    }
    const winBin = path.join(dir, 'dist', 'electron.exe');
    if (fs.existsSync(winBin)) return winBin;
    const nixBin = path.join(dir, 'dist', 'electron');
    if (fs.existsSync(nixBin)) return nixBin;
  }
  return null;
}
