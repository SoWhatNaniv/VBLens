// VBLens desktop app (Electron main process).
//
// Starts the analysis engine (dist-mcp/vblens-mcp.mjs --desktop) as a separate utility
// process, then shows its app in a window. The engine also serves the AI agent endpoint,
// which the user turns on in the app (AI agent settings).

import { app, BrowserWindow, dialog, Menu, screen, session, shell, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const ENGINE = path.join(__dirname, 'engine', 'vblens-mcp.mjs');
const ICON = path.join(__dirname, 'icon.png');
const BG = '#0b0f17';

let win: BrowserWindow | null = null;
let engine: UtilityProcess | null = null;
let baseUrl: string | null = null;
let quitting = false;
let pendingOpen: string[] = [];

app.setName('VBLens');
// tests (and portable setups) can keep settings and logs in another folder
if (process.env.VBLENS_USER_DATA) app.setPath('userData', path.resolve(process.env.VBLENS_USER_DATA));
if (process.platform === 'win32') app.setAppUserModelId('com.vblens.app');
// tests drive the window through the DevTools protocol
if (process.env.VBLENS_REMOTE_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.VBLENS_REMOTE_DEBUG_PORT);

const userData = () => app.getPath('userData');
const logFile = () => path.join(userData(), 'logs', 'engine.log');

function log(line: string) {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${line.trimEnd()}\n`);
  } catch { /* logging must never break the app */ }
}

/** Files passed on the command line (e.g. a file dropped on VBLens.exe). */
function filesFromArgs(argv: string[]): string[] {
  return argv.slice(1).filter(a => !a.startsWith('-') && /\.(exe|dll|ocx)$/i.test(a) && fs.existsSync(a)).map(a => path.resolve(a));
}

// ---- window state --------------------------------------------------------------------------

interface WinState { x?: number; y?: number; width?: number; height?: number; maximized?: boolean }
interface Bounds { x: number; y: number; width: number; height: number }
const stateFile = () => path.join(userData(), 'window.json');
/** Smallest useful window; never more than the screen allows. */
const MIN_W = 720, MIN_H = 460;

/**
 * Fit a window inside a screen's work area (the screen minus the taskbar). Windows' display
 * scaling makes the work area small (a 1366×768 screen at 125% is about 1092×614), so a
 * window must never be larger than it or start partly off screen.
 */
function fitTo(wa: Electron.Rectangle, b: WinState): Bounds {
  const width = Math.min(Math.max(b.width ?? 0, Math.min(MIN_W, wa.width)), wa.width);
  const height = Math.min(Math.max(b.height ?? 0, Math.min(MIN_H, wa.height)), wa.height);
  let x = b.x ?? wa.x + Math.round((wa.width - width) / 2);
  let y = b.y ?? wa.y + Math.round((wa.height - height) / 2);
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - height);
  return { x, y, width, height };
}

function loadWinState(): { bounds: Bounds; maximized: boolean } {
  let s: WinState = {};
  try { s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as WinState; } catch { /* first start */ }
  if (s.width && s.height && s.x !== undefined && s.y !== undefined) {
    // the screen it was on (or the nearest one, if that monitor is gone), at today's scaling
    const d = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height });
    const wa = d.workArea;
    // saved on a bigger (or less scaled) screen: open maximised, with a size that fits for later
    if (s.width > wa.width || s.height > wa.height) {
      return { bounds: fitTo(wa, { width: Math.round(wa.width * 0.9), height: Math.round(wa.height * 0.9) }), maximized: true };
    }
    return { bounds: fitTo(wa, s), maximized: !!s.maximized };
  }
  // first start: most of the screen, centred; small screens start maximised
  const wa = screen.getPrimaryDisplay().workArea;
  const small = wa.width < 1280 || wa.height < 760;
  return { bounds: fitTo(wa, { width: Math.min(1500, Math.round(wa.width * 0.9)), height: Math.min(960, Math.round(wa.height * 0.9)) }), maximized: small };
}

function saveWinState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* ignore */ }
}

/** After a monitor is unplugged or the scaling changes, pull the window back on screen. */
function keepOnScreen() {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;
  const cur = win.getBounds();
  const d = screen.getDisplayMatching(cur);
  win.setMinimumSize(Math.min(MIN_W, d.workArea.width), Math.min(MIN_H, d.workArea.height));
  const f = fitTo(d.workArea, cur);
  if (f.x !== cur.x || f.y !== cur.y || f.width !== cur.width || f.height !== cur.height) win.setBounds(f);
}

// ---- engine --------------------------------------------------------------------------------

function startEngine(): Promise<string> {
  return new Promise((resolve, reject) => {
    log(`starting engine ${ENGINE}`);
    const child = utilityProcess.fork(ENGINE, ['--desktop', '--state-dir', userData()], { stdio: 'pipe', serviceName: 'VBLens engine' });
    engine = child;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('The analysis engine did not start within 30 seconds.')); } }, 30_000);
    child.stdout?.on('data', (d: Buffer) => log(d.toString()));
    child.stderr?.on('data', (d: Buffer) => log(d.toString()));
    child.on('message', (m: { type?: string; url?: string; message?: string }) => {
      if (m?.type === 'ready' && m.url && !settled) { settled = true; clearTimeout(timer); resolve(m.url); }
      else if (m?.type === 'error' && !settled) { settled = true; clearTimeout(timer); reject(new Error(m.message ?? 'The analysis engine failed to start.')); }
      else if (m?.type === 'focus') focusWindow();
    });
    child.on('exit', code => {
      log(`engine exited with code ${code}`);
      if (engine === child) engine = null;
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`The analysis engine stopped while starting (code ${code}).`)); return; }
      if (!quitting) void engineCrashed(code);
    });
  });
}

async function engineCrashed(code: number) {
  const r = await dialog.showMessageBox(win ?? undefined as unknown as BrowserWindow, {
    type: 'error', title: 'VBLens',
    message: 'The analysis engine stopped unexpectedly.',
    detail: `Exit code ${code}. Open files will need to be opened again.\n\nDetails are in ${logFile()}`,
    buttons: ['Restart engine', 'Quit'], defaultId: 0, cancelId: 1,
  });
  if (r.response === 1) { app.quit(); return; }
  try {
    baseUrl = await startEngine();
    await win?.loadURL(baseUrl);
  } catch (e) { fatal(e as Error); }
}

function fatal(e: Error) {
  log(`fatal: ${e.stack ?? e.message}`);
  dialog.showErrorBox('VBLens could not start', `${e.message}\n\nDetails are in ${logFile()}`);
  quitting = true;
  app.quit();
}

function openFiles(paths: string[]) {
  if (!paths.length) return;
  if (!engine || !baseUrl) { pendingOpen.push(...paths); return; }
  for (const p of paths) engine.postMessage({ type: 'open', path: p });
}

// ---- window --------------------------------------------------------------------------------

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(url: string) {
  const st = loadWinState();
  const wa = screen.getDisplayMatching(st.bounds).workArea;
  win = new BrowserWindow({
    ...st.bounds, minWidth: Math.min(MIN_W, wa.width), minHeight: Math.min(MIN_H, wa.height),
    show: false, backgroundColor: BG, title: 'VBLens',
    icon: fs.existsSync(ICON) ? ICON : undefined, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, devTools: !app.isPackaged || !!process.env.VBLENS_DEVTOOLS },
  });
  if (st.maximized) win.maximize();
  screen.on('display-metrics-changed', keepOnScreen);
  screen.on('display-removed', keepOnScreen);
  win.once('ready-to-show', () => win?.show());
  const isOurs = (u: string) => !!baseUrl && u.startsWith(baseUrl);

  // links to other sites open in the user's browser; the window never leaves the app
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:\/\//i.test(u) && !isOurs(u)) void shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (isOurs(u)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(u)) void shell.openExternal(u);
  });
  // keyboard: F11 full screen, Ctrl +/-/0 zoom, F12 DevTools in development
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const wc = win!.webContents;
    const mod = input.control || input.meta;
    if (input.key === 'F11') { win!.setFullScreen(!win!.isFullScreen()); e.preventDefault(); }
    else if (mod && (input.key === '=' || input.key === '+')) { wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4)); e.preventDefault(); }
    else if (mod && input.key === '-') { wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3)); e.preventDefault(); }
    else if (mod && input.key === '0') { wc.setZoomLevel(0); e.preventDefault(); }
    else if (input.key === 'F12' && (!app.isPackaged || process.env.VBLENS_DEVTOOLS)) { wc.toggleDevTools(); e.preventDefault(); }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log(`window renderer gone: ${d.reason}`);
    if (d.reason !== 'clean-exit' && !quitting) win?.reload();
  });
  // exports and other downloads: ask where to save
  win.webContents.session.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Save', defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
  });
  win.on('close', saveWinState);
  win.on('closed', () => { win = null; screen.removeListener('display-metrics-changed', keepOnScreen); screen.removeListener('display-removed', keepOnScreen); });
  void win.loadURL(url);
}

// ---- app lifecycle -------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => { focusWindow(); openFiles(filesFromArgs(argv)); });
  app.on('open-file', (e, p) => { e.preventDefault(); openFiles([p]); }); // macOS
  pendingOpen = filesFromArgs(process.argv);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // the page only needs the clipboard; refuse camera, location, notifications, …
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write' || perm === 'clipboard-read'));
    try {
      baseUrl = await startEngine();
    } catch (e) { fatal(e as Error); return; }
    log(`engine ready at ${baseUrl}`);
    createWindow(baseUrl);
    const queued = pendingOpen; pendingOpen = [];
    win!.webContents.once('did-finish-load', () => openFiles(queued));
  }, e => fatal(e as Error));

  app.on('window-all-closed', () => { quitting = true; app.quit(); });
  app.on('before-quit', () => { quitting = true; saveWinState(); });
  app.on('will-quit', () => { engine?.kill(); });
  app.on('activate', () => { if (!win && baseUrl) createWindow(baseUrl); });
}
