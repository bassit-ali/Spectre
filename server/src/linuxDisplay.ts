import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * SPECTRE often runs as a systemd system service with no DISPLAY.
 * Probe the active local graphical session so Electron can still launch.
 */
export function linuxGuiEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return { ...base };
  const env: NodeJS.ProcessEnv = { ...base };

  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    const probed = probeActiveSession();
    if (probed.DISPLAY) env.DISPLAY = probed.DISPLAY;
    if (probed.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = probed.WAYLAND_DISPLAY;
    if (probed.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = probed.XDG_RUNTIME_DIR;
    if (probed.XAUTHORITY) env.XAUTHORITY = probed.XAUTHORITY;
  }

  if (!env.DISPLAY && fs.existsSync('/tmp/.X11-unix/X0')) {
    env.DISPLAY = ':0';
  }
  if (!env.XAUTHORITY && env.DISPLAY) {
    const auth = findXauthority(env);
    if (auth) env.XAUTHORITY = auth;
  }

  return env;
}

export function linuxHasDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return true;
  const probed = linuxGuiEnv(env);
  return !!(probed.DISPLAY || probed.WAYLAND_DISPLAY);
}

function probeActiveSession(): {
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  XDG_RUNTIME_DIR?: string;
  XAUTHORITY?: string;
} {
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
          ['show-session', id, '-p', 'Type', '-p', 'Remote', '-p', 'State', '-p', 'Display', '-p', 'Name', '-p', 'User'],
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

      const uid = props.User?.trim();
      const runtime = uid && /^\d+$/.test(uid) ? `/run/user/${uid}` : undefined;
      const out: {
        DISPLAY?: string;
        WAYLAND_DISPLAY?: string;
        XDG_RUNTIME_DIR?: string;
        XAUTHORITY?: string;
      } = {};
      if (runtime && fs.existsSync(runtime)) out.XDG_RUNTIME_DIR = runtime;
      if (props.Display) {
        if (type === 'wayland') out.WAYLAND_DISPLAY = props.Display;
        else out.DISPLAY = props.Display.startsWith(':') ? props.Display : `:${props.Display}`;
      }
      if (!out.DISPLAY && type === 'wayland' && runtime) {
        // Common compositor socket name when Display property is empty.
        for (const sock of ['wayland-0', 'wayland-1']) {
          if (fs.existsSync(path.join(runtime, sock))) {
            out.WAYLAND_DISPLAY = sock;
            break;
          }
        }
      }
      if (!out.DISPLAY && fs.existsSync('/tmp/.X11-unix/X0')) out.DISPLAY = ':0';
      if (out.DISPLAY || out.WAYLAND_DISPLAY) {
        const auth = findXauthority({ ...process.env, ...out, HOME: homeForUid(uid) });
        if (auth) out.XAUTHORITY = auth;
        return out;
      }
    }
  } catch {
    /* loginctl unavailable */
  }
  return {};
}

function homeForUid(uid: string | undefined): string | undefined {
  if (!uid || !/^\d+$/.test(uid)) return undefined;
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of passwd.split('\n')) {
      const parts = line.split(':');
      if (parts[2] === uid && parts[5]) return parts[5];
    }
  } catch {
    /* ignore */
  }
  return undefined;
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

  // Mutter / GDM often drop a random Xwayland auth file under the user runtime dir.
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && fs.existsSync(runtime)) {
    try {
      const hit = fs
        .readdirSync(runtime)
        .find((f) => f.includes('Xauthority') || f.includes('Xwaylandauth') || f.startsWith('.mutter-Xwaylandauth'));
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
