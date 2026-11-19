import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type LinuxGuiSession = {
  env: NodeJS.ProcessEnv;
  user?: string;
  uid?: number;
  gid?: number;
  home?: string;
};

/**
 * SPECTRE often runs as a systemd system service (root, no DISPLAY).
 * Find the active local graphical seat so Electron can open like on Windows.
 */
export function resolveLinuxGuiSession(base: NodeJS.ProcessEnv = process.env): LinuxGuiSession {
  if (process.platform !== 'linux') return { env: { ...base } };

  const probed = probeActiveSession();
  const env: NodeJS.ProcessEnv = { ...base };

  if (probed.DISPLAY) env.DISPLAY = probed.DISPLAY;
  else if (!env.DISPLAY && fs.existsSync('/tmp/.X11-unix/X0')) env.DISPLAY = ':0';

  if (probed.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = probed.WAYLAND_DISPLAY;
  if (probed.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = probed.XDG_RUNTIME_DIR;
  if (probed.home) env.HOME = probed.home;
  if (probed.user) {
    env.USER = probed.user;
    env.LOGNAME = probed.user;
  }
  if (probed.uid != null && !env.XDG_RUNTIME_DIR) {
    const runtime = `/run/user/${probed.uid}`;
    if (fs.existsSync(runtime)) env.XDG_RUNTIME_DIR = runtime;
  }
  if (env.XDG_RUNTIME_DIR && fs.existsSync(path.join(env.XDG_RUNTIME_DIR, 'bus'))) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(env.XDG_RUNTIME_DIR, 'bus')}`;
  }

  if (!env.XAUTHORITY && (env.DISPLAY || probed.uid != null)) {
    const auth = findXauthority({ ...env, HOME: probed.home ?? env.HOME });
    if (auth) env.XAUTHORITY = auth;
  }

  // Prefer XWayland for reliable always-on-top frameless windows under Wayland DEs.
  if (!env.ELECTRON_OZONE_PLATFORM_HINT) {
    env.ELECTRON_OZONE_PLATFORM_HINT = env.DISPLAY ? 'x11' : 'auto';
  }

  return {
    env,
    user: probed.user,
    uid: probed.uid,
    gid: probed.gid,
    home: probed.home,
  };
}

/** @deprecated use resolveLinuxGuiSession */
export function linuxGuiEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return resolveLinuxGuiSession(base).env;
}

function isGuiSession(v: unknown): v is LinuxGuiSession {
  return !!v && typeof v === 'object' && 'env' in v && typeof (v as LinuxGuiSession).env === 'object';
}

export function linuxHasDisplay(sessionOrEnv?: LinuxGuiSession | NodeJS.ProcessEnv): boolean {
  const env: NodeJS.ProcessEnv = !sessionOrEnv
    ? resolveLinuxGuiSession().env
    : isGuiSession(sessionOrEnv)
      ? sessionOrEnv.env
      : sessionOrEnv;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

type Probed = {
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  XDG_RUNTIME_DIR?: string;
  XAUTHORITY?: string;
  user?: string;
  uid?: number;
  gid?: number;
  home?: string;
};

function probeActiveSession(): Probed {
  try {
    const list = execFileSync('loginctl', ['list-sessions', '--no-legend'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    for (const line of list.split('\n')) {
      const id = line.trim().split(/\s+/)[0];
      if (!id || !/^\d+$/.test(id)) continue;
      let show = '';
      try {
        show = execFileSync(
          'loginctl',
          [
            'show-session',
            id,
            '-p',
            'Type',
            '-p',
            'Remote',
            '-p',
            'State',
            '-p',
            'Display',
            '-p',
            'Name',
            '-p',
            'User',
          ],
          { encoding: 'utf8', timeout: 2000 },
        );
      } catch {
        continue;
      }
      const props = parseKeyVals(show);
      if (props.Remote === 'yes') continue;
      if (props.State && props.State !== 'active' && props.State !== 'online') continue;
      const type = (props.Type || '').toLowerCase();
      if (type !== 'x11' && type !== 'wayland' && type !== 'mir') continue;

      const uidStr = props.User?.trim();
      const uid = uidStr && /^\d+$/.test(uidStr) ? Number(uidStr) : undefined;
      const account = uid != null ? accountForUid(uid) : undefined;
      const runtime = uid != null ? `/run/user/${uid}` : undefined;

      const out: Probed = {
        user: account?.name ?? (props.Name?.trim() || undefined),
        uid,
        gid: account?.gid,
        home: account?.home,
      };
      if (runtime && fs.existsSync(runtime)) out.XDG_RUNTIME_DIR = runtime;

      if (props.Display) {
        if (type === 'wayland') out.WAYLAND_DISPLAY = props.Display;
        else out.DISPLAY = props.Display.startsWith(':') ? props.Display : `:${props.Display}`;
      }
      if (!out.WAYLAND_DISPLAY && type === 'wayland' && runtime) {
        for (const sock of ['wayland-0', 'wayland-1']) {
          if (fs.existsSync(path.join(runtime, sock))) {
            out.WAYLAND_DISPLAY = sock;
            break;
          }
        }
      }
      // Many Wayland sessions still expose XWayland as :0 / :1.
      if (!out.DISPLAY) {
        for (const n of [0, 1, 2]) {
          if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) {
            out.DISPLAY = `:${n}`;
            break;
          }
        }
      }

      if (out.DISPLAY || out.WAYLAND_DISPLAY) {
        const auth = findXauthority({
          ...process.env,
          HOME: out.home,
          XDG_RUNTIME_DIR: out.XDG_RUNTIME_DIR,
          DISPLAY: out.DISPLAY,
          WAYLAND_DISPLAY: out.WAYLAND_DISPLAY,
          XAUTHORITY: out.XAUTHORITY,
        });
        if (auth) out.XAUTHORITY = auth;
        return out;
      }
    }
  } catch {
    /* loginctl unavailable */
  }

  // Fallback: local :0 + first logged-in seat from who/w
  if (fs.existsSync('/tmp/.X11-unix/X0')) {
    const who = guessLoggedInUser();
    const out: Probed = { DISPLAY: ':0', ...who };
    if (out.uid != null) {
      const runtime = `/run/user/${out.uid}`;
      if (fs.existsSync(runtime)) out.XDG_RUNTIME_DIR = runtime;
    }
    const auth = findXauthority({
      ...process.env,
      HOME: out.home,
      XDG_RUNTIME_DIR: out.XDG_RUNTIME_DIR,
      DISPLAY: out.DISPLAY,
    });
    if (auth) out.XAUTHORITY = auth;
    return out;
  }
  return {};
}

function accountForUid(uid: number): { name: string; gid: number; home: string } | undefined {
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of passwd.split('\n')) {
      const parts = line.split(':');
      if (parts[2] === String(uid) && parts[0] && parts[5]) {
        return { name: parts[0], gid: Number(parts[3]) || uid, home: parts[5] };
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function guessLoggedInUser(): Partial<Probed> {
  try {
    const who = execFileSync('who', [], { encoding: 'utf8', timeout: 2000 });
    for (const line of who.split('\n')) {
      const name = line.trim().split(/\s+/)[0];
      if (!name || name === 'root') continue;
      try {
        const passwd = fs.readFileSync('/etc/passwd', 'utf8');
        for (const row of passwd.split('\n')) {
          const p = row.split(':');
          if (p[0] === name && p[2] && p[5]) {
            return { user: name, uid: Number(p[2]), gid: Number(p[3]) || Number(p[2]), home: p[5] };
          }
        }
      } catch {
        return { user: name };
      }
    }
  } catch {
    /* ignore */
  }
  return {};
}

function findXauthority(env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [
    env.XAUTHORITY,
    env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'gdm', 'Xauthority') : undefined,
    env.HOME ? path.join(env.HOME, '.Xauthority') : undefined,
    path.join(os.homedir(), '.Xauthority'),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && fs.existsSync(runtime)) {
    try {
      const hit = fs
        .readdirSync(runtime)
        .find(
          (f) =>
            f.includes('Xauthority') ||
            f.includes('Xwaylandauth') ||
            f.startsWith('.mutter-Xwaylandauth'),
        );
      if (hit) {
        const full = path.join(runtime, hit);
        if (fs.existsSync(full)) return full;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function parseKeyVals(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
