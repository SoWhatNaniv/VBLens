import json, glob
from playwright.sync_api import sync_playwright
from config import DIST, EXE, PCODE, BAD, TLB, SHOTS, launch
from treehelp import tree_click
F = PCODE
import sys
if not PCODE: print('SKIP: set VB_PCODE to a P-Code VB binary'); sys.exit(0)
errors = []
with sync_playwright() as p:
    b = launch(p)
    pg = b.new_page(viewport={'width': 1600, 'height': 950})
    pg.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error',) else None)
    pg.on('pageerror', lambda e: errors.append(f'PAGEERROR: {e}'))
    pg.goto(DIST); pg.set_input_files('[data-testid=file-input]', F)
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=overview]', timeout=60000); pg.wait_for_timeout(500)
    pg.screenshot(path=SHOTS + '40-pc-overview.png')
    pg.keyboard.press('g'); pg.keyboard.type('isButton.UserControl_KeyDown'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
    pg.screenshot(path=SHOTS + '41-pc-code.png')
    pg.keyboard.press('Tab'); pg.wait_for_timeout(600); pg.screenshot(path=SHOTS + '42-pc-asm.png')
    pg.keyboard.press(' '); pg.wait_for_timeout(800); pg.screenshot(path=SHOTS + '43-pc-graph.png')
    pg.keyboard.press('Control+k'); pg.keyboard.type('isButton'); pg.wait_for_timeout(700); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200); pg.screenshot(path=SHOTS + '44-pc-designer.png')
    print('ERRORS', json.dumps(errors[:20], indent=1))
    b.close()
