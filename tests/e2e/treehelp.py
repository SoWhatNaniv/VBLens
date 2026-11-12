def tree_click(pg, data_id, part='.lbl'):
    """Scroll the virtualised project tree until the row exists, then click it."""
    sel = f'.tree-row[data-id="{data_id}"] {part}'
    pg.eval_on_selector('[data-testid=tree]', 'e => e.scrollTop = 0'); pg.wait_for_timeout(100)
    for _ in range(200):
        if pg.query_selector(sel):
            pg.query_selector(sel).scroll_into_view_if_needed(); pg.click(sel); return
        pg.eval_on_selector('[data-testid=tree]', 'e => e.scrollTop += e.clientHeight * 0.8'); pg.wait_for_timeout(60)
    raise Exception('tree row not found: ' + data_id)
