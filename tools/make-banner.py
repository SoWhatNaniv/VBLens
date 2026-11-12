import base64, pathlib
from playwright.sync_api import sync_playwright
R=pathlib.Path(__file__).resolve().parent.parent
f=lambda w: base64.b64encode((R/f'node_modules/@fontsource/inter/files/inter-latin-{w}-normal.woff2').read_bytes()).decode()
logo=(R/'desktop/assets/logo.svg').read_text()
html=f'''<html><head><style>
@font-face{{font-family:I;src:url(data:font/woff2;base64,{f(400)});font-weight:400}}
@font-face{{font-family:I;src:url(data:font/woff2;base64,{f(800)});font-weight:800}}
body{{margin:0}}
.b{{width:1280px;height:360px;box-sizing:border-box;border-radius:24px;overflow:hidden;position:relative;font-family:I;
 background:radial-gradient(700px 300px at 15% 0%,rgba(139,108,255,.35),transparent 70%),radial-gradient(700px 320px at 95% 110%,rgba(34,211,238,.28),transparent 70%),#0b0f17;
 display:flex;align-items:center;gap:44px;padding:0 80px;color:#e6e9f2}}
.hex{{position:absolute;inset:0;font:13px monospace;color:rgba(139,108,255,.13);line-height:17px;white-space:pre;overflow:hidden;letter-spacing:3px}}
.logo{{width:170px;height:170px;flex:none;position:relative;filter:drop-shadow(0 10px 40px rgba(139,108,255,.45))}}
.logo svg{{width:170px;height:170px}}
h1{{margin:0;font-size:92px;font-weight:800;letter-spacing:-3px;line-height:1}}
h1 span{{background:linear-gradient(90deg,#8b6cff,#22d3ee);-webkit-background-clip:text;color:transparent}}
p{{margin:16px 0 0;font-size:27px;color:#aab2c5;line-height:1.35;max-width:820px}}
.t{{position:relative}}
.chips{{margin-top:22px;display:flex;gap:10px}}
.chips i{{font-style:normal;font-size:16px;padding:6px 14px;border-radius:999px;border:1px solid rgba(139,108,255,.4);color:#cfc5ff;background:rgba(139,108,255,.1)}}
</style></head><body><div class="b"><div class="hex" id="h"></div>
<div class="logo">{logo}</div><div class="t"><h1>VB<span>Lens</span></h1>
<p>Free, open-source disassembler and decompiler for Visual Basic 5/6 executables.</p>
<div class="chips"><i>Native code</i><i>P-Code</i><i>Form designer</i><i>AI agents (MCP)</i></div></div></div>
<script>let s='';for(let i=0;i<24;i++){{for(let j=0;j<70;j++)s+=(Math.random()*256|0).toString(16).toUpperCase().padStart(2,'0')+' ';s+='\\n'}}document.getElementById('h').textContent=s</script>
</body></html>'''
with sync_playwright() as p:
    b=p.chromium.launch(args=['--no-sandbox']); pg=b.new_page(viewport={'width':1280,'height':360},device_scale_factor=2)
    pg.set_content(html); pg.wait_for_timeout(500)
    pg.locator('.b').screenshot(path=str(R/'docs/banner.png'),omit_background=True); b.close()
