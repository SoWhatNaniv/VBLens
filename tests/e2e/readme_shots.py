"""Screenshots for the README, taken from the packaged desktop app at 2x scale.

    npm run dist:linux
    VB_SAMPLE=/path/to/SemiVBDecompiler.exe python3 readme_shots.py

The README images show Semi VB Decompiler, an open-source VB6 program. Output: docs/*.png.
Runs the app under Xvfb and drives it through the DevTools protocol (like desktop.py).
"""
import asyncio, json, os, re, shutil, signal, subprocess, tempfile, time, urllib.request
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client
from playwright.async_api import async_playwright
from config import EXE

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
APP = os.environ.get('VBLENS_APP', os.path.join(ROOT, 'release', 'VBLens-linux-x64', 'VBLens'))
OUT = os.path.join(ROOT, 'docs')
DATA = tempfile.mkdtemp(prefix='vblens-shots-')
PORT = 9334
PROC = os.environ.get('SHOT_PROC', 'frmNativeDecompile.lstProcedures_Click')
FORM = os.environ.get('SHOT_FORM', 'frmOptions')
GRAPH_PROC = os.environ.get('SHOT_GRAPH_PROC', 'frmMain.cmdColor_Click')
P = '.tabpane:not(.hidden) '

def rpc(base, token, body):
    req = urllib.request.Request(base + 'live/rpc', data=json.dumps(body).encode(), method='POST',
                                 headers={'content-type': 'text/plain', 'x-vblens-token': token})
    with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read())['result']

async def main():
    os.makedirs(OUT, exist_ok=True)
    env = {**os.environ, 'VBLENS_REMOTE_DEBUG_PORT': str(PORT), 'VBLENS_USER_DATA': DATA}
    proc = subprocess.Popen(['xvfb-run', '-a', '-s', '-screen 0 3400x2200x24', APP, '--no-sandbox', '--force-device-scale-factor=2'],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        async with async_playwright() as pw:
            pg = None
            for _ in range(80):
                try:
                    b = await pw.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
                    pg = next((p for c in b.contexts for p in c.pages if p.url.startswith('http://127.0.0.1:')), None)
                    if pg: break
                    await b.close()
                except Exception: pass
                await asyncio.sleep(0.5)
            await pg.wait_for_selector('[data-testid=live-panel]', timeout=30000)
            base = re.match(r'(http://127\.0\.0\.1:\d+/)', pg.url).group(1)
            token = await pg.evaluate('window.__VBLENS_LIVE__.token')
            shot = lambda n: pg.screenshot(path=os.path.join(OUT, n + '.png'))
            await asyncio.sleep(1.2); await shot('landing')

            await pg.set_input_files('[data-testid=file-input]', EXE)
            await pg.wait_for_selector(P + '[data-testid=overview]', timeout=60000)
            await asyncio.sleep(0.8); await shot('overview')

            # form designer with a selected control
            await pg.keyboard.press('Control+k'); await pg.wait_for_selector('[data-testid=palette]')
            await pg.keyboard.type(FORM); await asyncio.sleep(0.4); await pg.keyboard.press('Enter')
            await pg.wait_for_selector(P + '[data-testid=designer]', timeout=20000); await asyncio.sleep(1)
            # select a visible command button (hidden controls can sit far outside the form)
            await pg.evaluate('''() => {
              const r = document.querySelector('.tabpane:not(.hidden) [data-testid=designer] .form-client, .tabpane:not(.hidden) [data-testid=designer]').getBoundingClientRect();
              const vis = [...document.querySelectorAll('.tabpane:not(.hidden) [data-testid=designer] .ctl')].filter(e => {
                const b = e.getBoundingClientRect(); return b.width > 20 && b.left >= r.left && b.top >= r.top && b.right <= r.right && b.bottom <= r.bottom; });
              const pick = vis.find(e => e.classList.contains('button')) ?? vis[0];
              pick?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }''')
            await asyncio.sleep(0.4)
            await shot('designer')

            # command palette, then the decompiled procedure
            await pg.keyboard.press('Control+k'); await pg.wait_for_selector('[data-testid=palette]')
            await pg.keyboard.type(PROC.split('.')[-1][:12]); await asyncio.sleep(0.6); await shot('palette')
            await pg.keyboard.press('Escape')
            await pg.keyboard.press('g'); await pg.wait_for_selector('[data-testid=prompt]')
            await pg.keyboard.type(PROC); await pg.keyboard.press('Enter')
            await pg.wait_for_selector(P + '[data-testid=code] .cl', timeout=30000); await asyncio.sleep(0.8)
            await shot('code')
            await pg.click(P + '[data-testid=viewseg] button:has-text("Split")'); await asyncio.sleep(1.2); await shot('split')
            await pg.keyboard.press('g'); await pg.wait_for_selector('[data-testid=prompt]')
            await pg.keyboard.type(GRAPH_PROC); await pg.keyboard.press('Enter'); await asyncio.sleep(1)
            await pg.click(P + '[data-testid=viewseg] button:has-text("Graph")')
            await pg.wait_for_selector(P + '[data-testid=graph]'); await asyncio.sleep(0.8)
            z = int(os.environ.get('SHOT_GRAPH_ZOOM', '-2'))
            for _ in range(abs(z)):
                await pg.click(P + ('button[title^="Zoom in"]' if z > 0 else 'button[title^="Zoom out"]')); await asyncio.sleep(0.2)
            await asyncio.sleep(0.6); await shot('graph')
            await pg.click(P + '[data-testid=viewseg] button:has-text("Code")'); await asyncio.sleep(0.6)

            # AI agent: switch on, show the settings, then let an agent drive the window
            rpc(base, token, {'method': 'setMcp', 'args': [True]})
            await asyncio.sleep(0.5)
            await pg.click('[data-testid=live-chip]'); await pg.click('.ctx >> text=AI agent settings')
            await pg.wait_for_selector('[data-testid=mcp-command]'); await asyncio.sleep(0.5); await shot('agent-settings')
            await pg.keyboard.press('Escape')
            st = rpc(base, token, {'method': 'appState', 'args': []})
            async with create_mcp_http_client(headers={'Authorization': f"Bearer {st['mcp']['token']}"}) as hc, \
                    streamable_http_client(st['mcp']['url'], http_client=hc) as streams, ClientSession(streams[0], streams[1]) as s:
                await s.initialize()
                await s.call_tool('vb_get_user_view', {'context_lines': 2})
                await s.call_tool('vb_show_in_app', {'target': PROC, 'note':
                    'This handler shows the selected procedure: it reads the code bytes from the EXE with Get # '
                    'and hands them to CDisassembler, or calls modNativeToVB when "Native to VB" is selected.'})
                await pg.wait_for_selector('[data-testid=agent-note]', timeout=8000); await asyncio.sleep(1)
                await shot('agent')
    finally:
        try: os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        time.sleep(1)
        shutil.rmtree(DATA, ignore_errors=True)

asyncio.run(main())
print('screenshots written to', OUT)

# shrink for the README: 2000 px wide, 256-colour PNG (a few hundred KB each)
from PIL import Image
for f in os.listdir(OUT):
    if f.endswith('.png') and f != 'banner.png':
        im = Image.open(os.path.join(OUT, f)).convert('RGB')
        if im.width > 2000: im = im.resize((2000, round(im.height * 2000 / im.width)), Image.LANCZOS)
        im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(os.path.join(OUT, f), optimize=True)
