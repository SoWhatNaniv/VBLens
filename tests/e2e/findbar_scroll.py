"""Ctrl+F must show the find bar inside the visible area however far the view is scrolled."""
from playwright.sync_api import sync_playwright
from config import DIST, EXE, SHOTS, launch
from treehelp import tree_click

res = []
def rep(ok, name, info=''):
    res.append(ok); print(('PASS ' if ok else 'FAIL ') + name + (f' :: {info}' if info != '' else ''), flush=True)

errors = []
with sync_playwright() as p:
    b = launch(p)
    pg = b.new_page(viewport={'width': 1400, 'height': 850})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('dialog', lambda d: d.dismiss())
    pg.goto(DIST); pg.set_input_files('[data-testid=file-input]', EXE)
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=overview]', timeout=60000); pg.wait_for_timeout(400)

    def visible_in(sel):
        """find bar box vs the scroller's visible box"""
        return pg.evaluate("""sel => {
            const sc = document.querySelector(sel), fb = document.querySelector('.tabpane:not(.hidden) .findbar');
            if (!sc || !fb) return null;
            const a = sc.getBoundingClientRect(), f = fb.getBoundingClientRect();
            return { inside: f.top >= a.top - 1 && f.bottom <= a.bottom + 1 && f.left >= a.left - 1 && f.right <= a.right + 1,
                     top: Math.round(f.top - a.top), right: Math.round(a.right - f.right), scrollTop: sc.scrollTop, scrollLeft: sc.scrollLeft,
                     focused: document.activeElement === fb.querySelector('input') };
        }""", sel)

    def check(view, sel, scroll_left=0):
        # scroll, then focus without clicking (a click would scroll the clicked row back into view)
        pg.evaluate("([s, l]) => { const e = document.querySelector(s); e.scrollTop = e.scrollHeight * 0.6; e.scrollLeft = l; e.focus({ preventScroll: true }); }", [sel, scroll_left])
        pg.wait_for_timeout(250)
        before = pg.evaluate("s => document.querySelector(s).scrollTop", sel)
        pg.keyboard.press('Control+f'); pg.wait_for_timeout(300)
        v = visible_in(sel)
        if scroll_left: rep(v is not None and v['scrollLeft'] > 0, f'{view}: view really is scrolled sideways', v)
        rep(v is not None and v['inside'] and v['top'] < 30, f'{view}: find bar on screen at the top after scrolling', v)
        rep(v is not None and v['focused'], f'{view}: find box has focus', v)
        rep(v is not None and abs(v['scrollTop'] - before) < 2, f'{view}: opening find does not jump the scroll position', f"{before} -> {v and v['scrollTop']}")
        pg.keyboard.type('Me.'); pg.wait_for_timeout(300)
        n = pg.inner_text('.tabpane:not(.hidden) .findbar span')
        pg.keyboard.press('Enter'); pg.wait_for_timeout(300)
        v2 = visible_in(sel)
        rep(v2 is not None and v2['inside'], f'{view}: find bar stays visible while jumping between matches ({n})', v2)
        pg.screenshot(path=SHOTS + f'findbar-{view}.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        rep(pg.query_selector('.tabpane:not(.hidden) .findbar') is None, f'{view}: Escape closes it')

    tree_click(pg, 'obj:1')  # MDIREKA: a long module-wide listing
    pg.wait_for_timeout(600)
    pg.click('.tabpane:not(.hidden) [data-testid=view-code]') if pg.query_selector('.tabpane:not(.hidden) [data-testid=view-code]') else None
    pg.keyboard.press('Escape'); pg.keyboard.press('g'); pg.wait_for_selector('[data-testid=prompt]')
    pg.keyboard.type('kelet.Proc_0_100_5F6020'); pg.keyboard.press('Enter')
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=code] .cl', timeout=30000); pg.wait_for_timeout(500)
    check('code', '.tabpane:not(.hidden) [data-testid=code]')
    # a narrow window makes long lines overflow sideways: the bar must not slide away horizontally either
    pg.set_viewport_size({'width': 760, 'height': 700}); pg.wait_for_timeout(400)
    check('code scrolled sideways', '.tabpane:not(.hidden) [data-testid=code]', 600)
    pg.set_viewport_size({'width': 1400, 'height': 850}); pg.wait_for_timeout(400)
    pg.click('.tabpane:not(.hidden) [data-testid=code]'); pg.keyboard.press('Tab')
    pg.wait_for_selector('.tabpane:not(.hidden) [data-testid=disasm] .cl', timeout=30000); pg.wait_for_timeout(500)
    check('disassembly', '.tabpane:not(.hidden) [data-testid=disasm]')
    rep(not errors, 'no page errors', errors[:3])
    b.close()
print(f"SUMMARY {sum(res)}/{len(res)} passed")
