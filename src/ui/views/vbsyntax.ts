// Tiny VB6 tokenizer for syntax highlighting and symbol navigation.

export type VTok = { t: string; c: 'kw' | 'str' | 'num' | 'cm' | 'fn' | 'ty' | 'op' | 'id' | 'ws' | 'lbl'; nav?: number };

const KW = new Set(('If Then Else ElseIf End Sub Function Property Get Let Set Dim Private Public Static Const As New Nothing Not And Or Xor Eqv Imp Mod Is Like ' +
  'Do Loop While Until Wend For To Step Next Each In Exit GoTo GoSub Return On Error Resume Call ReDim Preserve Select Case With ByVal ByRef Optional ' +
  'ParamArray True False Empty Null Me Declare Lib Alias Option Explicit Attribute Begin BeginProperty EndProperty Open Close Input Output Append Binary Random ' +
  'Print Write Line Get Put Erase Stop RaiseEvent Event Implements Friend Global Type Enum Variant String Long Integer Byte Boolean Double Single Currency Date Object VERSION').split(' '));
const TYPES = new Set('String Long Integer Byte Boolean Double Single Currency Date Object Variant Any'.split(' '));
const BUILTIN = new Set(('MsgBox InputBox Len Left Right Mid Trim LTrim RTrim UCase LCase CStr CLng CInt CDbl CSng CBool CByte CDate CCur CVar Chr Asc Val Str Format Replace Split Join ' +
  'InStr InStrRev StrComp StrConv StrReverse Space String Now Date Time Timer DoEvents Shell Dir Kill FileCopy MkDir RmDir ChDir FreeFile EOF LOF Loc Seek ' +
  'IsNumeric IsDate IsEmpty IsNull IsArray IsObject IsMissing UBound LBound Array CreateObject GetObject Err Erl App Screen Printer Clipboard Forms RGB QBColor ' +
  'Abs Int Fix Sgn Sqr Log Exp Sin Cos Tan Atn Rnd Randomize Hex Oct TypeName VarType DateAdd DateDiff DatePart Year Month Day Hour Minute Second Weekday ' +
  'DateSerial TimeSerial DateValue TimeValue IIf Choose Environ Command GetSetting SaveSetting DeleteSetting SendKeys AppActivate Beep LoadPicture LoadResString CallByName').split(' '));

export function tokenizeVB(line: string, resolve?: (name: string) => number | undefined): VTok[] {
  const out: VTok[] = [];
  let i = 0;
  const n = line.length;
  if (/^\s*(Label_[0-9A-F]+|ErrorHandler|loc_[0-9A-F]+):\s*$/.test(line)) return [{ t: line, c: 'lbl' }];
  while (i < n) {
    const ch = line[i];
    if (ch === "'") { out.push({ t: line.slice(i), c: 'cm' }); break; }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) { if (line[j] === '"') { if (line[j + 1] === '"') { j += 2; continue; } j++; break; } j++; }
      out.push({ t: line.slice(i, j), c: 'str' });
      i = j;
      continue;
    }
    if (ch === ' ' || ch === '\t') { let j = i; while (j < n && (line[j] === ' ' || line[j] === '\t')) j++; out.push({ t: line.slice(i, j), c: 'ws' }); i = j; continue; }
    if (ch === '&' && /[Hh]/.test(line[i + 1] ?? '')) {
      let j = i + 2; while (j < n && /[0-9A-Fa-f]/.test(line[j])) j++; if (line[j] === '&') j++;
      out.push({ t: line.slice(i, j), c: 'num' }); i = j; continue;
    }
    if (/[0-9]/.test(ch)) { let j = i; while (j < n && /[0-9.#!@&eE]/.test(line[j])) j++; out.push({ t: line.slice(i, j), c: 'num' }); i = j; continue; }
    if (/[A-Za-z_\u0080-￿]/.test(ch)) {
      let j = i;
      while (j < n && /[\w\u0080-￿$]/.test(line[j])) j++;
      // dotted path
      let k = j;
      while (line[k] === '.' && /[A-Za-z_]/.test(line[k + 1] ?? '')) { k++; while (k < n && /[\w$]/.test(line[k])) k++; }
      const full = line.slice(i, k);
      const parts = full.split('.');
      // try the longest resolvable prefix/suffix
      const navFull = resolve?.(full);
      if (navFull !== undefined) { out.push({ t: full, c: 'fn', nav: navFull }); i = k; continue; }
      let pos = i;
      parts.forEach((p, idx) => {
        if (idx) { out.push({ t: '.', c: 'op' }); pos++; }
        const two = idx + 1 < parts.length ? `${p}.${parts[idx + 1]}` : '';
        const nav = resolve?.(p) ?? (two ? undefined : undefined);
        let c: VTok['c'] = 'id';
        if (idx === 0 && KW.has(p)) c = TYPES.has(p) ? 'ty' : 'kw';
        else if (nav !== undefined) c = 'fn';
        else if (idx === 0 && BUILTIN.has(p.replace(/\$$/, ''))) c = 'fn';
        out.push({ t: p, c, nav });
        pos += p.length;
      });
      i = k;
      continue;
    }
    out.push({ t: ch, c: 'op' });
    i++;
  }
  return out;
}
