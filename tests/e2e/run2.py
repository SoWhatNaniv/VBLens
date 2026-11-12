import json, os
from playwright.sync_api import sync_playwright
from config import DIST, EXE, PCODE, BAD, TLB, SHOTS, launch
from treehelp import tree_click
MSCOMCTL = TLB
OUT = SHOTS
errors = []
def shot(pg, n): pg.screenshot(path=OUT + n + '.png')
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
with sync_playwright() as p:
    b = launch(p)
    ctx = b.new_context(viewport={'width': 1600, 'height': 950}, accept_downloads=True)
    pg = ctx.new_page()
    pg.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: errors.append(f'PAGEERROR: {e}'))
    pg.on('dialog', lambda d: d.accept())
    pg.goto(DIST); pg.set_input_files('[data-testid=file-input]', EXE)
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=overview]', timeout=60000)
    # G goto by name
    pg.keyboard.press('g'); pg.wait_for_selector('[data-testid=prompt]')
    pg.keyboard.type('kelet.Form_Load'); pg.keyboard.press('Enter')
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=code]', timeout=20000); pg.wait_for_timeout(500)
    tab = pg.inner_text('.tab.active')
    check('Form_Load' in tab, 'goto by name opens kelet.Form_Load: ' + tab)
    shot(pg, '20-formload')
    # click a link in code
    links = [l for l in pg.query_selector_all('.tabpane:not(.hidden) [data-testid=code] .t-link') if 'Form_Load' not in l.inner_text()]
    check(len(links) > 0, f'code has {len(links)} links')
    if links:
        t = links[0].inner_text()
        links[0].hover(); pg.wait_for_timeout(900); shot(pg, '21-peek')
        check(pg.query_selector('.peek') is not None, 'peek tooltip appears on hover of ' + t)
        links[0].click(); pg.wait_for_timeout(800)
        check(pg.inner_text('.tab.active') != tab, 'clicking link navigates to ' + pg.inner_text('.tab.active'))
        pg.keyboard.press('Alt+ArrowLeft'); pg.wait_for_timeout(500)
        check('Form_Load' in pg.inner_text('.tab.active'), 'Alt+Left goes back: ' + pg.inner_text('.tab.active'))
    # Tab toggles to disassembly
    pg.click('.tabpane:not(.hidden) [data-testid=code]'); pg.keyboard.press('Tab'); pg.wait_for_timeout(400)
    check(pg.query_selector('.tabpane:not(.hidden) [data-testid=disasm]') is not None, 'Tab switches to disassembly')
    pg.keyboard.press(' '); pg.wait_for_timeout(600)
    check(pg.query_selector('.tabpane:not(.hidden) [data-testid=graph]') is not None, 'Space switches to graph')
    shot(pg, '22-graph')
    pg.keyboard.press('Tab'); pg.wait_for_timeout(300)
    # X xrefs
    pg.keyboard.press('x'); pg.wait_for_selector('[data-testid=xrefs]'); pg.wait_for_timeout(500); shot(pg, '23-xrefs')
    pg.keyboard.press('Escape')
    # N rename
    pg.keyboard.press('n'); pg.wait_for_selector('[data-testid=prompt]'); pg.keyboard.press('Control+a'); pg.keyboard.type('MyLoadHandler'); pg.keyboard.press('Enter')
    pg.wait_for_timeout(1500)
    check('MyLoadHandler' in pg.inner_text('.tab.active'), 'rename updates tab: ' + pg.inner_text('.tab.active'))
    check(pg.query_selector('.tree-row:has-text("MyLoadHandler")') is not None, 'rename updates tree')
    # context menu in code
    pg.click('.tabpane:not(.hidden) [data-testid=viewseg] button:has-text("Code")'); pg.wait_for_timeout(500)
    rows = pg.query_selector_all('.tabpane:not(.hidden) [data-testid=code] .cl')
    rows[3].click(button='right'); pg.wait_for_timeout(300)
    check(pg.query_selector('[data-testid=ctxmenu]') is not None, 'context menu')
    shot(pg, '24-ctx')
    pg.keyboard.press('Escape'); pg.mouse.click(700, 600)
    # comment
    rows = pg.query_selector_all('.tabpane:not(.hidden) [data-testid=code] .cl')
    rows[4].click(); pg.keyboard.press(';'); pg.wait_for_selector('[data-testid=prompt]'); pg.keyboard.type('checked by niv'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1000)
    check('checked by niv' in pg.inner_text('.tabpane:not(.hidden) [data-testid=code]'), 'comment shows in code')
    # palette search for control + designer selection
    pg.keyboard.press('Control+k'); pg.keyboard.type('CmdLogin'); pg.wait_for_timeout(600); pg.keyboard.press('Enter')
    try: pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=designer] .ctl.selc', timeout=8000); ok = True
    except Exception: ok = False
    check(ok, 'palette control -> designer selection (' + pg.inner_text('.tab.active') + ')')
    shot(pg, '25-login')
    # menus in MDI form
    tree_click(pg, 'obj:1'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=designer]'); pg.wait_for_timeout(800)
    m = pg.query_selector('.win-menu > span')
    if m: m.click(); pg.wait_for_timeout(400)
    shot(pg, '26-mdi-menu')
    check(pg.query_selector('.menu-drop') is not None, 'menu dropdown opens')
    # grep
    pg.keyboard.press('Control+Shift+F'); pg.wait_for_selector('[data-testid=prompt]'); pg.keyboard.type('MsgBox'); pg.keyboard.press('Enter')
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=grep] .g', timeout=120000); pg.wait_for_timeout(300)
    n = len(pg.query_selector_all('.tabpane:not(.hidden) [data-testid=grep] .g'))
    check(n > 0, f'grep MsgBox finds {n} hits'); shot(pg, '27-grep')
    # export
    with pg.expect_download(timeout=120000) as dl:
        pg.click('[data-testid=export]')
    d = dl.value; path = SHOTS + 'export.zip'; d.save_as(path)
    check(os.path.getsize(path) > 10000, f'export zip {os.path.getsize(path)} bytes')
    # type library loading
    if not MSCOMCTL: print('SKIP type library test: set VB_TLB'); MSCOMCTL = None
    if MSCOMCTL: pg.set_input_files('input[type=file][accept*=ocx]', [MSCOMCTL])
    if MSCOMCTL:
        pg.wait_for_selector('[data-testid=toast]:has-text("Loaded type library")', timeout=60000)
        check(True, 'type library loaded: ' + pg.inner_text('[data-testid=toast]'))
    # reload & verify rename persisted
    pg.reload(); pg.set_input_files('[data-testid=file-input]', EXE); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=overview]', timeout=60000); pg.wait_for_timeout(800)
    pg.fill('[data-testid=tree-filter]', 'MyLoad'); pg.wait_for_timeout(400)
    check(pg.query_selector('.tree-row:has-text("MyLoadHandler")') is not None, 'rename persisted across reload')
    print('ERRORS', json.dumps(errors[:30], ensure_ascii=False, indent=1))
    b.close()
