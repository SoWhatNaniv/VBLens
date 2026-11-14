// Knowledge about MSVBVM60 runtime functions: calling convention, arity and
// how a call translates back into Visual Basic.

import { C, CALL, E, RAW, Stmt, V, unref } from './ir';

export interface RtCtx {
  va: number;
  pop(n: number): E[];
  pending(): number;
  reg(r: string): E;
  setReg(r: string, v: E | undefined): void;
  fpuPush(e: E): void;
  fpuPop(): E;
  emit(s: Stmt): void;
  /** vt: the VB type the runtime helper stores (evidence for local variable types) */
  store(addr: E, v: E, opts?: { set?: boolean; vt?: string }): E;
  lv(addr: E): E;
  variant(addr: E): E;
  deref(addr: E): E;
  result(e: E): void;
  onError(): void;
  className(p: E): string;
  cstr(va: number): string | undefined;
  cdecl?: number; // argument count from the caller's "add esp, n" (cdecl functions)
  byRef(a: E): E;
  /** Member name of a dispatch id on an object whose class is known (controls). */
  dispName(obj: E, id: number): string | undefined;
  setSlotValue(addr: E, v: E): void;
  alloc(bytes: number): void;
  /** Look at stack arguments without consuming them. */
  peek(n: number): E[];
  /** A frame slot released by the runtime (__vbaFreeObj...): it holds a compiler temporary. */
  freed(addr: E): void;
}

// kind: d = first arg is the destination Variant, r = returns in eax, f = returns in st(0),
//       s = statement, b = boolean in eax.  n = stack dwords.  vb = VB name.  dbl = indices of 8-byte args
interface Rt { n: number; kind: 'd' | 'r' | 'f' | 's' | 'b'; vb: string; dbl?: number[] }

const RT: Record<string, Rt> = {
  rtcMsgBox: { n: 5, kind: 'r', vb: 'MsgBox' },
  rtcInputBox: { n: 7, kind: 'd', vb: 'InputBox' },
  rtcTrimVar: { n: 2, kind: 'd', vb: 'Trim' }, rtcTrimBstr: { n: 1, kind: 'r', vb: 'Trim$' },
  rtcLeftTrimVar: { n: 2, kind: 'd', vb: 'LTrim' }, rtcLeftTrimBstr: { n: 1, kind: 'r', vb: 'LTrim$' },
  rtcRightTrimVar: { n: 2, kind: 'd', vb: 'RTrim' }, rtcRightTrimBstr: { n: 1, kind: 'r', vb: 'RTrim$' },
  rtcMidCharVar: { n: 4, kind: 'd', vb: 'Mid' }, rtcMidCharBstr: { n: 3, kind: 'r', vb: 'Mid$' },
  rtcLeftCharVar: { n: 3, kind: 'd', vb: 'Left' }, rtcLeftCharBstr: { n: 2, kind: 'r', vb: 'Left$' },
  rtcRightCharVar: { n: 3, kind: 'd', vb: 'Right' }, rtcRightCharBstr: { n: 2, kind: 'r', vb: 'Right$' },
  rtcUpperCaseVar: { n: 2, kind: 'd', vb: 'UCase' }, rtcUpperCaseBstr: { n: 1, kind: 'r', vb: 'UCase$' },
  rtcLowerCaseVar: { n: 2, kind: 'd', vb: 'LCase' }, rtcLowerCaseBstr: { n: 1, kind: 'r', vb: 'LCase$' },
  rtcSpaceVar: { n: 2, kind: 'd', vb: 'Space' }, rtcSpaceBstr: { n: 1, kind: 'r', vb: 'Space$' },
  rtcStringVar: { n: 3, kind: 'd', vb: 'String' }, rtcStringBstr: { n: 2, kind: 'r', vb: 'String$' },
  rtcReplace: { n: 6, kind: 'r', vb: 'Replace' }, rtcSplit: { n: 5, kind: 'd', vb: 'Split' }, rtcJoin: { n: 2, kind: 'r', vb: 'Join' },
  rtcStrReverse: { n: 1, kind: 'r', vb: 'StrReverse' }, rtcFilter: { n: 5, kind: 'd', vb: 'Filter' },
  rtcInStrRev: { n: 4, kind: 'r', vb: 'InStrRev' }, rtcInStrChar: { n: 4, kind: 'r', vb: 'InStr' },
  rtcStrConvVar2: { n: 4, kind: 'd', vb: 'StrConv' }, rtcFormatNumber: { n: 6, kind: 'd', vb: 'FormatNumber' },
  rtcFormatCurrency: { n: 6, kind: 'd', vb: 'FormatCurrency' }, rtcFormatDateTime: { n: 3, kind: 'd', vb: 'FormatDateTime' },
  rtcFormatPercent: { n: 6, kind: 'd', vb: 'FormatPercent' }, rtcVarFromFormatVar: { n: 5, kind: 'd', vb: 'Format' },
  rtcBstrFromFormatVar: { n: 4, kind: 'r', vb: 'Format$' }, rtcMonthName: { n: 2, kind: 'r', vb: 'MonthName' }, rtcWeekdayName: { n: 3, kind: 'r', vb: 'WeekdayName' },
  rtcDir: { n: 2, kind: 'r', vb: 'Dir' }, rtcCurrentDir: { n: 2, kind: 'd', vb: 'CurDir' }, rtcCurrentDirBstr: { n: 1, kind: 'r', vb: 'CurDir$' },
  rtcIsNumeric: { n: 1, kind: 'b', vb: 'IsNumeric' }, rtcIsDate: { n: 1, kind: 'b', vb: 'IsDate' }, rtcIsArray: { n: 1, kind: 'b', vb: 'IsArray' },
  rtcIsEmpty: { n: 1, kind: 'b', vb: 'IsEmpty' }, rtcIsNull: { n: 1, kind: 'b', vb: 'IsNull' }, rtcIsObject: { n: 1, kind: 'b', vb: 'IsObject' },
  rtcIsMissing: { n: 1, kind: 'b', vb: 'IsMissing' }, rtcIsError: { n: 1, kind: 'b', vb: 'IsError' },
  rtcR8ValFromBstr: { n: 1, kind: 'f', vb: 'Val' }, rtcAnsiValueBstr: { n: 1, kind: 'r', vb: 'Asc' }, rtcAnsiValueVar: { n: 1, kind: 'r', vb: 'Asc' },
  rtcCharValueBstr: { n: 1, kind: 'r', vb: 'AscW' }, rtcBstrFromAnsi: { n: 1, kind: 'r', vb: 'Chr$' }, rtcVarBstrFromAnsi: { n: 2, kind: 'd', vb: 'Chr' },
  rtcBstrFromChar: { n: 1, kind: 'r', vb: 'ChrW$' }, rtcVarBstrFromChar: { n: 2, kind: 'd', vb: 'ChrW' }, rtcBstrFromByte: { n: 1, kind: 'r', vb: 'ChrB$' },
  rtcRgb: { n: 3, kind: 'r', vb: 'RGB' }, rtcQBColor: { n: 1, kind: 'r', vb: 'QBColor' },
  rtcShell: { n: 2, kind: 'f', vb: 'Shell' }, rtcDoEvents: { n: 0, kind: 'r', vb: 'DoEvents' }, rtcBeep: { n: 0, kind: 's', vb: 'Beep' },
  rtcGetPresentDate: { n: 1, kind: 'd', vb: 'Now' }, rtcGetDateVar: { n: 1, kind: 'd', vb: 'Date' }, rtcGetTimeVar: { n: 1, kind: 'd', vb: 'Time' },
  rtcGetDateBstr: { n: 0, kind: 'r', vb: 'Date$' }, rtcGetTimeBstr: { n: 0, kind: 'r', vb: 'Time$' }, rtcGetTimer: { n: 0, kind: 'f', vb: 'Timer' },
  rtcFreeFile: { n: 1, kind: 'r', vb: 'FreeFile' }, rtcKillFiles: { n: 1, kind: 's', vb: 'Kill' }, rtcFileCopy: { n: 2, kind: 's', vb: 'FileCopy' },
  rtcMakeDir: { n: 1, kind: 's', vb: 'MkDir' }, rtcRemoveDir: { n: 1, kind: 's', vb: 'RmDir' }, rtcChangeDir: { n: 1, kind: 's', vb: 'ChDir' },
  rtcChangeDrive: { n: 1, kind: 's', vb: 'ChDrive' }, rtcFileLen: { n: 1, kind: 'r', vb: 'FileLen' }, rtcFileDateTime: { n: 2, kind: 'd', vb: 'FileDateTime' },
  rtcGetFileAttr: { n: 1, kind: 'r', vb: 'GetAttr' }, rtcSetFileAttr: { n: 2, kind: 's', vb: 'SetAttr' }, rtcEndOfFile: { n: 1, kind: 'b', vb: 'EOF' },
  rtcFileLength: { n: 1, kind: 'r', vb: 'LOF' }, rtcFileLocation: { n: 1, kind: 'r', vb: 'Loc' }, rtcFileSeek: { n: 1, kind: 'r', vb: 'Seek' },
  rtcCreateObject2: { n: 3, kind: 'd', vb: 'CreateObject' }, rtcCreateObject: { n: 2, kind: 'd', vb: 'CreateObject' }, rtcGetObject: { n: 3, kind: 'd', vb: 'GetObject' },
  rtcCommandVar: { n: 1, kind: 'd', vb: 'Command' }, rtcCommandBstr: { n: 0, kind: 'r', vb: 'Command$' },
  rtcEnvironVar: { n: 2, kind: 'd', vb: 'Environ' }, rtcEnvironBstr: { n: 1, kind: 'r', vb: 'Environ$' },
  rtcGetSetting: { n: 4, kind: 'r', vb: 'GetSetting' }, rtcSaveSetting: { n: 4, kind: 's', vb: 'SaveSetting' }, rtcDeleteSetting: { n: 3, kind: 's', vb: 'DeleteSetting' },
  rtcGetAllSettings: { n: 3, kind: 'd', vb: 'GetAllSettings' },
  rtcSendKeys: { n: 2, kind: 's', vb: 'SendKeys' }, rtcAppActivate: { n: 2, kind: 's', vb: 'AppActivate' },
  rtcRandomize: { n: 1, kind: 's', vb: 'Randomize' }, rtcRandomNext: { n: 1, kind: 'f', vb: 'Rnd' },
  rtcHexVarFromVar: { n: 2, kind: 'd', vb: 'Hex' }, rtcHexBstrFromVar: { n: 1, kind: 'r', vb: 'Hex$' },
  rtcOctVarFromVar: { n: 2, kind: 'd', vb: 'Oct' }, rtcOctBstrFromVar: { n: 1, kind: 'r', vb: 'Oct$' },
  rtcTypeName: { n: 1, kind: 'r', vb: 'TypeName' }, rtcVarType: { n: 1, kind: 'r', vb: 'VarType' },
  rtcDateAdd: { n: 5, kind: 'd', vb: 'DateAdd', dbl: [2] }, rtcDateDiff: { n: 6, kind: 'd', vb: 'DateDiff' }, rtcDatePart: { n: 5, kind: 'd', vb: 'DatePart' },
  rtcGetMonthOfYear: { n: 1, kind: 'r', vb: 'Month' }, rtcGetDayOfMonth: { n: 1, kind: 'r', vb: 'Day' }, rtcGetYear: { n: 1, kind: 'r', vb: 'Year' },
  rtcGetHourOfDay: { n: 1, kind: 'r', vb: 'Hour' }, rtcGetMinuteOfHour: { n: 1, kind: 'r', vb: 'Minute' }, rtcGetSecondOfMinute: { n: 1, kind: 'r', vb: 'Second' },
  rtcGetDayOfWeek: { n: 2, kind: 'r', vb: 'Weekday' }, rtcPackDate: { n: 4, kind: 'd', vb: 'DateSerial' }, rtcPackTime: { n: 4, kind: 'd', vb: 'TimeSerial' },
  rtcGetDateValue: { n: 2, kind: 'd', vb: 'DateValue' }, rtcGetTimeValue: { n: 2, kind: 'd', vb: 'TimeValue' },
  rtcAbsVar: { n: 2, kind: 'd', vb: 'Abs' }, rtcFixVar: { n: 2, kind: 'd', vb: 'Fix' }, rtcIntVar: { n: 2, kind: 'd', vb: 'Int' }, rtcSgnVar: { n: 1, kind: 'r', vb: 'Sgn' },
  rtcSqr: { n: 2, kind: 'f', vb: 'Sqr', dbl: [0] }, rtcLog: { n: 2, kind: 'f', vb: 'Log', dbl: [0] }, rtcExp: { n: 2, kind: 'f', vb: 'Exp', dbl: [0] },
  rtcSin: { n: 2, kind: 'f', vb: 'Sin', dbl: [0] }, rtcCos: { n: 2, kind: 'f', vb: 'Cos', dbl: [0] }, rtcTan: { n: 2, kind: 'f', vb: 'Tan', dbl: [0] }, rtcAtn: { n: 2, kind: 'f', vb: 'Atn', dbl: [0] },
  rtcRound: { n: 3, kind: 'd', vb: 'Round' }, rtcCallByName: { n: 5, kind: 'd', vb: 'CallByName' }, rtcImmediateIf: { n: 4, kind: 'd', vb: 'IIf' },
  rtcChoose: { n: 3, kind: 'd', vb: 'Choose' }, rtcPartition: { n: 5, kind: 'd', vb: 'Partition' },
  rtcCVErrFromVar: { n: 2, kind: 'd', vb: 'CVErr' }, rtcErrObj: { n: 0, kind: 'r', vb: 'Err' }, rtcGetErl: { n: 0, kind: 'r', vb: 'Erl' },
  rtcLenCharVar: { n: 2, kind: 'd', vb: 'Len' }, rtcLenVar: { n: 2, kind: 'd', vb: 'Len' }, rtcStrFromVar: { n: 1, kind: 'r', vb: 'Str$' },
  rtcVarStrFromVar: { n: 2, kind: 'd', vb: 'Str' }, rtcLoadResString: { n: 1, kind: 'r', vb: 'LoadResString' }, rtcLoadResData: { n: 3, kind: 'd', vb: 'LoadResData' },
  rtcLoadResPicture: { n: 2, kind: 'r', vb: 'LoadResPicture' }, rtcSetDateVar: { n: 1, kind: 's', vb: 'Date =' }, rtcSetTimeVar: { n: 1, kind: 's', vb: 'Time =' },
  rtcCompareBstr: { n: 3, kind: 'r', vb: 'StrComp' }, rtcSpcVar: { n: 2, kind: 'd', vb: 'Spc' }, rtcTabVar: { n: 2, kind: 'd', vb: 'Tab' },
};

const VAR_BIN: Record<string, string> = {
  __vbaVarAdd: '+', __vbaVarSub: '-', __vbaVarMul: '*', __vbaVarDiv: '/', __vbaVarIdiv: '\\', __vbaVarMod: 'Mod', __vbaVarPow: '^',
  __vbaVarAnd: 'And', __vbaVarOr: 'Or', __vbaVarXor: 'Xor', __vbaVarEqv: 'Eqv', __vbaVarImp: 'Imp', __vbaVarCat: '&',
  __vbaVarCmpEq: '=', __vbaVarCmpNe: '<>', __vbaVarCmpLt: '<', __vbaVarCmpLe: '<=', __vbaVarCmpGt: '>', __vbaVarCmpGe: '>=', __vbaVarLike: 'Like',
};
const VAR_TST: Record<string, string> = {
  __vbaVarTstEq: '=', __vbaVarTstNe: '<>', __vbaVarTstLt: '<', __vbaVarTstLe: '<=', __vbaVarTstGt: '>', __vbaVarTstGe: '>=',
};
const CONV1: Record<string, [string, 'r' | 'f' | 'b']> = {
  __vbaI4Var: ['CLng', 'r'], __vbaI2Var: ['CInt', 'r'], __vbaUI1Var: ['CByte', 'r'], __vbaR8Var: ['CDbl', 'f'], __vbaR4Var: ['CSng', 'f'],
  __vbaCyVar: ['CCur', 'f'], __vbaDateVar: ['CDate', 'f'], __vbaBoolVar: ['CBool', 'b'], __vbaBoolVarNull: ['CBool', 'b'],
  __vbaStrVarMove: ['CStr', 'r'], __vbaStrVarCopy: ['CStr', 'r'], __vbaStrErrVarCopy: ['CStr', 'r'],
  __vbaI4Str: ['CLng', 'r'], __vbaI2Str: ['CInt', 'r'], __vbaUI1Str: ['CByte', 'r'], __vbaR8Str: ['CDbl', 'f'], __vbaR4Str: ['CSng', 'f'],
  __vbaBoolStr: ['CBool', 'b'], __vbaDateStr: ['CDate', 'f'], __vbaCyStr: ['CCur', 'f'],
  __vbaStrI4: ['CStr', 'r'], __vbaStrI2: ['CStr', 'r'], __vbaStrUI1: ['CStr', 'r'], __vbaStrBool: ['CStr', 'r'],
  __vbaI4ErrVar: ['CLng', 'r'], __vbaI2ErrVar: ['CInt', 'r'], __vbaObjVar: ['', 'r'], __vbaI4Abs: ['Abs', 'r'], __vbaI2Abs: ['Abs', 'r'],
  __vbaLenBstr: ['Len', 'r'], __vbaLenBstrB: ['LenB', 'r'], __vbaUnkVar: ['', 'r'],
};

const call = (f: string, args: E[], extra: Partial<Extract<E, { k: 'call' }>> = {}): E => ({ k: 'call', f, args, ...extra });

export function runtimeCall(name: string, ctx: RtCtx): void {
  const r = (x: string) => ctx.reg(x);
  const val = (a: E) => ctx.byRef(a);
  switch (name) {
    // --- strings ---
    case '__vbaStrCopy': case '__vbaStrMove': {
      const dst = r('ecx'), src = r('edx');
      ctx.setReg('eax', ctx.store(dst, src, { vt: 'String' }));
      return;
    }
    case '__vbaStrCat': {
      const [a1, a2] = ctx.pop(2);
      ctx.setReg('eax', { k: 'b', op: '&', l: a2, r: a1 });
      return;
    }
    case '__vbaStrCmp': case '__vbaStrTextCmp': {
      const [a1, a2] = ctx.pop(2);
      ctx.result(call('StrCmp', [a2, a1], { cmp0: '=' }));
      return;
    }
    case '__vbaStrComp': {
      const [mode, a1, a2] = ctx.pop(3);
      ctx.result(call('StrComp', [a2, a1, mode]));
      return;
    }
    case '__vbaStrToAnsi': case '__vbaStrToUnicode': {
      const [dst, src] = ctx.pop(2);
      ctx.setSlotValue(dst, src);
      ctx.setReg('eax', src);
      return;
    }
    case '__vbaStrR8': case '__vbaStrDate': case '__vbaStrCy': {
      const [lo] = ctx.pop(2);
      ctx.setReg('eax', call('CStr', [lo]));
      return;
    }
    case '__vbaStrR4': {
      const [v] = ctx.pop(1);
      ctx.setReg('eax', call('CStr', [v]));
      return;
    }
    case '__vbaInStr': {
      // __vbaInStr(compare, search, string, start)
      const [cmp, search, str, start] = ctx.pop(4).map(val);
      const us = unref(start), uc = unref(cmp);
      const args = us.k === 'c' && us.v === 1 && uc.k === 'c' && uc.v === 0 ? [str, search] : [start, str, search];
      if (!(uc.k === 'c' && uc.v === 0)) args.push(uc.k === 'c' && uc.v === 1 ? { k: 'v', n: 'vbTextCompare' } : cmp);
      ctx.result(call('InStr', args));
      return;
    }
    case '__vbaInStrVar': {
      // __vbaInStrVar(ret, compare, search*, string*, ?, start*)
      const [dst, cmp, search, str, , start] = ctx.pop(6);
      const sv = ctx.variant(start), uc = unref(cmp);
      const us = unref(sv);
      const args = us.k === 'c' && us.v === 1 ? [ctx.variant(str), ctx.variant(search)] : [sv, ctx.variant(str), ctx.variant(search)];
      if (!(uc.k === 'c' && uc.v === 0)) args.push(uc.k === 'c' && uc.v === 1 ? { k: 'v', n: 'vbTextCompare' } : cmp);
      ctx.store(dst, call('InStr', args));
      ctx.setReg('eax', dst);
      return;
    }
    case '__vbaMidStmtBstr': case '__vbaMidStmtVar': {
      const n = ctx.pending();
      const args = ctx.pop(Math.min(n, 4)).map(val);
      ctx.emit({ k: 'text', va: ctx.va, t: `Mid$(${args.slice(1).map(a => print(a)).join(', ')}) = ${print(args[0])}` });
      return;
    }
    case '__vbaLsetFixstr': case '__vbaLsetFixstrFree': case '__vbaLsetFixstrB': {
      const [, dst, src] = ctx.pop(3);
      ctx.store(dst, val(src));
      return;
    }
    case '__vbaFixstrConstruct': ctx.pop(2); return;
    case '__vbaStrFixstr': {
      // __vbaStrFixstr(cch, pFixed) -> BSTR copy of a fixed-length string
      const [, p] = ctx.pop(2);
      ctx.result(val(p));
      return;
    }
    case '__vbaChkstk': { const n = unref(r('eax')); if (n.k === 'c') ctx.alloc(n.v); return; }
    case '__vbaFreeStr': case '__vbaFreeObj': case '__vbaFreeVar': ctx.freed(ctx.reg('ecx')); return;
    case '__vbaAryUnlock': return;
    case '__vbaFreeStrList': case '__vbaFreeObjList': case '__vbaFreeVarList': {
      // cdecl: caller pops.  (count, &a, &b, ...)
      const [cnt] = ctx.peek(1);
      const n = unref(cnt);
      if (n.k === 'c' && n.v > 0 && n.v < 64) for (const a of ctx.peek(n.v + 1).slice(1)) ctx.freed(a);
      return;
    }
    case '__vbaVarZero': return;

    // --- variants ---
    case '__vbaVarMove': case '__vbaVarCopy': case '__vbaVarDup': case '__vbaVargVarMove': case '__vbaVargVarCopy': case '__vbaVarVargNofree': case '__vbaVargVar': {
      const dst = r('ecx'), src = r('edx');
      if (name === '__vbaVarDup' || name === '__vbaVarMove' || name === '__vbaVarCopy') {
        const v = ctx.variant(src);
        ctx.store(dst, v, { vt: 'Variant' });
        ctx.setReg('eax', dst);
      } else ctx.setReg('eax', src);
      return;
    }
    case '__vbaVarSetObj': case '__vbaVarSetObjAddref': case '__vbaVarSetVar': case '__vbaVarSetUnk': {
      const dst = r('ecx'), src = r('edx');
      ctx.store(dst, val(src), { set: true, vt: 'Variant' });
      return;
    }
    case '__vbaVarNot': case '__vbaVarNeg': case '__vbaVarAbs': case '__vbaVarInt': case '__vbaVarFix': {
      const [dst, a] = ctx.pop(2);
      const e: E = name === '__vbaVarNot' ? { k: 'u', op: 'Not', e: ctx.variant(a) } : name === '__vbaVarNeg' ? { k: 'u', op: '-', e: ctx.variant(a) } : call(name.replace('__vbaVar', ''), [ctx.variant(a)]);
      ctx.store(dst, e);
      ctx.setReg('eax', dst);
      return;
    }
    case '__vbaVarForInit': {
      const args = ctx.pop(6);
      const [counter, , , start, end, step] = args;
      ctx.emit({ k: 'text', va: ctx.va, t: `For ${print(ctx.lv(counter))} = ${print(ctx.variant(start))} To ${print(ctx.variant(end))}${printStep(ctx.variant(step))}` });
      ctx.result(call('ForInit', [], { bool: true }));
      return;
    }
    case '__vbaVarForNext': {
      const [counter] = ctx.pop(3);
      ctx.emit({ k: 'text', va: ctx.va, t: `Next ${print(ctx.lv(counter))}` });
      ctx.result(call('ForNext', [], { bool: true }));
      return;
    }
    case '__vbaVarIndexLoad': case '__vbaVarIndexLoadRef': case '__vbaVarIndexLoadRefLock': {
      const args = ctx.pop((ctx.cdecl ?? Math.max(ctx.pending(), 3))); // cdecl: dst, obj, nidx, idx...
      const [dst, base, , ...idx] = args;
      ctx.store(dst, call(print(ctx.variant(base)), idx.map(x => ctx.variant(x))));
      ctx.setReg('eax', dst);
      return;
    }
    case '__vbaVarIndexStore': {
      const args = ctx.pop((ctx.cdecl ?? Math.max(ctx.pending(), 3)));
      const [base, value, , ...idx] = args;
      ctx.emit({ k: 'text', va: ctx.va, t: `${print(ctx.variant(base))}(${idx.map(x => print(ctx.variant(x))).join(', ')}) = ${print(ctx.variant(value))}` });
      return;
    }

    // --- objects ---
    case '__vbaObjSet': case '__vbaObjSetAddref': {
      const [dst, src] = ctx.pop(2);
      ctx.setReg('eax', ctx.store(dst, src, { set: true }));
      return;
    }
    case '__vbaNew2': {
      const [cls, dst] = ctx.pop(2);
      const e: E = { k: 'new', cls: ctx.className(cls) };
      ctx.store(dst, e, { set: true });
      ctx.setReg('eax', ctx.deref(dst));
      return;
    }
    case '__vbaNew': {
      const [cls] = ctx.pop(1);
      ctx.setReg('eax', { k: 'new', cls: ctx.className(cls) });
      return;
    }
    case '__vbaCastObj': case '__vbaCastObjVar': {
      const [o] = ctx.pop(2);
      ctx.setReg('eax', val(o));
      return;
    }
    case '__vbaObjIs': {
      const [a, b] = ctx.pop(2);
      ctx.result({ k: 'b', op: 'Is', l: a, r: b });
      return;
    }
    case '__vbaHresultCheckObj': ctx.pop(4); ctx.setReg('eax', C(0)); return;
    case '__vbaHresultCheck': ctx.pop(1); ctx.setReg('eax', C(0)); return;
    case '__vbaLateIdCallLd': case '__vbaLateMemCallLd': case '__vbaVarLateMemCallLd': case '__vbaVarLateMemCallLdRf': {
      const args = ctx.pop((ctx.cdecl ?? Math.max(ctx.pending(), 4)));
      const [dst, obj, member, nargs, ...rest] = args;
      const o = name.startsWith('__vbaVar') ? ctx.variant(obj) : val(obj);
      const mname = memberName(member, name, ctx, o);
      ctx.store(dst, { k: 'mc', o, n: mname, args: lateArgs(rest, nargs, ctx), kind: 'method' });
      ctx.setReg('eax', dst);
      return;
    }
    case '__vbaLateIdCall': case '__vbaLateMemCall': case '__vbaLateMemNamedCall': case '__vbaLateIdNamedCall': {
      const args = ctx.pop((ctx.cdecl ?? Math.max(ctx.pending(), 3)));
      const [obj, member, nargs, ...rest] = args;
      ctx.emit({ k: 'expr', va: ctx.va, e: { k: 'mc', o: val(obj), n: memberName(member, name, ctx, val(obj)), args: lateArgs(rest, nargs, ctx), kind: 'method' } });
      return;
    }
    case '__vbaLateIdSt': case '__vbaLateMemSt': case '__vbaLateIdStAd': case '__vbaLateMemStAd': case '__vbaVarLateMemSt': case '__vbaVarLateMemStAd': case '__vbaLateIdCallSt': case '__vbaLateMemCallSt': {
      const args = ctx.pop((ctx.cdecl ?? Math.max(ctx.pending(), 3)));
      const [obj, member, ...rest] = args;
      const o = name.startsWith('__vbaVar') ? ctx.variant(obj) : val(obj);
      ctx.emit({ k: 'assign', va: ctx.va, dst: { k: 'mc', o, n: memberName(member, name, ctx, o), args: [], kind: 'get' }, src: rest.length ? ctx.variant(rest[rest.length - 1]) : RAW('?'), set: /StAd$/.test(name) });
      return;
    }
    case '__vbaRaiseEvent': {
      const args = ctx.pop((ctx.cdecl ?? Math.max(ctx.pending(), 3)));
      const [, id, , ...rest] = args;
      ctx.emit({ k: 'text', va: ctx.va, t: `RaiseEvent Event_${print(id)}(${rest.map(x => print(ctx.variant(x))).join(', ')})` });
      return;
    }

    // --- control flow / errors ---
    case '__vbaOnError': {
      const [n] = ctx.pop(1);
      const v = unref(n);
      ctx.onError();
      const t = v.k === 'c' ? (v.v === -1 ? 'On Error Resume Next' : v.v === 0 ? 'On Error GoTo 0' : 'On Error GoTo ErrorHandler') : 'On Error GoTo ErrorHandler';
      ctx.emit({ k: 'text', va: ctx.va, t });
      return;
    }
    case '__vbaResume': {
      const [n] = ctx.pop(1);
      const v = unref(n);
      ctx.emit({ k: 'text', va: ctx.va, t: v.k === 'c' && v.v === 0 ? 'Resume' : v.k === 'c' && v.v === -1 ? 'Resume Next' : 'Resume label' });
      return;
    }
    case '__vbaExitProc': case '__vbaErrorOverflow': case '__vbaGenerateBoundsError': case '__vbaFPException': case '__vbaSetSystemError':
    case '__vbaFailedFriend': case '__vbaFpR8': case '__vbaFpR4': case '__vbaExceptHandler': return;
    case '__vbaEnd': ctx.emit({ k: 'text', va: ctx.va, t: 'End' }); return;
    case '__vbaStopExe': ctx.emit({ k: 'text', va: ctx.va, t: 'Stop' }); return;
    case '__vbaError': { const [n] = ctx.pop(1); ctx.emit({ k: 'text', va: ctx.va, t: `Error ${print(n)}` }); return; }

    // --- numbers ---
    case '__vbaI2I4': case '__vbaUI1I2': case '__vbaUI1I4': {
      const v = r('ecx');
      ctx.setReg('eax', v);
      return;
    }
    case '__vbaFpI4': case '__vbaFpI2': case '__vbaFpUI1': {
      const v = ctx.fpuPop();
      ctx.setReg('eax', call(name === '__vbaFpI4' ? 'CLng' : name === '__vbaFpI2' ? 'CInt' : 'CByte', [v]));
      return;
    }
    case '__vbaFPInt': case '__vbaFPFix': {
      const v = ctx.fpuPop();
      ctx.fpuPush(call(name === '__vbaFPInt' ? 'Int' : 'Fix', [v]));
      return;
    }
    case '__vbaPowerR8': {
      const args = ctx.pop(4);
      ctx.fpuPush({ k: 'b', op: '^', l: args[0], r: args[2] });
      return;
    }
    case '_adj_fdiv_m64': case '_adj_fdiv_m32': case '_adj_fdivr_m64': case '_adj_fdivr_m32': case '_adj_fdiv_m32i': case '_adj_fdiv_m16i': {
      const n = name.endsWith('64') ? 2 : 1;
      const [m] = ctx.pop(n);
      const top = ctx.fpuPop();
      ctx.fpuPush(name.includes('fdivr') ? { k: 'b', op: '/', l: m, r: top } : { k: 'b', op: '/', l: top, r: m });
      return;
    }
    case '_adj_fdiv_r': case '_adj_fdivr_r': {
      const a = ctx.fpuPop(), b = ctx.fpuPop();
      ctx.fpuPush({ k: 'b', op: '/', l: b, r: a });
      return;
    }
    case '_CIsqrt': case '_CIsin': case '_CIcos': case '_CItan': case '_CIatan': case '_CIexp': case '_CIlog': {
      const fn: Record<string, string> = { _CIsqrt: 'Sqr', _CIsin: 'Sin', _CIcos: 'Cos', _CItan: 'Tan', _CIatan: 'Atn', _CIexp: 'Exp', _CIlog: 'Log' };
      ctx.fpuPush(call(fn[name], [ctx.fpuPop()]));
      return;
    }

    // --- arrays ---
    case '__vbaUbound': case '__vbaLbound': {
      const [dim, arr] = ctx.pop(2);
      ctx.result(call(name === '__vbaUbound' ? 'UBound' : 'LBound', [ctx.deref(arr), dim]));
      return;
    }
    case '__vbaRedim': case '__vbaRedimPreserve': case '__vbaRedimVar': case '__vbaRedimPreserveVar': case '__vbaRedimVar2': {
      const n = ctx.pending();
      const args = ctx.pop(n);
      // (flags, elemSize, &array, vt, ndims, ub1, lb1, ...)
      const arr = args[2];
      const dims: string[] = [];
      for (let k = 5; k + 1 < args.length; k += 2) dims.push(`${print(args[k + 1])} To ${print(args[k])}`);
      ctx.emit({ k: 'text', va: ctx.va, t: `ReDim ${name.includes('Preserve') ? 'Preserve ' : ''}${print(ctx.lv(arr ?? RAW('arr')))}(${dims.join(', ')})` });
      return;
    }
    case '__vbaErase': case '__vbaAryDestruct': {
      const [, arr] = ctx.pop(2);
      if (name === '__vbaErase') ctx.emit({ k: 'text', va: ctx.va, t: `Erase ${print(ctx.lv(arr))}` });
      return;
    }
    case '__vbaAryLock': ctx.pop(2); return;
    case '__vbaAryConstruct2': ctx.pop(3); return;
    case '__vbaAryCopy': { const [dst, src] = ctx.pop(2); ctx.store(dst, ctx.byRef(src)); return; }
    case '__vbaRefVarAry': { const [v] = ctx.pop(1); ctx.setReg('eax', v); return; }
    case '__vbaAryVar': { const [, v] = ctx.pop(2); ctx.setReg('eax', ctx.variant(v)); return; }
    case '__vbaRecDestruct': case '__vbaRecDestructAnsi': ctx.pop(2); return;
    case '__vbaRecAssign': { const [, dst, src] = ctx.pop(3); ctx.store(dst, ctx.deref(src)); return; }
    case '__vbaRecUniToAnsi': case '__vbaRecAnsiToUni': { const args = ctx.pop(3); ctx.setReg('eax', args[2]); return; }
    case '__vbaCopyBytes': { const [n, dst, src] = ctx.pop(3); ctx.emit({ k: 'text', va: ctx.va, t: `CopyMemory ${print(ctx.lv(dst))}, ${print(val(src))}, ${print(n)}` }); return; }

    // --- file I/O ---
    case '__vbaFileOpen': {
      const [mode, , fnum, file] = ctx.pop(4);
      const m = unref(mode);
      const modes: Record<number, string> = { 1: 'Input', 2: 'Output', 4: 'Random', 8: 'Append', 32: 'Binary' };
      const mm = m.k === 'c' ? (modes[m.v & 0xff] ?? `mode ${m.v}`) : print(mode);
      ctx.emit({ k: 'text', va: ctx.va, t: `Open ${print(val(file))} For ${mm} As #${print(fnum)}` });
      return;
    }
    case '__vbaFileClose': { const [n] = ctx.pop(1); ctx.emit({ k: 'text', va: ctx.va, t: `Close #${print(n)}` }); return; }
    case '__vbaFileCloseAll': ctx.emit({ k: 'text', va: ctx.va, t: 'Close' }); return;
    case '__vbaPrintFile': case '__vbaWriteFile': case '__vbaPrintObj': {
      const args = ctx.pop((ctx.cdecl ?? Math.max(ctx.pending(), 2)));
      const [target, , ...rest] = args;
      const kw = name === '__vbaWriteFile' ? 'Write' : 'Print';
      const items = rest.map(x => print(ctx.variant(x)));
      ctx.emit({ k: 'text', va: ctx.va, t: name === '__vbaPrintObj' ? `${print(val(target))}.Print ${items.join('; ')}` : `${kw} #${print(target)}, ${items.join('; ')}` });
      return;
    }
    case '__vbaLineInputStr': case '__vbaLineInputVar': {
      const [dst, n] = ctx.pop(2);
      ctx.emit({ k: 'text', va: ctx.va, t: `Line Input #${print(n)}, ${print(ctx.lv(dst))}` });
      return;
    }
    case '__vbaInputFile': case '__vbaGet3': case '__vbaGet4': case '__vbaPut3': case '__vbaPut4': case '__vbaGetFxStr4': case '__vbaPutFxStr4': case '__vbaGetOwner4': case '__vbaPutOwner4': {
      const n = ctx.pending();
      const args = ctx.pop(n);
      const kw = /Put/.test(name) ? 'Put' : 'Get';
      ctx.emit({ k: 'text', va: ctx.va, t: `${kw} ${args.map(a => print(val(a))).join(', ')}` });
      return;
    }
    case 'DllFunctionCall': { ctx.pop(1); return; }
    case '__vbaExitEachColl': case '__vbaExitEachAry': case '__vbaExitEachVar': return;
    case '__vbaForEachCollObj': case '__vbaForEachVar': case '__vbaForEachCollVar': case '__vbaForEachAry': {
      const n = ctx.pending();
      const args = ctx.pop(Math.min(n, 4));
      ctx.emit({ k: 'text', va: ctx.va, t: `For Each ${print(ctx.lv(args[args.length - 1] ?? RAW('item')))} In ${print(val(args[1] ?? RAW('coll')))}` });
      ctx.result(call('ForEach', [], { bool: true }));
      return;
    }
    case '__vbaNextEachCollObj': case '__vbaNextEachVar': case '__vbaNextEachCollVar': case '__vbaNextEachAry': {
      const n = ctx.pending();
      ctx.pop(Math.min(n, 3));
      ctx.emit({ k: 'text', va: ctx.va, t: 'Next' });
      ctx.result(call('ForEachNext', [], { bool: true }));
      return;
    }
  }
  if (VAR_BIN[name]) {
    const [dst, a1, a2] = ctx.pop(3);
    const op = VAR_BIN[name];
    ctx.store(dst, { k: 'b', op, l: ctx.variant(a2), r: ctx.variant(a1) });
    ctx.setReg('eax', dst);
    return;
  }
  if (VAR_TST[name]) {
    const [a1, a2] = ctx.pop(2);
    ctx.result({ k: 'b', op: VAR_TST[name], l: ctx.variant(a1), r: ctx.variant(a2) });
    return;
  }
  if (CONV1[name]) {
    const [fn, kind] = CONV1[name];
    const [a] = ctx.pop(1);
    const isVar = /Var$/.test(name) || /VarCopy|VarMove|ErrVar/.test(name);
    const v = isVar ? ctx.variant(a) : val(a);
    const e = fn ? call(fn, [v], kind === 'b' ? { bool: true } : {}) : v;
    if (kind === 'f') ctx.fpuPush(e);
    else if (fn === '' ) ctx.setReg('eax', e);
    else ctx.result(e);
    return;
  }
  if (name === '__vbaStrVarVal') {
    const [, v] = ctx.pop(2);
    ctx.result(call('CStr', [ctx.variant(v)]));
    return;
  }
  if (name === '__vbaLenVar') {
    const [dst, v] = ctx.pop(2);
    ctx.store(dst, call('Len', [ctx.variant(v)]));
    ctx.setReg('eax', dst);
    return;
  }
  const rt = RT[name];
  if (rt) {
    const args = ctx.pop(rt.n);
    if (rt.kind === 'd') {
      const [dst, ...rest] = args;
      const e = call(rt.vb, trim(rest.map(a => ctx.variant(a))));
      ctx.store(dst, e);
      ctx.setReg('eax', dst);
      return;
    }
    const conv = args.filter((_, k) => !(rt.dbl ?? []).map(x => x + 1).includes(k)).map(a => ctx.variant(a));
    const e = call(rt.vb, trim(conv), rt.kind === 'b' ? { bool: true } : {});
    if (rt.kind === 'f') ctx.fpuPush(e);
    else if (rt.kind === 's') ctx.emit({ k: 'expr', va: ctx.va, e: { ...e, noParens: true } as E });
    else if (rt.kind === 'r' && (rt.vb === 'Err' || rt.vb === 'Erl')) ctx.setReg('eax', V(rt.vb));
    else ctx.result(e);
    return;
  }
  // Unknown runtime/API function: consume pending arguments heuristically
  const n = ctx.cdecl ?? ctx.pending();
  const args = ctx.pop(n).map(val);
  const vbName = name.startsWith('rtc') ? name.slice(3).replace(/(Var|Bstr)$/, '') : name;
  ctx.result(call(vbName, args));
}

function trim(args: E[]): E[] {
  const a = [...args];
  while (a.length && unref(a[a.length - 1]).k === 'missing') a.pop();
  return a;
}

/** Late-bound calls pass their arguments as Variants copied onto the stack (4 dwords each). */
function lateArgs(rest: E[], nargs: E | undefined, ctx: RtCtx): E[] {
  const n = nargs ? unref(nargs) : undefined;
  if (n && n.k === 'c' && n.v > 0 && rest.length === n.v * 4) {
    const out: E[] = [];
    for (let k = 0; k < n.v; k++) {
      const vtE = unref(rest[k * 4]);
      const data = rest[k * 4 + 2];
      if (vtE.k !== 'c') { out.push(ctx.variant(rest[k * 4])); continue; }
      const vt = vtE.v & 0xffff;
      if (vt === 10) { out.push({ k: 'missing' }); continue; }
      if (vt & 0x4000) { out.push(ctx.byRef(data)); continue; }
      const u = unref(data);
      if (vt === 11 && u.k === 'c') { out.push({ k: 'c', v: u.v ? -1 : 0, t: 'bool' }); continue; }
      if (vt === 5 && u.k === 'c') {
        const hi = unref(rest[k * 4 + 3]);
        if (hi.k === 'c') { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, u.v >>> 0, true); dv.setUint32(4, hi.v >>> 0, true); out.push({ k: 'f', v: dv.getFloat64(0, true) }); continue; }
      }
      if (vt === 2 && u.k === 'c') { out.push({ k: 'c', v: (u.v << 16) >> 16 }); continue; }
      out.push(data);
    }
    return out.reverse();
  }
  return rest.reverse().map(x => ctx.variant(x));
}

function memberName(m: E | undefined, fname: string, ctx?: RtCtx, obj?: E): string {
  if (!m) return 'Member';
  const u = unref(m);
  if (u.k === 's') return u.v;
  if (u.k === 'c' && !/Id/.test(fname) && ctx) { const s = ctx.cstr(u.v >>> 0); if (s) return s; }
  if (u.k === 'raw' && ctx) { const m2 = /^[0-9A-F]+$/.exec(u.t); void m2; }
  if (u.k === 'c' && /Id/.test(fname) && ctx && obj) { const n = ctx.dispName(obj, u.v | 0); if (n) return n; }
  if (u.k === 'c') return /Id/.test(fname) ? `DispID_${(u.v >>> 0).toString(16).toUpperCase()}` : `Member_${u.v}`;
  return print(m);
}

function printStep(e: E): string {
  const u = unref(e);
  if (u.k === 'c' && u.v === 1) return '';
  if (u.k === 'missing') return '';
  return ` Step ${print(e)}`;
}

import { printE } from './ir';
function print(e: E): string { return printE(e); }
export { CALL };

/** VB-level name of a runtime export (rtcLeftCharBstr -> Left$), for P-Code calls. */
export function vbRuntimeName(name: string): string {
  const r = RT[name];
  if (r) return r.vb;
  return name.replace(/^rtc/, '').replace(/^__vba/, '');
}
