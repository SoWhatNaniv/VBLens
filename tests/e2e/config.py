# Shared settings for the browser tests. Override with environment variables:
#   VBLENS_DIST    path to the built page (default: ../../dist/index.html from `npm run build`)
#   VB_SAMPLE    a native-code VB6 executable to test with (required)
#   VB_PCODE     a P-Code VB binary (optional; P-Code tests are skipped without it)
#   VB_BAD       any non-VB PE file such as an .ocx from System32 (optional)
#   VB_TLB       an ActiveX type library such as MSCOMCTL.OCX (optional)
#   CHROME       Chrome/Chromium executable (default: Playwright's bundled Chromium)
import os, pathlib
HERE = pathlib.Path(__file__).resolve().parent
DIST = 'file://' + str(pathlib.Path(os.environ.get('VBLENS_DIST', HERE.parent.parent / 'dist' / 'index.html')).resolve())
EXE = os.environ.get('VB_SAMPLE', str(HERE.parent.parent / 'samples' / 'EshkolPlus.exe'))
PCODE = os.environ.get('VB_PCODE', '')
BAD = os.environ.get('VB_BAD', '')
TLB = os.environ.get('VB_TLB', '')
SHOTS = str(HERE / 'shots') + '/'
os.makedirs(SHOTS, exist_ok=True)
def launch(p):
    exe = os.environ.get('CHROME')
    return p.chromium.launch(executable_path=exe, args=['--no-sandbox']) if exe else p.chromium.launch(args=['--no-sandbox'])
