import glob, json
from playwright.sync_api import sync_playwright
from config import DIST, EXE, PCODE, BAD, TLB, SHOTS, launch
from treehelp import tree_click
PC = PCODE
res = []
def rep(ok, name, info=''):
    res.append(ok); print(('OK  ' if ok else 'BUG ') + name + (' :: ' + str(info) if info != '' else ''), flush=True)
def probe(fn):
    try: fn()
    except Exception as e: rep(False, fn.__name__, 'EXC ' + str(e).split('\n')[0][:220])
errors = []
with sync_playwright() as p:
    b = launch(p)
    ctx = b.new_context(viewport={'width': 1600, 'height': 950}, accept_downloads=True)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type == 'error' else None)
    pg.on('dialog', lambda d: d.dismiss())
    pg.goto(DIST)
    pg.set_input_files('[data-testid=file-input]', EXE)
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=overview]', timeout=60000); pg.wait_for_timeout(400)
    def goto(name):
        pg.keyboard.press('Escape'); pg.keyboard.press('g'); pg.wait_for_selector('[data-testid=prompt]'); pg.keyboard.type(name); pg.keyboard.press('Enter'); pg.wait_for_timeout(700)
    def toast(): t = pg.query_selector('[data-testid=toast]'); return t.inner_text() if t else ''

    def browser_back():
        goto('kelet.Form_Load'); goto('kelet.cancel_hide_cols')
        pg.evaluate('history.back()'); pg.wait_for_timeout(800)
        rep(pg.url.endswith('index.html') and pg.query_selector('[data-testid=workspace]') is not None, 'browser Back keeps the app open', pg.url[-30:])
        rep('Form_Load' in pg.inner_text('.tab.active'), 'browser Back = workspace back', pg.inner_text('.tab.active'))
    probe(browser_back)

    def goto_errors():
        goto('FFFFFFF0'); pg.wait_for_timeout(300)
        rep('not mapped' in toast(), 'goto unmapped address explains', toast())
        goto('NoSuchProcName123'); pg.wait_for_timeout(600)
        rep('Nothing named' in toast(), 'goto unknown name explains', toast())
    probe(goto_errors)

    def tree_keyboard():
        pg.fill('[data-testid=tree-filter]', 'frm_find'); pg.wait_for_timeout(300)
        pg.focus('[data-testid=tree-filter]'); pg.keyboard.press('ArrowDown'); pg.keyboard.press('ArrowDown'); pg.keyboard.press('Enter'); pg.wait_for_timeout(800)
        rep('frm_find' in pg.inner_text('.tab.active'), 'tree keyboard: filter, arrows, Enter opens', pg.inner_text('.tab.active'))
        pg.fill('[data-testid=tree-filter]', '')
    probe(tree_keyboard)

    def close_all():
        pg.click('.tab.active', button='right'); pg.wait_for_timeout(200)
        pg.click('[data-testid=ctxmenu] >> text=Close all'); pg.wait_for_timeout(300)
        rep(len(pg.query_selector_all('.tab')) == 1 and pg.query_selector('.tabpane:not(.hidden) [data-testid=overview]') is not None, 'close all tabs leaves Overview', len(pg.query_selector_all('.tab')))
    probe(close_all)

    def graph_hidden_then_shown():
        goto('kelet.cancel_hide_cols'); pg.keyboard.press(' '); pg.wait_for_timeout(200)
        pg.click('.tab:has-text("Overview")'); pg.wait_for_timeout(200)
        goto('kelet.Form_Load'); pg.click('.tab:has-text("cancel_hide_cols")'); pg.wait_for_timeout(500)
        nodes = [n.bounding_box() for n in pg.query_selector_all('.tabpane:not(.hidden) [data-testid=graph] .gnode')]
        g = pg.query_selector('.tabpane:not(.hidden) [data-testid=graph]').bounding_box()
        vis = [n for n in nodes if n and n['x'] < g['x'] + g['width'] and n['x'] + n['width'] > g['x'] and n['y'] < g['y'] + g['height'] and n['y'] + n['height'] > g['y']]
        rep(len(vis) > 0, 'graph visible after switching tabs', f'{len(vis)}/{len(nodes)} nodes on screen')
        pg.set_viewport_size({'width': 1200, 'height': 800}); pg.wait_for_timeout(400)
        nodes = [n.bounding_box() for n in pg.query_selector_all('.tabpane:not(.hidden) [data-testid=graph] .gnode')]
        g = pg.query_selector('.tabpane:not(.hidden) [data-testid=graph]').bounding_box()
        vis = [n for n in nodes if n and n['x'] < g['x'] + g['width'] and n['x'] + n['width'] > g['x']]
        rep(len(vis) > 0, 'graph still visible after window resize', len(vis))
        pg.set_viewport_size({'width': 1600, 'height': 950}); pg.keyboard.press(' ')
    probe(graph_hidden_then_shown)

    def copy_selection_excludes_gutter():
        goto('kelet.Form_Load'); pg.wait_for_timeout(300)
        us = pg.evaluate("() => { const g = document.querySelector('.tabpane:not(.hidden) [data-testid=code] .gut') || document.querySelector('.tabpane:not(.hidden) [data-testid=code] .addr'); return g ? getComputedStyle(g).userSelect : 'n/a'; }")
        rep(us == 'none', 'line numbers / addresses are not part of a text selection', us)
    probe(copy_selection_excludes_gutter)

    def export_twice():
        n = [0]
        pg.on('download', lambda d: n.__setitem__(0, n[0] + 1))
        pg.evaluate("() => { const b = document.querySelector('[data-testid=export]'); b.click(); b.click(); setTimeout(() => b.click(), 50); }")
        pg.wait_for_timeout(12000)
        rep(n[0] == 1, 'export clicked twice downloads once', n[0])
    probe(export_twice)

    def palette_weird_input():
        pg.keyboard.press('Control+k'); pg.keyboard.type('(.*[\\'); pg.wait_for_timeout(500)
        rep(pg.query_selector('[data-testid=palette]') is not None, 'palette survives regex characters')
        pg.keyboard.press('Control+a'); pg.keyboard.type('מכין'); pg.wait_for_timeout(600)
        rep(len(pg.query_selector_all('.pitem')) > 0, 'palette finds Hebrew text', len(pg.query_selector_all('.pitem')))
        pg.keyboard.press('Escape')
    probe(palette_weird_input)

    def bad_file_keeps_workspace():
        if not BAD: return rep(True, 'skipped (set VB_BAD)')
        pg.set_input_files('[data-testid=workspace] input[type=file]:not([accept])', BAD); pg.wait_for_timeout(2500)
        err = pg.query_selector('[data-testid=open-error]')
        rep(err is not None, 'opening a non-VB file from the workspace shows an error')
        goto('kelet.Form_Load'); pg.wait_for_timeout(500)
        rep(pg.query_selector('.tabpane:not(.hidden) [data-testid=code] .cl') is not None, 'previous file still works after a failed open')
    probe(bad_file_keeps_workspace)

    def second_file_no_stale_cache():
        if not PC: return rep(True, 'skipped (set VB_PCODE)')
        pg.set_input_files('[data-testid=workspace] input[type=file]:not([accept])', PC)
        pg.wait_for_function("() => document.title.startsWith('pePropertySheet')", timeout=60000); pg.wait_for_timeout(800)
        pg.keyboard.press('Control+k'); pg.keyboard.type('>strings'); pg.wait_for_timeout(300); pg.keyboard.press('Enter'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=strings]'); pg.wait_for_timeout(500)
        n = pg.inner_text('.tbl-tools')
        rep('3228' not in n, 'strings table belongs to the newly opened file', n.replace('\n', ' ')[:60])
        pg.keyboard.press('Control+k'); pg.keyboard.type('kelet'); pg.wait_for_timeout(600)
        items = [i.inner_text() for i in pg.query_selector_all('.pitem')]
        rep(not any('kelet.' in i for i in items), 'palette results belong to the new file', items[:2])
        pg.keyboard.press('Escape')
    probe(second_file_no_stale_cache)

    def small_screens():
        for w, h in [(1024, 640), (800, 600)]:
            pg.set_viewport_size({'width': w, 'height': h}); pg.wait_for_timeout(400)
            over = pg.evaluate('() => [document.documentElement.scrollWidth, window.innerWidth]')
            rep(over[0] <= over[1], f'no horizontal page overflow at {w}px', over)
            pg.screenshot(path=f'shots/b-{w}.png')
        pg.set_viewport_size({'width': 1600, 'height': 950})
    probe(small_screens)

    print('PAGE ERRORS', json.dumps(errors[:20], ensure_ascii=False))
    b.close()
print('SUMMARY', sum(res), 'ok,', len(res) - sum(res), 'bugs')
