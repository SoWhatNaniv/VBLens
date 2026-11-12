"""The desktop window fits the screen and the app follows the window size.

Runs the packaged Linux app (npm run dist:linux) on virtual screens of different sizes and
Windows-style display scaling, and checks that:
  - the first window lies fully inside the screen (no part off screen),
  - a window remembered from a bigger monitor is pulled back inside the screen,
  - resizing the window resizes the app (status bar always at the bottom edge),
  - the start page always fits the window (it shrinks instead of scrolling).

    VB_SAMPLE=... python3 window_size.py          (needs Xvfb and pip install python-xlib)
"""
import asyncio, json, os, signal, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright
from Xlib import display as xdisplay
from config import EXE

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
APP = os.environ.get('VBLENS_APP', os.path.join(ROOT, 'release', 'VBLens-linux-x64', 'VBLens'))
res = []
def rep(ok, name, info=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f' :: {info}' if info != '' else ''), flush=True)

def app_window(disp):
    d = xdisplay.Display(disp)
    found = []
    def walk(w):
        for c in w.query_tree().children:
            try:
                cls = c.get_wm_class()
                if cls and 'vblens' in cls and c.get_attributes().map_state == 2:
                    g = c.get_geometry(); found.append((g.width * g.height, c))
            except Exception: pass
            walk(c)
    walk(d.screen().root)
    return d, max(found, key=lambda x: x[0])[1]

def geom(disp):
    d, w = app_window(disp); g = w.get_geometry()
    t = w.translate_coords(d.screen().root, 0, 0)  # window origin in screen coordinates
    d.close(); return (-t.x, -t.y, g.width, g.height)

def resize(disp, w_, h_):
    d, w = app_window(disp); w.configure(x=0, y=0, width=w_, height=h_); d.sync(); d.close()

PAGE = """() => { const s = document.querySelector('.status')?.getBoundingClientRect();
  const l = document.querySelector('.landing'), f = document.querySelector('.landing .fit')?.getBoundingClientRect();
  return { inner: [innerWidth, innerHeight], statusBottom: s ? Math.round(s.bottom) : null,
           docScroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
           landingScrolls: l ? l.scrollHeight > l.clientHeight + 2 : null,
           landingFits: f ? f.top >= -1 && f.left >= -1 && f.bottom <= innerHeight + 1 && f.right <= innerWidth + 1 : null,
           fitScale: l ? getComputedStyle(document.querySelector('.landing .fit')).getPropertyValue('--fit') : null } }"""

async def run(screen, scale, disp, port, saved=None):
    sw, sh = map(int, screen.split('x'))
    data = tempfile.mkdtemp(prefix='vblens-size-')
    if saved: json.dump(saved, open(os.path.join(data, 'window.json'), 'w'))
    xvfb = subprocess.Popen(['Xvfb', disp, '-screen', '0', f'{screen}x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    app = subprocess.Popen([APP, '--no-sandbox', f'--force-device-scale-factor={scale}'],
                           env={**os.environ, 'DISPLAY': disp, 'VBLENS_REMOTE_DEBUG_PORT': str(port), 'VBLENS_USER_DATA': data},
                           start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tag = f'{screen}@{scale}' + (' (saved big window)' if saved else '')
    try:
        async with async_playwright() as pw:
            for _ in range(60):
                try: b = await pw.chromium.connect_over_cdp(f'http://127.0.0.1:{port}'); break
                except Exception: await asyncio.sleep(0.5)
            for _ in range(40):
                pgs = [x for c in b.contexts for x in c.pages if x.url.startswith('http')]
                if pgs: break
                await asyncio.sleep(0.5)
            pg = pgs[0]
            await pg.wait_for_selector('[data-testid=live-panel]'); await asyncio.sleep(1)
            x, y, w, h = geom(disp)
            rep(x >= 0 and y >= 0 and x + w <= sw and y + h <= sh, f'{tag}: window lies inside the screen', (x, y, w, h))
            p = await pg.evaluate(PAGE)
            rep(p['docScroll'] == p['inner'] and p['landingFits'] and not p['landingScrolls'], f'{tag}: start page fits the window without scrolling', p)
            if not saved:
                await pg.set_input_files('[data-testid=file-input]', EXE)
                await pg.wait_for_selector('[data-testid=workspace]', timeout=60000)
                for w_, h_ in [(int(sw * 0.75), int(sh * 0.8)), (int(sw * 0.55), int(sh * 0.62))]:
                    resize(disp, w_, h_); await asyncio.sleep(1.2)
                    p = await pg.evaluate(PAGE)
                    exp = [round(w_ / scale), round(h_ / scale)]
                    ok = abs(p['inner'][0] - exp[0]) <= 1 and abs(p['inner'][1] - exp[1]) <= 1 and p['statusBottom'] == p['inner'][1] and p['docScroll'] == p['inner']
                    rep(ok, f'{tag}: app follows a resize to {w_}x{h_}', p)
                await pg.click('.topbar .brand')  # back to the start page in a small window
                await pg.wait_for_selector('[data-testid=live-panel]'); await asyncio.sleep(0.5)
                p = await pg.evaluate(PAGE)
                rep(p['landingFits'] and not p['landingScrolls'] and p['docScroll'] == p['inner'], f'{tag}: small window -> the whole start page is visible, no scrolling', p)
                await pg.screenshot(path=f'shots/fit-landing-{screen}-{scale}.png')
                # it still works at that size: the drop area opens the file
                await pg.set_input_files('[data-testid=file-input]', EXE)
                await pg.wait_for_selector('[data-testid=workspace]', timeout=60000)
                rep(True, f'{tag}: opening a file from the shrunken start page works')
                # and it grows back when the window gets bigger
                resize(disp, sw, sh); await asyncio.sleep(1.2)
                await pg.click('.topbar .brand'); await pg.wait_for_selector('[data-testid=live-panel]'); await asyncio.sleep(0.5)
                p2 = await pg.evaluate(PAGE)
                rep(float(p2['fitScale'] or 0) > float(p['fitScale'] or 1) and p2['landingFits'], f'{tag}: start page grows again in a bigger window', (p['fitScale'], p2['fitScale']))
            await b.close()
    finally:
        try: os.killpg(app.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        time.sleep(1); xvfb.terminate()

async def main():
    await run('1366x768', 1.25, ':91', 9341)   # common laptop at 125% (Windows default there)
    await run('1920x1080', 1.5, ':92', 9342)   # 1080p at 150%
    await run('1280x720', 1, ':93', 9343)
    # remembered from a bigger monitor that is no longer attached
    await run('1366x768', 1.25, ':94', 9344, saved={'x': 600, 'y': 400, 'width': 1800, 'height': 1100, 'maximized': False})

asyncio.run(main())
print(f"SUMMARY {sum(res)}/{len(res)} passed")
sys.exit(0 if all(res) else 1)
