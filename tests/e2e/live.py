"""Live link between the MCP server and the app: an MCP client plays the agent while
Playwright plays the user, and each side checks it sees what the other does.

    npm run build && npm run build:mcp
    VB_SAMPLE=... VB_PCODE=... python3 live.py
"""
import asyncio, json, os, random, re, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.error
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from playwright.async_api import async_playwright
from config import EXE, PCODE, SHOTS
CHROME = os.environ.get('CHROME') or None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SERVER = os.environ.get('VBLENS_MCP', os.path.join(ROOT, 'dist-mcp', 'vblens-mcp.mjs'))
PORT = random.randint(41000, 41900)
STATE = tempfile.mkdtemp(prefix='vblens-live-')
res = []

def rep(ok, name, info=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f' :: {info}' if info != '' else ''), flush=True)

def text(r):
    return '\n'.join(c.text for c in r.content if getattr(c, 'text', None))

def http(method, path, headers=None, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}', data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

async def main():
    params = StdioServerParameters(command='node', args=[SERVER, '--state-dir', STATE, '--ui-port', str(PORT)])
    async with stdio_client(params) as (rd, wr), ClientSession(rd, wr) as mcp, async_playwright() as pw:
        await mcp.initialize()
        async def call(name, **args):
            r = await mcp.call_tool(name, args)
            return r, text(r)
        b = await pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}), args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'favicon' not in m.text else None)
        P = '.tabpane:not(.hidden) '

        async def idle():  # the app never moves the view right after the user touched it
            await asyncio.sleep(4.3)

        # ---- app address and an empty app
        for _ in range(30):
            r, t = await call('vb_app_status')
            if 'App address' in t: break
            await asyncio.sleep(0.2)
        rep(f'127.0.0.1:{PORT}' in t, 'vb_app_status reports the app address', t.splitlines()[0])
        await pg.goto(f'http://127.0.0.1:{PORT}/')
        await pg.wait_for_selector('[data-testid=live-panel]')
        await pg.wait_for_function("document.querySelector('[data-testid=live-panel]').innerText.includes('Connected')")
        rep(True, 'app served by the server connects (landing shows the live panel)')
        r, t = await call('vb_app_status')
        rep('1 app window' in t, 'server sees the connected app window', t)

        # ---- agent opens a file: the empty app shows it
        r, t = await call('vb_open_file', path=EXE)
        await pg.wait_for_selector('[data-testid=workspace]', timeout=30000)
        chip = await pg.inner_text('.file-chip')
        rep(os.path.basename(EXE) in chip, 'agent opens a file -> app shows it', chip)
        rep(await pg.query_selector('[data-testid=live-chip]') is not None and 'following' in (await pg.inner_text('[data-testid=live-chip]')), 'live chip shows connected + following')

        # ---- follow: agent reads a procedure -> app goes there
        await idle()
        r, t = await call('vb_decompile', procedure='kelet.cmd_ishur_win_Click')
        await pg.wait_for_function("(document.querySelector('.tab.active')||{}).innerText?.includes('cmd_ishur_win_Click')", timeout=10000)
        await pg.wait_for_selector(P + '[data-testid=code] .cl')
        rep(True, 'agent decompiles -> app follows to that procedure')
        st = await pg.inner_text('[data-testid=live-status]')
        rep('Agent' in st and 'cmd_ishur_win_Click' in st, 'status bar shows what the agent is doing', st)
        r, t = await call('vb_disassemble', target='kelet.cmd_ishur_win_Click', limit=5)
        await idle()
        r, t = await call('vb_get_cfg', procedure='kelet.cmd_ishur_win_Click', limit=3)
        await pg.wait_for_selector(P + '.graph', timeout=10000)
        rep(True, 'agent asks for the graph -> app shows the graph view')

        # ---- the agent sees what the user looks at
        await pg.click(P + '[data-testid=viewseg] button[title=Code]')
        await pg.wait_for_selector(P + '[data-testid=code] .cl')
        line = pg.locator(P + '[data-testid=code] .cl').filter(has=pg.locator('.addr', has_text=re.compile(r'[0-9A-F]'))).nth(4)
        addr = (await line.locator('.addr').inner_text()).strip()
        await line.locator('.src').click(position={'x': 2, 'y': 5})
        await asyncio.sleep(0.6)
        r, t = await call('vb_get_user_view', context_lines=3)
        h8 = '%08X' % int(addr, 16)
        rep('cmd_ishur_win_Click' in t and f'0x{h8}' in t and re.search(r'^> 0x' + h8, t, re.M), 'vb_get_user_view: procedure, cursor and marked line', f'cursor {h8}; ' + t.splitlines()[0])
        await line.locator('.src').click(click_count=3)
        await asyncio.sleep(0.8)
        r, t = await call('vb_get_user_view', context_lines=0)
        rep('Selected text:' in t, 'vb_get_user_view includes the selected text', t.split('Selected text:')[-1].strip()[:60])

        # ---- the agent shows something, with a note
        r, t = await call('vb_show_in_app', object='frm_password', control='txt_password_name', note='The password box: its KeyUp handler checks the value.')
        await pg.wait_for_selector('[data-testid=agent-note]', timeout=10000)
        note = await pg.inner_text('[data-testid=agent-note]')
        act = await pg.inner_text('.tab.active')
        rep('password box' in note and 'frm_password' in act, 'vb_show_in_app moves the app and shows the note', f'{act} / {note[:50]}')
        await pg.wait_for_selector(P + '[data-testid=designer]')
        insp = await pg.inner_text('.main') if True else ''
        rep('txt_password_name' in insp, 'shown control is selected in the designer')
        r, t = await call('vb_show_in_app', target='0x005C7260', view='asm')
        await pg.wait_for_function("(document.querySelector('.tab.active')||{}).innerText?.includes('cmd_ishur_win_Click')", timeout=10000)
        await pg.wait_for_selector(P + '[data-testid=disasm] .cl.cur', timeout=10000)
        cur = await pg.inner_text(P + '[data-testid=disasm] .cl.cur')
        rep('5C7260' in cur.upper(), 'vb_show_in_app with an address puts the cursor on it', cur[:40])
        rep(await pg.query_selector('[data-testid=agent-note]') is None, 'a new show without a note clears the previous note')

        # ---- edits flow both ways
        r, t = await call('vb_rename', target='0x0065F090', new_name='CheckPasswordKey')
        await pg.wait_for_selector('[data-testid=toast]', timeout=5000)
        toast = await pg.inner_text('[data-testid=toast]')
        rep('Agent renamed' in toast and 'CheckPasswordKey' in toast, 'agent rename -> app toast', toast)
        await asyncio.sleep(0.5)
        r, t = await call('vb_search', query='CheckPasswordKey')
        await pg.keyboard.press('Control+k'); await pg.keyboard.type('CheckPasswordKey'); await asyncio.sleep(0.7)
        pal = await pg.inner_text('.palette') if await pg.query_selector('.palette') else ''
        rep('CheckPasswordKey' in pal, 'renamed procedure is searchable in the app', pal[:60])
        await pg.keyboard.press('Enter'); await asyncio.sleep(0.8)
        rep('CheckPasswordKey' in await pg.inner_text('.tab.active'), 'and opens under its new name')
        # user renames in the app -> agent sees it
        await pg.click(P + '[data-testid=code]'); await pg.keyboard.press('n')
        await pg.wait_for_selector('[data-testid=prompt]')
        await pg.keyboard.press('Control+a'); await pg.keyboard.type('UserNamedKeyUp'); await pg.keyboard.press('Enter')
        await asyncio.sleep(0.8)
        r, t = await call('vb_get_procedure_info', procedure='0x0065F090')
        rep('UserNamedKeyUp' in t.splitlines()[0], 'user rename in the app -> agent sees it', t.splitlines()[0])
        r, t = await call('vb_decompile', procedure='0x0065F090', addresses=True)
        stmt = re.findall(r'^(0x[0-9A-F]{8})  \s+\S', t, re.M)[2]
        await idle()
        r, t = await call('vb_set_comment', address=stmt, comment='agent note on this line')
        await asyncio.sleep(1.0)
        body = await pg.inner_text(P + '[data-testid=code]')
        rep('agent note on this line' in body, 'agent comment appears in the open code view')
        r, t = await call('vb_set_comment', address=stmt, comment='')

        # ---- follow off: passive activity no longer moves the view; show still does
        await pg.click('[data-testid=live-chip]')
        await pg.click('.ctx >> text=Following the agent')
        await idle()
        before = await pg.inner_text('.tab.active')
        r, t = await call('vb_decompile', procedure='kelet.Form_Load')
        await asyncio.sleep(1.5)
        rep(await pg.inner_text('.tab.active') == before, 'follow off: agent reading does not move the app', before)
        r, t = await call('vb_show_in_app', target='kelet.Form_Load')
        await pg.wait_for_function("(document.querySelector('.tab.active')||{}).innerText?.includes('Form_Load')", timeout=8000)
        rep(True, 'follow off: vb_show_in_app still moves it')
        await pg.click('[data-testid=live-chip]'); await pg.click('.ctx >> text=Follow the agent')

        # ---- user opens a second file in the app: the agent sees it
        if PCODE:
            await pg.set_input_files('.topbar input[type=file] >> nth=0', PCODE)
            await pg.wait_for_function(f"document.querySelector('.file-chip')?.innerText.includes({json.dumps(os.path.basename(PCODE))})", timeout=60000)
            await asyncio.sleep(0.6)
            r, t = await call('vb_list_files')
            rep('dropped into the app' in t and "on the user's screen" in t, 'file dropped in the app appears in vb_list_files', t)
            r, t = await call('vb_get_user_view')
            rep(os.path.basename(PCODE) in t, 'vb_get_user_view follows to the dropped file', t.splitlines()[0])
            r, t = await call('vb_close_file', file=os.path.basename(PCODE))
            rep(getattr(r, 'isError', None) or getattr(r, 'is_error', None), 'agent cannot close the file on the user\'s screen', t[:90]); rep('user has' in t, 'with an explanation', t[:60])
            # the agent works on the other file: the idle app follows it there
            await idle()
            r, t = await call('vb_decompile', file=os.path.basename(EXE), procedure='kelet.cmd_del_win_Click')
            await pg.wait_for_function(f"document.querySelector('.file-chip')?.innerText.includes({json.dumps(os.path.basename(EXE))})", timeout=20000)
            await pg.wait_for_function("(document.querySelector('.tab.active')||{}).innerText?.includes('cmd_del_win_Click')", timeout=10000)
            rep(True, 'agent works on another file -> app switches file and procedure')
            # switch back from the live menu
            await pg.click('[data-testid=live-chip]')
            await pg.click(f".ctx >> text={os.path.basename(PCODE)}")
            await pg.wait_for_function(f"document.querySelector('.file-chip')?.innerText.includes({json.dumps(os.path.basename(PCODE))})", timeout=20000)
            rep(True, 'live menu switches between server files')

        # ---- export through the server
        async with pg.expect_download(timeout=60000) as dl:
            await pg.evaluate("document.querySelector('[data-testid=export]').click()")
        d = await dl.value
        rep(d.suggested_filename.endswith('.zip'), 'export works in live mode', d.suggested_filename)
        await pg.screenshot(path=SHOTS + 'live.png')

        # ---- security of the app channel
        tok = await pg.evaluate('window.__VBLENS_LIVE__.token')
        s, _ = http('POST', '/live/rpc', {'content-type': 'text/plain'}, b'{"method":"liveFiles","args":[]}')
        rep(s == 401, '/live/rpc without the token is refused', s)
        s, _ = http('POST', '/live/rpc', {'content-type': 'text/plain', 'x-vblens-token': tok, 'Host': 'evil.example'}, b'{"method":"liveFiles","args":[]}')
        rep(s == 403, 'wrong Host header (DNS rebinding) is refused', s)
        s, _ = http('POST', '/live/rpc', {'content-type': 'text/plain', 'x-vblens-token': tok, 'Origin': 'https://evil.example'}, b'{"method":"liveFiles","args":[]}')
        rep(s == 403, 'foreign Origin is refused', s)
        s, body = http('POST', '/live/rpc', {'content-type': 'text/plain', 'x-vblens-token': tok}, json.dumps({'file': os.path.basename(EXE), 'method': 'constructor', 'args': []}).encode())
        rep(s == 400 and b'Unknown method' in body, 'only whitelisted session methods can be called', s)
        s, _ = http('GET', '/live/events')
        rep(s == 401, 'event stream without the token is refused', s)
        s, hdrs = 0, None
        req = urllib.request.urlopen(f'http://127.0.0.1:{PORT}/', timeout=10)
        rep(req.headers.get('x-frame-options') == 'DENY', 'app page cannot be framed by other sites')

        rep(not errors, 'no page errors', errors[:3])
        await b.close()

asyncio.run(main())
shutil.rmtree(STATE, ignore_errors=True)
print(f"SUMMARY {sum(res)}/{len(res)} passed")
sys.exit(0 if all(res) else 1)
