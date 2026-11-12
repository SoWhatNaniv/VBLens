# Browser tests

End-to-end tests that drive the built app (`dist/index.html` from `npm run build`) in Chromium with
[Playwright for Python](https://playwright.dev/python/).

```bash
pip install playwright && playwright install chromium     # once
npm run build                                              # from the repository root
export VB_SAMPLE=/path/to/EshkolPlus.exe   # native VB6 sample the tests were written against
export VB_PCODE=/path/to/pePropertySheet.ocx   # optional: a P-Code binary
export VB_BAD=/path/to/any-non-vb.ocx          # optional: a PE that is not VB
export VB_TLB=/path/to/MSCOMCTL.OCX            # optional: a type library to load
python3 run.py      # smoke test + screenshots of every view
python3 run2.py     # navigation, rename, comments, palette, grep, export, persistence
python3 run4.py     # P-Code views
python3 scroll.py   # every panel scrolls at two window sizes
python3 findbar_scroll.py   # Ctrl+F box stays on screen in scrolled code/disassembly
python3 live.py     # MCP server + app together (needs npm run build:mcp and pip install mcp)
python3 desktop.py  # the packaged desktop app: engine, AI agent switch and token (npm run dist:linux)
python3 window_size.py  # desktop window fits small/scaled screens and the app follows resizes (Xvfb + python-xlib)
python3 audit.py audit2.py audit3.py   # edge cases (tabs, wheel, back button, bidi, crashes...)
python3 readme_shots.py  # README screenshots from the packaged app (VB_SAMPLE=SemiVBDecompiler.exe)
```

Several checks reference procedure and form names from the EshkolPlus sample (for example
`kelet.Form_Load`); adapt them when testing with another binary. Screenshots go to `shots/`.
