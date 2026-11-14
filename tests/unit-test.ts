// Checks of the decompiler's output passes that need no sample binary (run in CI):
//   npx tsx tests/unit-test.ts
import assert from 'node:assert/strict';
import { selectCases, type Line } from '../src/core/decompiler/native';
import { negate, printE, type E } from '../src/core/decompiler/ir';
import { declareLocals, exprType, apiStruct } from '../src/core/decompiler/types';
import { VB_CLASSES_BY_EVENT_GUID, VB_CLASSES_BY_NAME, INTERFACES_BY_GUID, lookupMember, BUNDLED_TYPELIBS } from '../src/core/data/vbclasses';

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log('ok ', name); };
const L = (indent: number, text: string): Line => ({ indent, text });
const text = (ls: Line[]) => ls.map(l => '  '.repeat(l.indent) + l.text).join('\n');

ok('ElseIf chain on one variable becomes Select Case', () => {
  const out = selectCases([
    L(1, 'If x = 1 Then'), L(2, 'a'), L(1, 'ElseIf x = 2 Or x = 3 Then'), L(2, 'b'), L(1, 'ElseIf x = "q" Then'), L(2, 'c'), L(1, 'Else'), L(2, 'd'), L(1, 'End If'),
  ]);
  assert.equal(text(out), [
    '  Select Case x', '    Case 1', '      a', '    Case 2, 3', '      b', '    Case "q"', '      c', '    Case Else', '      d', '  End Select',
  ].join('\n'));
});

ok('mixed conditions stay If / ElseIf', () => {
  const src = [L(1, 'If x = 1 Then'), L(2, 'a'), L(1, 'ElseIf y = 2 Then'), L(2, 'b'), L(1, 'ElseIf x = 3 Then'), L(2, 'c'), L(1, 'End If')];
  assert.equal(text(selectCases(src.map(l => ({ ...l })))), text(src));
});

ok('two arms are not worth a Select Case', () => {
  const src = [L(1, 'If x = 1 Then'), L(2, 'a'), L(1, 'ElseIf x = 2 Then'), L(2, 'b'), L(1, 'End If')];
  assert.equal(text(selectCases(src.map(l => ({ ...l })))), text(src));
});

ok('" Or " inside a string literal is not a split point', () => {
  const out = selectCases([L(1, 'If s = "a Or b" Then'), L(2, 'a'), L(1, 'ElseIf s = "c" Then'), L(2, 'b'), L(1, 'ElseIf s = "d" Then'), L(2, 'c'), L(1, 'End If')]);
  assert.equal(out[1].text, 'Case "a Or b"');
});

const v = (n: string): E => ({ k: 'v', n });
const c = (x: number): E => ({ k: 'c', v: x });
const cmp = (op: string, l: E, r: E): E => ({ k: 'b', op, l, r });

ok('negating a compound condition uses De Morgan', () => {
  const e: E = { k: 'b', op: 'Or', l: cmp('<>', v('a'), c(1)), r: cmp('<>', v('b'), c(2)) };
  assert.equal(printE(negate(e)), 'a = 1 And b = 2');
});

ok('negating a non-comparison keeps Not', () => {
  const e: E = { k: 'b', op: 'Or', l: v('a'), r: cmp('=', v('b'), c(2)) };
  assert.match(printE(negate(e)), /^Not /);
});

ok('expression types', () => {
  const t = (e: E) => exprType(e, () => undefined);
  assert.equal(t({ k: 's', v: 'x' }), 'String');
  assert.equal(t({ k: 'call', f: 'Left$', args: [] }), 'String');
  assert.equal(t({ k: 'call', f: 'CLng', args: [] }), 'Long');
  assert.equal(t({ k: 'b', op: '-', l: { k: 'call', f: 'Len', args: [] }, r: c(1) }), 'Long');
  assert.equal(t(cmp('=', v('a'), c(1))), 'Boolean');
  assert.equal(t({ k: 'b', op: '&', l: v('a'), r: v('b') }), 'String');
});

ok('Dim lines and loop counter names', () => {
  const out = declareLocals([L(1, 'For var_14 = 0 To var_1C'), L(2, 'var_20 = var_20 & "x"'), L(1, 'Next var_14')],
    new Map([['var_20', { type: 'String', array: false }], ['var_1C', { type: 'Long', array: false }]]), /^var_[0-9A-F]+$/);
  assert.deepEqual(out.map(l => l.text), ['Dim i As Long', 'Dim var_1C As Long', 'Dim var_20 As String', '', 'For i = 0 To var_1C', 'var_20 = var_20 & "x"', 'Next i']);
});

ok('loop counter rename keeps string literals and taken names', () => {
  const out = declareLocals([L(1, 'For var_14 = 0 To 3'), L(2, 'i = "var_14"'), L(1, 'Next var_14')], new Map(), /^var_[0-9A-F]+$/);
  assert.deepEqual(out.map(l => l.text).slice(-3), ['For j = 0 To 3', 'i = "var_14"', 'Next j']);
});

ok('Win32 structure arguments', () => {
  assert.equal(apiStruct('CreateProcessA', 8), 'STARTUPINFO');
  assert.equal(apiStruct('CreateProcessW', 9), 'PROCESS_INFORMATION');
  assert.equal(apiStruct('GetThreadContext', 1), 'CONTEXT');
  assert.equal(apiStruct('MessageBoxA', 0), undefined);
});

ok('common ActiveX controls are built in', () => {
  assert.ok(BUNDLED_TYPELIBS.length >= 20);
  const ws = VB_CLASSES_BY_EVENT_GUID['{248DD893-BB45-11CF-9ABC-0080C7E7B78D}'];
  assert.equal(ws?.name, 'Winsock');
  assert.ok(ws.events.includes('DataArrival'));
  assert.equal(VB_CLASSES_BY_NAME.CommonDialog?.dispids['1']?.name, 'FileName');
  // the VB5 common controls keep their own layout next to the VB6 ones
  assert.ok(VB_CLASSES_BY_NAME.TreeView && VB_CLASSES_BY_NAME['ComctlLib.TreeView']);
  assert.notEqual(VB_CLASSES_BY_NAME.TreeView.eventsGuid, VB_CLASSES_BY_NAME['ComctlLib.TreeView'].eventsGuid);
  const iws = INTERFACES_BY_GUID['{248DD892-BB45-11CF-9ABC-0080C7E7B78D}'];
  assert.ok(iws);
  const names = [...iws.byOffset.values()].flat().map(m => m.name);
  assert.ok(names.includes('SendData') && names.includes('Connect'));
  assert.ok(lookupMember(iws, [...iws.byOffset.keys()].sort((a, b) => b - a)[0]));
});

console.log(`\n${n} checks passed`);
