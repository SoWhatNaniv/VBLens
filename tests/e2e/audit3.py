import json
from playwright.sync_api import sync_playwright
from config import DIST, EXE, PCODE, BAD, TLB, SHOTS, launch
from treehelp import tree_click
res = []
def rep(ok, name, info=''):
    res.append(ok); print(('OK  ' if ok else 'BUG ') + name + (' :: ' + str(info) if info != '' else ''), flush=True)
def probe(fn):
    try: fn()
    except Exception as e: rep(False, fn.__name__, 'EXC ' + str(e).split('\n')[0][:220])
errors = []
with sync_playwright() as p:
    b = launch(p)
    pg = b.new_page(viewport={'width': 1600, 'height': 950})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type == 'error' else None)
    pg.on('dialog', lambda d: d.dismiss())
    pg.goto(DIST); pg.set_input_files('[data-testid=file-input]', EXE)
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=overview]', timeout=60000); pg.wait_for_timeout(400)
    def goto(name):
        pg.keyboard.press('Escape'); pg.keyboard.press('g'); pg.wait_for_selector('[data-testid=prompt]'); pg.keyboard.type(name); pg.keyboard.press('Enter'); pg.wait_for_timeout(700)

    def overview_links():
        pg.click('.tabpane:not(.hidden) [data-testid=overview] .t-link >> nth=0'); pg.wait_for_timeout(800)
        rep(pg.query_selector('.tab.active') and 'Overview' not in pg.inner_text('.tab.active'), 'overview entry-point link navigates', pg.inner_text('.tab.active'))
    probe(overview_links)

    def find_bar():
        goto('kelet.show_big_arrival')
        pg.click('.tabpane:not(.hidden) [data-testid=code] .cl >> nth=2'); pg.keyboard.press('Control+f'); pg.wait_for_timeout(200)
        fb = pg.query_selector('.findbar input')
        rep(fb is not None, 'Ctrl+F opens find bar in code view')
        if fb:
            pg.keyboard.type('m_140'); pg.wait_for_timeout(300)
            c1 = pg.inner_text('.findbar span'); pg.keyboard.press('Enter'); pg.wait_for_timeout(200); c2 = pg.inner_text('.findbar span')
            rep(c1 != c2 and '/' in c2, 'find next with Enter', f'{c1} -> {c2}')
            pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
            rep(pg.query_selector('.findbar') is None, 'Escape closes find bar')
            pg.keyboard.press('Control+f'); pg.keyboard.type('כ'); pg.wait_for_timeout(300)
            rep('/' in pg.inner_text('.findbar span'), 'find Hebrew text', pg.inner_text('.findbar span')); pg.keyboard.press('Escape')
    probe(find_bar)

    def split_sync():
        pg.click('.tabpane:not(.hidden) [data-testid=viewseg] button:has-text("Split")'); pg.wait_for_timeout(800)
        rows = pg.query_selector_all('.tabpane:not(.hidden) [data-testid=disasm] .cl')
        target = rows[min(40, len(rows) - 1)]; va = target.inner_text().split()[0]
        target.click(); pg.wait_for_timeout(300)
        cur = pg.query_selector('.tabpane:not(.hidden) [data-testid=code] .cl.cur')
        rep(cur is not None, 'split: clicking asm highlights the code line', va)
        pg.click('.tabpane:not(.hidden) [data-testid=viewseg] button:has-text("Code")')
    probe(split_sync)

    def designer_zoom():
        tree_click(pg, 'obj:1'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=designer]'); pg.wait_for_timeout(600)
        pg.click('.designer-legend button:has-text("150%")'); pg.wait_for_timeout(300)
        d = pg.query_selector('.tabpane:not(.hidden) [data-testid=designer]'); sw = d.evaluate('e => [e.scrollWidth, e.clientWidth, e.scrollHeight, e.clientHeight]')
        rep(sw[0] >= sw[1], 'designer at 150% is scrollable', sw)
        pg.screenshot(path=SHOTS + 'c-designer150.png')
    probe(designer_zoom)

    def rename_duplicate():
        goto('kelet.Form_Load'); pg.keyboard.press('n'); pg.wait_for_selector('[data-testid=prompt]')
        pg.keyboard.press('Control+a'); pg.keyboard.type('Form_Activate'); pg.wait_for_timeout(200)
        e = pg.query_selector('[data-testid=prompt-error]')
        rep(e is not None, 'rename to an existing procedure name is flagged', e.inner_text() if e else '')
        pg.keyboard.press('Escape')
    probe(rename_duplicate)

    def keyboard_after_dialog():
        goto('kelet.Form_Load'); pg.keyboard.press('x'); pg.wait_for_selector('[data-testid=xrefs]'); pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        pg.keyboard.press('Tab'); pg.wait_for_timeout(300)
        rep(pg.query_selector('.tabpane:not(.hidden) [data-testid=disasm]') is not None, 'shortcuts work right after closing a dialog')
        pg.keyboard.press('Tab')
    probe(keyboard_after_dialog)

    def middle_click_tab():
        n0 = len(pg.query_selector_all('.tab'))
        t = pg.query_selector('.tab.active').bounding_box()
        pg.mouse.click(t['x'] + 20, t['y'] + 10, button='middle'); pg.wait_for_timeout(300)
        rep(len(pg.query_selector_all('.tab')) == n0 - 1, 'middle-click closes a tab', f'{n0} -> {len(pg.query_selector_all(".tab"))}')
    probe(middle_click_tab)

    print('PAGE ERRORS', json.dumps(errors[:20], ensure_ascii=False))
    b.close()
print('SUMMARY', sum(res), 'ok,', len(res) - sum(res), 'bugs')
