import sys, json, os
from playwright.sync_api import sync_playwright
from config import DIST, EXE, PCODE, BAD, TLB, SHOTS, launch
from treehelp import tree_click
OUT = SHOTS
os.makedirs(OUT, exist_ok=True)
errors = []
def shot(pg, n): pg.screenshot(path=OUT + n + '.png')
with sync_playwright() as p:
    b = launch(p)
    pg = b.new_page(viewport={'width': 1600, 'height': 950})
    pg.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: errors.append(f'PAGEERROR: {e}'))
    pg.goto(DIST); pg.wait_for_timeout(700); shot(pg, '01-landing')
    pg.set_input_files('[data-testid=file-input]', EXE)
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=overview]', timeout=60000); pg.wait_for_timeout(500); shot(pg, '02-overview')
    # form designer: first form
    tree_click(pg, 'obj:0'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=designer]', timeout=20000); pg.wait_for_timeout(800); shot(pg, '03-designer')
    # select a control in designer
    ctl = pg.query_selector('.tabpane:not(.hidden) [data-testid=designer] .ctl.button') or pg.query_selector('.tabpane:not(.hidden) [data-testid=designer] .ctl')
    if ctl: ctl.click(); pg.wait_for_timeout(300); shot(pg, '04-designer-sel')
    # object code
    pg.click('.tabpane:not(.hidden) [data-testid=viewseg] button:has-text("Code")'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=code]', timeout=60000); pg.wait_for_timeout(500); shot(pg, '05-objcode')
    # open a procedure through palette
    pg.keyboard.press('Control+k'); pg.wait_for_selector('[data-testid=palette]'); pg.keyboard.type('cancel_hide'); pg.wait_for_timeout(500); shot(pg, '06-palette')
    pg.keyboard.press('Enter'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=code]'); pg.wait_for_timeout(600); shot(pg, '07-proc')
    pg.click('.tabpane:not(.hidden) [data-testid=viewseg] button:has-text("Disassembly")'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=disasm]'); pg.wait_for_timeout(400); shot(pg, '08-asm')
    pg.click('.tabpane:not(.hidden) [data-testid=viewseg] button:has-text("Graph")'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=graph]'); pg.wait_for_timeout(600); shot(pg, '09-graph')
    pg.click('.tabpane:not(.hidden) [data-testid=viewseg] button:has-text("Split")'); pg.wait_for_timeout(800); shot(pg, '10-split')
    # strings table
    tree_click(pg, 'strings'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=strings]'); pg.wait_for_timeout(400); shot(pg, '11-strings')
    tree_click(pg, 'imports'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=imports]'); pg.wait_for_timeout(300); shot(pg, '12-imports')
    tree_click(pg, 'hex'); pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=hex]'); pg.wait_for_timeout(800); shot(pg, '13-hex')
    print('ERRORS', json.dumps(errors[:30], ensure_ascii=False, indent=1))
    b.close()
