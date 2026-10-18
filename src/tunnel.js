// Безкоштовний Cloudflare Tunnel: дає ноутбуку адресу https://….trycloudflare.com.
// Адреса змінюється при кожному запуску, тому сервер ловить нову й передає її далі (у Firebase).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const tunnelEnabled = /^(1|on|true|yes)$/i.test(process.env.ZDT_TUNNEL || '');

const CANDIDATES = [
  process.env.CLOUDFLARED_PATH,
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
].filter(Boolean);

const state = { url: null, running: false, error: null };
let child = null;

export function tunnelStatus() {
  return { enabled: tunnelEnabled, ...state };
}

// Якщо минулого разу вікно сервера просто закрили, старий тунель міг лишитися працювати
function killLeftovers(target) {
  if (process.platform !== 'win32') return;
  const script = `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | `
    + `Where-Object { $_.CommandLine -like '*${target}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', windowsHide: true });
  } catch { /* не критично */ }
}

export function startTunnel(port, onUrl) {
  if (!tunnelEnabled) return;
  const exe = CANDIDATES.find(p => existsSync(p)) || 'cloudflared';
  const target = `http://127.0.0.1:${port}`;
  killLeftovers(target);

  const run = () => {
    child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', target], { windowsHide: true });
    state.running = true;
    state.error = null;
    const onData = buf => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
      if (match && match[0] !== state.url) {
        state.url = match[0];
        console.log(`Тунель Cloudflare: ${state.url}`);
        onUrl(state.url);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => {
      state.error = err.message;
      console.error('Тунель Cloudflare не запустився —', err.message);
    });
    child.on('exit', () => {
      state.running = false;
      state.url = null;
      child = null;
      console.log('Тунель Cloudflare зупинився, перезапуск через 15 секунд…');
      setTimeout(run, 15_000);
    });
  };

  process.on('exit', () => child?.kill());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(signal, () => { child?.kill(); process.exit(0); });
  }
  run();
}
