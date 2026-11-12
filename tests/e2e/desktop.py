"""The packaged desktop app end to end: everything unlocked, the AI agent switch with a real
MCP client, persistence across restarts, single instance.

    npm run dist:linux        (release/VBLens-linux-x64)
    VB_SAMPLE=... VB_PCODE=... python3 desktop.py

Runs the app under Xvfb on Linux and drives its window through the DevTools protocol.
"""
import asyncio, json, os, re, shutil, signal, subprocess, sys, tempfile, time, urllib.request, urllib.error
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client
from playwright.async_api import async_playwright
from config import EXE, PCODE, SHOTS

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
APP = os.environ.get('VBLENS_APP', os.path.join(ROOT, 'release', 'VBLens-linux-x64', 'VBLens'))
DATA = tempfile.mkdtemp(prefix='vblens-desktop-')
PORT = 9333
res = []

def rep(ok, name, info=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f' :: {info}' if info != '' else ''), flush=True)

def launch(*extra):
    env = {**os.environ, 'VBLENS_REMOTE_DEBUG_PORT': str(PORT), 'VBLENS_USER_DATA': DATA}
    return subprocess.Popen(['xvfb-run', '-a', '-s', '-screen 0 1600x1000x24', APP, '--no-sandbox', *extra], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

def stop(proc):
    try: os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: proc.wait(10)
    except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL)
    time.sleep(1)

def http(method, url, headers=None, body=None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

async def window(pw):
    for _ in range(60):
        try:
            b = await pw.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
            for ctx in b.contexts:
                for pg in ctx.pages:
                    if pg.url.startswith('http://127.0.0.1:'):
                        await pg.wait_for_selector('[data-testid=live-panel], [data-testid=workspace]', timeout=20000)
                        return b, pg
            await b.close()
        except Exception:
            pass
        await asyncio.sleep(0.5)
    raise RuntimeError('the app window did not come up')

P = '.tabpane:not(.hidden) '

async def main():
    async with async_playwright() as pw:
        # ================= first start =================
        proc = launch()
        b, pg = await window(pw)
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        base = re.match(r'(http://127\.0\.0\.1:\d+/)', pg.url).group(1)
        rep(True, 'packaged app starts its engine and shows the window', base)
        rep(await pg.query_selector('[data-testid=edition-chip]') is None, 'no edition / license chip anywhere')
        rep('AI agent off' in await pg.inner_text('[data-testid=landing-agent]'), 'AI agent access starts off')
        st, body = http('POST', base + 'mcp', {'content-type': 'application/json', 'accept': 'application/json, text/event-stream'}, b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
        rep(st == 403 and b'turned off' in body, 'MCP endpoint refuses agents while the switch is off', st)

        await pg.set_input_files('[data-testid=file-input]', EXE)
        await pg.wait_for_selector('[data-testid=workspace]', timeout=60000)
        await pg.keyboard.press('g'); await pg.wait_for_selector('[data-testid=prompt]')
        await pg.keyboard.type('kelet.cmd_ishur_win_Click'); await pg.keyboard.press('Enter')
        await pg.wait_for_selector(P + '[data-testid=code] .cl', timeout=20000)
        rep(await pg.query_selector('[data-testid=pro-lock]') is None, 'procedures open straight in the decompiled code')
        token = await pg.evaluate('window.__VBLENS_LIVE__.token')
        st, body = http('POST', base + 'live/rpc', {'content-type': 'text/plain', 'x-vblens-token': token}, json.dumps({'file': os.path.basename(EXE), 'method': 'decompile', 'args': [0x5C7150]}).encode())
        rep(st == 200, 'engine decompiles without any license', st)
        st, body = http('POST', base + 'live/rpc', {'content-type': 'text/plain', 'x-vblens-token': token}, json.dumps({'file': os.path.basename(EXE), 'method': 'grepCode', 'args': ['MsgBox', 5]}).encode())
        rep(st == 200, 'engine searches the decompiled code without any license', st)
        st, body = http('POST', base + 'live/rpc', {'content-type': 'text/plain', 'x-vblens-token': token}, b'{"method":"setLicense","args":["x"]}')
        rep(st != 200, 'the old license RPC methods are gone', st)
        st, body = http('POST', base + 'live/rpc', {'content-type': 'text/plain', 'x-vblens-token': token}, json.dumps({'file': os.path.basename(EXE), 'method': 'exportZip', 'args': []}).encode())
        rep(st == 200 and len(body) > 10000, 'engine exports the project without any license', f'{st} {len(body)} bytes')

        # ---- AI agent switch
        await pg.click('[data-testid=live-chip]'); await pg.click('.ctx >> text=AI agent settings')
        await pg.wait_for_selector('[data-testid=mcp-switch]')
        await pg.click('[data-testid=mcp-switch]')
        await pg.wait_for_selector('[data-testid=mcp-command]')
        cmd = await pg.evaluate("document.querySelector('[data-testid=mcp-command] code').innerText")
        rep('claude mcp add --transport http vblens' in cmd and '•' in cmd, 'switch on shows the Claude Code command (token hidden)', cmd[:70])
        st_ = json.loads(http('POST', base + 'live/rpc', {'content-type': 'text/plain', 'x-vblens-token': token}, b'{"method":"appState","args":[]}')[1])['result']
        mcp_url, mcp_tok = st_['mcp']['url'], st_['mcp']['token']
        await pg.keyboard.press('Escape')
        st, _ = http('POST', mcp_url, {'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': 'Bearer wrong'}, b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
        rep(st == 401, 'agents with a wrong token are refused', st)
        async with create_mcp_http_client(headers={'Authorization': f'Bearer {mcp_tok}'}) as hc, streamable_http_client(mcp_url, http_client=hc) as streams, ClientSession(streams[0], streams[1]) as s:
            await s.initialize()
            tools = (await s.list_tools()).tools
            rep(len(tools) == 28, 'an agent connects with the copied URL and token', f'{len(tools)} tools')
            r = await s.call_tool('vb_get_user_view', {'context_lines': 2})
            t = r.content[0].text
            rep('cmd_ishur_win_Click' in t, 'the agent sees what is open in the window', t.splitlines()[0])
            await asyncio.sleep(4.5)
            r = await s.call_tool('vb_show_in_app', {'target': 'kelet.Form_Load', 'note': 'Desktop test note'})
            await pg.wait_for_selector('[data-testid=agent-note]', timeout=8000)
            rep('Form_Load' in await pg.inner_text('.tab.active'), 'the agent moves the window with vb_show_in_app')
            r = await s.call_tool('vb_open_app', {})
            rep('front' in r.content[0].text, 'vb_open_app brings the desktop window to the front', r.content[0].text)
            await asyncio.sleep(0.5)
            chip = await pg.inner_text('[data-testid=live-chip]')
            rep('Agent active' in chip, 'top bar shows that an agent is active', chip)
        await pg.screenshot(path=SHOTS + 'desktop.png')
        rep(not errors, 'no page errors (first run)', errors[:3])
        await b.close(); stop(proc)

        # ================= restart: settings persist =================
        proc = launch()
        b, pg = await window(pw)
        st_ = json.loads(http('POST', pg.url.split('?')[0] + 'live/rpc', {'content-type': 'text/plain', 'x-vblens-token': await pg.evaluate('window.__VBLENS_LIVE__.token')}, b'{"method":"appState","args":[]}')[1])['result']
        rep(st_['mcp']['on'] and st_['mcp']['url'] == mcp_url and st_['mcp']['token'] == mcp_tok, 'AI agent switch, address and token are remembered', st_['mcp']['url'])
        rep('license' not in st_ and 'pro' not in st_, 'app state carries no license fields', list(st_.keys()))

        # ---- a second launch with a file: the running window opens it
        if PCODE:
            second = subprocess.run(['xvfb-run', '-a', APP, '--no-sandbox', PCODE], env={**os.environ, 'VBLENS_USER_DATA': DATA}, timeout=60, capture_output=True)
            await pg.wait_for_function(f"document.querySelector('.file-chip')?.innerText.includes({json.dumps(os.path.basename(PCODE))})", timeout=30000)
            rep(second.returncode == 0, 'second launch hands the file to the running window and exits', second.returncode)

        # ---- turning the switch off disconnects agents
        await pg.click('[data-testid=live-chip]'); await pg.click('.ctx >> text=AI agent settings')
        await pg.wait_for_selector('[data-testid=mcp-switch]')
        await pg.click('[data-testid=mcp-switch]')
        await pg.wait_for_function("document.querySelector('[data-testid=mcp-switch]')?.getAttribute('aria-checked') === 'false'")
        await pg.keyboard.press('Escape')
        st, _ = http('POST', mcp_url, {'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': f'Bearer {mcp_tok}'}, b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
        rep(st == 403, 'switching AI agents off refuses the agent again', st)
        await b.close(); stop(proc)

asyncio.run(main())
shutil.rmtree(DATA, ignore_errors=True)
print(f"SUMMARY {sum(res)}/{len(res)} passed")
sys.exit(0 if all(res) else 1)
