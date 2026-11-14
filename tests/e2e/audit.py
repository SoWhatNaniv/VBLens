# Edge-case audit: each probe prints OK/BUG with details. Never stops on first failure.
import glob, json, time
from playwright.sync_api import sync_playwright
from config import DIST, EXE, PCODE, BAD, TLB, SHOTS, launch
from treehelp import tree_click
res = []
def rep(ok, name, info=''):
    res.append((ok, name, info)); print(('OK  ' if ok else 'BUG ') + name + (' :: ' + str(info) if info else ''), flush=True)
def probe(name, fn):
    try: fn()
    except Exception as e: rep(False, name, 'EXC ' + str(e).split('\n')[0][:200])
errors = []
with sync_playwright() as p:
    b = launch(p)
    ctx = b.new_context(viewport={'width': 1600, 'height': 950}, accept_downloads=True)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type in ('error',) else None)
    pg.on('dialog', lambda d: (errors.append('DIALOG ' + d.type), d.dismiss()))
    pg.goto(DIST)
    pg.set_input_files('[data-testid=file-input]', EXE)
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=overview]', timeout=60000); pg.wait_for_timeout(400)

    def open_proc(name):
        pg.keyboard.press('Escape'); pg.keyboard.press('g'); pg.wait_for_selector('[data-testid=prompt]'); pg.keyboard.type(name); pg.keyboard.press('Enter'); pg.wait_for_timeout(700)

    # 1. tab state preserved when switching tabs
    def t1():
        open_proc('kelet.Form_Load')
        pg.eval_on_selector('.tabpane:not(.hidden) [data-testid=code]', 'e => e.scrollTop = 900'); pg.wait_for_timeout(200)
        pg.click('.tab:has-text("Overview")'); pg.wait_for_timeout(300)
        pg.click('.tab:has-text("Form_Load")'); pg.wait_for_timeout(400)
        st = pg.eval_on_selector('.tabpane:not(.hidden) [data-testid=code]', 'e => e.scrollTop')
        rep(st > 500, 'scroll position kept across tab switch', st)
    probe('tab state', t1)

    # 2. many tabs: tab strip overflow / active tab visible
    def t2():
        names = ['kelet.Form_Load', 'kelet.cancel_hide_cols', 'kelet.show_big_arrival', 'MDIREKA.MDIForm_Load', 'frm_password.Form_Load', 'mdl_general.Proc_2_65D360', 'kelet.flex_sort', 'kelet.calc_col', 'kelet.call_print', 'kelet.array_create', 'kelet.auto_size_cols', 'kelet.back_to_last_sade', 'kelet.after_show_block']
        for n in names:
            pg.keyboard.press('Control+k'); pg.keyboard.type(n); pg.wait_for_timeout(350); pg.keyboard.press('Control+Enter') if False else pg.keyboard.press('Enter'); pg.wait_for_timeout(250)
            pg.dblclick('.tab.active')  # pin
        tabs = pg.query_selector_all('.tab')
        strip = pg.query_selector('[data-testid=tabs]')
        sw = strip.evaluate('e => [e.scrollWidth, e.clientWidth]')
        act = pg.query_selector('.tab.active').bounding_box(); sb = strip.bounding_box()
        rep(act['x'] >= sb['x'] - 1 and act['x'] + act['width'] <= sb['x'] + sb['width'] + 1, 'active tab visible in overflowing strip', f'{len(tabs)} tabs, strip {sw}, active x={act["x"]:.0f}..{act["x"]+act["width"]:.0f} strip {sb["x"]:.0f}..{sb["x"]+sb["width"]:.0f}')
    probe('many tabs', t2)

    # 3. ctrl+wheel over graph must not zoom the page
    def t3():
        open_proc('kelet.cancel_hide_cols'); pg.keyboard.press(' '); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=graph]'); pg.wait_for_timeout(400)
        g = pg.query_selector('.tabpane:not(.hidden) [data-testid=graph]').bounding_box()
        pg.mouse.move(g['x'] + 300, g['y'] + 300)
        z0 = pg.evaluate('window.visualViewport.scale + "/" + window.devicePixelRatio')
        pg.keyboard.down('Control'); pg.mouse.wheel(0, -300); pg.keyboard.up('Control'); pg.wait_for_timeout(300)
        z1 = pg.evaluate('window.visualViewport.scale + "/" + window.devicePixelRatio')
        rep(z0 == z1, 'ctrl+wheel in graph does not zoom page', f'{z0} -> {z1}')
        pg.keyboard.press(' ')
    probe('graph wheel', t3)

    # 4. peek disappears after scrolling / navigating
    def t4():
        open_proc('kelet.Form_Load')
        l = [x for x in pg.query_selector_all('.tabpane:not(.hidden) [data-testid=code] .t-link') if 'Form_Load' not in x.inner_text()][0]
        l.hover(); pg.wait_for_timeout(900)
        had = pg.query_selector('.peek') is not None
        pg.mouse.wheel(0, 400); pg.wait_for_timeout(300)
        rep(had and pg.query_selector('.peek') is None, 'peek hides on scroll', f'had={had} after={pg.query_selector(".peek") is not None}')
        l = [x for x in pg.query_selector_all('.tabpane:not(.hidden) [data-testid=code] .t-link') if 'Form_Load' not in x.inner_text()][0]
        l.hover(); pg.wait_for_timeout(900); l.click(); pg.wait_for_timeout(600)
        rep(pg.query_selector('.peek') is None, 'peek hides after navigation')
        pg.keyboard.press('Alt+ArrowLeft'); pg.wait_for_timeout(400)
    probe('peek', t4)

    # 5. context menu closes on scroll and near-edge placement
    def t5():
        c = pg.query_selector('.tabpane:not(.hidden) [data-testid=code]').bounding_box()
        pg.mouse.click(c['x'] + c['width'] - 5, c['y'] + c['height'] - 5, button='right'); pg.wait_for_timeout(200)
        m = pg.query_selector('[data-testid=ctxmenu]')
        if m:
            mb = m.bounding_box(); vw = pg.viewport_size
            rep(mb['x'] + mb['width'] <= vw['width'] and mb['y'] + mb['height'] <= vw['height'], 'context menu stays inside viewport', mb)
            pg.mouse.wheel(0, 300); pg.wait_for_timeout(200)
            rep(pg.query_selector('[data-testid=ctxmenu]') is None, 'context menu closes on scroll')
        else: rep(False, 'context menu opens at edge')
        pg.keyboard.press('Escape')
    probe('ctx', t5)

    # 6. Hebrew string rendering keeps code order (bidi isolation)
    def t6():
        open_proc('kelet.show_big_arrival'); pg.wait_for_timeout(400)
        line = [x for x in pg.query_selector_all('.tabpane:not(.hidden) [data-testid=code] .cl') if '"כ"' in x.inner_text()]
        if not line: rep(False, 'hebrew line found', [x.inner_text()[:40] for x in pg.query_selector_all('.tabpane:not(.hidden) [data-testid=code] .cl')][:14] or pg.inner_text('.tabpane:not(.hidden)')[:300]); return
        iso = pg.evaluate('''() => { const s = [...document.querySelectorAll('.tabpane:not(.hidden) [data-testid=code] .t-str')].find(e => /[\\u0590-\\u05ff]/.test(e.textContent)); return s ? getComputedStyle(s).unicodeBidi : 'none'; }''')
        rep(iso in ('isolate', 'plaintext', 'isolate-override'), 'string tokens are bidi-isolated', iso)
    probe('bidi', t6)

    # 7. rename validation
    def t7():
        open_proc('kelet.Form_Load')
        pg.keyboard.press('n'); pg.wait_for_selector('[data-testid=prompt]'); pg.keyboard.press('Control+a'); pg.keyboard.type('123 bad name!'); pg.keyboard.press('Enter'); pg.wait_for_timeout(800)
        t = pg.inner_text('.tab.active')
        rep(not t.split('.')[-1][0].isdigit(), 'rename rejects/sanitises invalid VB identifier', t)
        pg.keyboard.press('n'); pg.wait_for_selector('[data-testid=prompt]'); pg.keyboard.press('Control+a'); pg.keyboard.press('Backspace'); pg.keyboard.press('Enter'); pg.wait_for_timeout(500)
        rep(pg.inner_text('.tab.active') != '', 'empty rename ignored', pg.inner_text('.tab.active'))
    probe('rename', t7)

    # 8. tree filter with no matches shows feedback
    def t8():
        pg.fill('[data-testid=tree-filter]', 'zzzznomatchzzz'); pg.wait_for_timeout(300)
        txt = pg.inner_text('.panel')
        rep('No match' in txt or 'no match' in txt.lower(), 'tree shows "no matches"', txt[:80].replace('\n', ' | '))
        pg.fill('[data-testid=tree-filter]', '')
    probe('tree filter', t8)

    # 9. small viewport
    def t9():
        pg.set_viewport_size({'width': 1024, 'height': 640}); pg.wait_for_timeout(500)
        top = pg.query_selector('.topbar'); tw = top.evaluate('e => [e.scrollWidth, e.clientWidth]')
        rep(tw[0] <= tw[1] + 1, 'topbar fits at 1024px', tw)
        center = pg.query_selector('.center').bounding_box()
        rep(center['width'] > 350, 'code area keeps usable width at 1024px', center['width'])
        st = pg.query_selector('.status'); sw = st.evaluate('e => [e.scrollWidth, e.clientWidth]')
        rep(sw[0] <= sw[1] + 1, 'status bar fits at 1024px', sw)
        pg.screenshot(path=SHOTS + 'a9-1024.png')
        pg.set_viewport_size({'width': 800, 'height': 600}); pg.wait_for_timeout(500)
        center = pg.query_selector('.center').bounding_box()
        rep(center['width'] > 300, 'code area usable at 800px', center['width'])
        pg.screenshot(path=SHOTS + 'a9-800.png')
        pg.set_viewport_size({'width': 1600, 'height': 950}); pg.wait_for_timeout(300)
    probe('viewport', t9)

    # 10. mouse back button must not leave the app
    def t10():
        u0 = pg.url
        pg.mouse.move(800, 400)
        pg.evaluate('''() => { const ev = new MouseEvent('mouseup', {button: 3, bubbles: true}); document.querySelector('.tabpane:not(.hidden) [data-testid=code]')?.dispatchEvent(ev); }''')
        pg.go_back(timeout=3000) if False else None
        has = pg.evaluate('() => !!window.onbeforeunload || document.body.dataset.guard === "1"')
        rep(has, 'beforeunload guard / history guard installed while a file is open', has)
    probe('back', t10)

    # 11. hex keyboard without selection
    def t11():
        pg.keyboard.press('Control+k'); pg.keyboard.type('>hex'); pg.wait_for_timeout(300); pg.keyboard.press('Enter'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=hex]'); pg.wait_for_timeout(600)
        pg.click('.tabpane:not(.hidden) [data-testid=hex] .code'); pg.keyboard.press('ArrowDown'); pg.keyboard.press('ArrowRight'); pg.wait_for_timeout(200)
        rep(pg.query_selector('.tabpane:not(.hidden) [data-testid=hex] .hs') is not None, 'hex arrow keys start a selection', '')
    probe('hex', t11)

    # 12. table keyboard navigation
    def t12():
        pg.keyboard.press('Control+k'); pg.keyboard.type('>strings'); pg.wait_for_timeout(300); pg.keyboard.press('Enter'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=strings]'); pg.wait_for_timeout(400)
        pg.click('.tabpane:not(.hidden) [data-testid=strings] .tbl-row >> nth=2'); pg.wait_for_timeout(200)
        first = pg.inner_text('.tabpane:not(.hidden) [data-testid=strings] .tbl-row.on')
        pg.keyboard.press('ArrowDown'); pg.wait_for_timeout(150)
        sec = pg.inner_text('.tabpane:not(.hidden) [data-testid=strings] .tbl-row.on') if pg.query_selector('.tabpane:not(.hidden) [data-testid=strings] .tbl-row.on') else ''
        rep(first != sec, 'table arrow-key navigation', f'{first[:30]!r} -> {sec[:30]!r}')
        pg.keyboard.press('Escape')
    probe('table keys', t12)

    # 13. designer menu closes on outside click / Escape
    def t13():
        tree_click(pg, 'obj:1'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=designer]'); pg.wait_for_timeout(600)
        m = pg.query_selector('.win-menu > span'); m.click(); pg.wait_for_timeout(200)
        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        rep(pg.query_selector('.menu-drop') is None, 'designer menu closes on Escape')
        m.click(); pg.wait_for_timeout(200); pg.mouse.click(5, 300); pg.wait_for_timeout(200)
        rep(pg.query_selector('.menu-drop') is None, 'designer menu closes on outside click')
    probe('designer menu', t13)

    # 14. splitter: drag far, persists
    def t14():
        s = pg.query_selector_all('.splitter')[0].bounding_box()
        pg.mouse.move(s['x'] + 2, s['y'] + 300); pg.mouse.down(); pg.mouse.move(2000, s['y'] + 300, steps=5); pg.mouse.up()
        w = pg.query_selector('.panel').bounding_box()['width']
        rep(w <= 700, 'left panel width clamped', w)
        sel = pg.evaluate('() => String(window.getSelection())')
        rep(sel == '', 'no text selected while dragging splitter', sel[:40])
    probe('splitter', t14)

    # 15. clipboard copy works (or falls back)
    def t15():
        ctx.grant_permissions(['clipboard-read', 'clipboard-write'])
        open_proc('kelet.Form_Load')
        pg.click('.toolbar button[title="Copy source"]'); pg.wait_for_timeout(300)
        clip = pg.evaluate('navigator.clipboard.readText()')
        rep('Form_Load' in clip, 'copy source to clipboard', len(clip))
    probe('clipboard', t15)

    # 16. worker crash recovery: terminate the worker, then request
    def t16():
        pg.evaluate('() => window.__vblens.simulateCrash()'); pg.wait_for_timeout(500)
        bar = pg.query_selector('[data-testid=crashbar]')
        rep(bar is not None, 'worker failure surfaces an error banner')
        if bar:
            pg.click('[data-testid=crashbar] button'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=overview]', timeout=60000); pg.wait_for_timeout(500)
            rep(pg.query_selector('[data-testid=crashbar]') is None and 'MyLoad' not in '', 'reload after crash restores the workspace')
    probe('worker', t16)

    print('PAGE ERRORS', json.dumps(errors[:20], ensure_ascii=False))
    b.close()
print('SUMMARY', sum(1 for r in res if r[0]), 'ok,', sum(1 for r in res if not r[0]), 'bugs')
