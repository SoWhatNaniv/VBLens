// Session: owns one loaded executable and answers UI queries with plain,
// structured-clone friendly data. Runs inside a Web Worker in the app and
// directly in Node for the test-suite.

import { Image, hex } from './pe/pe';
import { parseVBProject, VBProject, VBObject } from './vb/structures';
import { analyze, Analysis, disassembleFunction, symbolName, funcContaining, Func } from './analysis/analysis';
import { parseForm, ParsedForm, FormControl } from './vb/forms';
import { decompileNative, DecompileResult } from './decompiler/native';
import { insnTokens, Tok } from './x86/format';
import { zipSync, strToU8 } from 'fflate';
import { loadTypeLibFromFile } from './typelib/msft';
import { registerTypeLib } from './data/vbclasses';
import { probeString } from './analysis/analysis';
import { decompilePCodeProc, pcodeProcs, PCodeProc } from './pcode/pcode';

export interface TreeNode {
  id: string;
  label: string;
  kind: string;
  children?: TreeNode[];
  va?: number;
  obj?: number;
  badge?: string;
  detail?: string;
}

export interface CodeLine { text: string; va?: number; indent: number; kind?: string }
export interface CodeDoc { title: string; header: string; lines: CodeLine[]; va?: number; end?: number; obj?: number; errors: string[]; footer?: string }

export interface DisasmRow {
  va: number;
  bytes: string;
  toks: Tok[];
  comment?: string;
  label?: string;
  blockStart?: boolean;
  data?: boolean;
}

export interface GraphData { nodes: { id: number; rows: DisasmRow[] }[]; edges: { from: number; to: number; kind: 'true' | 'false' | 'jump' | 'fall' }[]; entry: number }

export interface ProgressFn { (msg: string, pct: number): void }

export interface FormView {
  obj: number;
  name: string;
  frm: string;
  errors: string[];
  codepage: string;
  root?: FormControlView;
}
export interface FormControlView {
  name: string; className: string; typeCode: number; cId: number; index?: number;
  left?: number; top?: number; width?: number; height?: number;
  clientWidth?: number; clientHeight?: number;
  caption?: string; text?: string; backColor?: number; foreColor?: number; visible?: boolean; enabled?: boolean;
  font?: { name: string; size: number; bold: boolean; italic: boolean; underline: boolean; charset: number };
  borderStyle?: number; alignment?: number; style?: number; value?: number; checked?: boolean;
  props: { name: string; value: string }[];
  pictures: { prop: string; mime: string; bytes: Uint8Array }[];
  children: FormControlView[];
  rtl?: boolean;
  events: { name: string; va: number }[];
  list?: string[];
}

const KIND_LABEL: Record<string, string> = { Form: 'Forms', MDIForm: 'Forms', Module: 'Modules', Class: 'Classes', UserControl: 'User Controls', PropertyPage: 'Property Pages', UserDocument: 'User Documents', Designer: 'Designers' };

/** "Sub" / "Function" / "Property" for the End statement matching a header. */
function endKeyword(header: string): string {
  const m = /^(?:Public |Private |Friend )?(Sub|Function|Property)\b/.exec(header);
  return m ? m[1] : 'Sub';
}

export class Session {
  img: Image;
  project: VBProject;
  an: Analysis;
  name: string;
  forms = new Map<number, ParsedForm>();
  decompCache = new Map<number, DecompileResult>();
  comments = new Map<number, string>();
  pcode = new Map<number, PCodeProc>(); // p-code procedures by VA
  fileHash: string;

  constructor(bytes: Uint8Array, name: string, progress?: ProgressFn) {
    this.name = name;
    progress?.('Parsing PE headers', 0.02);
    this.img = new Image(bytes);
    progress?.('Reading Visual Basic structures', 0.05);
    this.project = parseVBProject(this.img);
    progress?.('Decoding forms', 0.08);
    for (const o of this.project.objects) {
      if (o.formDataVA) {
        try { this.forms.set(o.index, parseForm(this.img, this.project, o)); } catch (e) { this.project.warnings.push(`Form ${o.name}: ${(e as Error).message}`); }
      }
    }
    if (this.project.isPCode) {
      progress?.('Reading P-Code procedures', 0.2);
      for (const p of pcodeProcs(this.img, this.project)) this.pcode.set(p.va, p);
    }
    this.an = analyze(this.img, this.project, (m, p) => progress?.(m, 0.1 + p * 0.85));
    if (this.project.isPCode) {
      // P-code procedures are not native functions: register them for naming / navigation
      for (const p of this.pcode.values()) {
        if (!this.an.funcByVA.has(p.va)) {
          const f: Func = { va: p.va, end: p.va + p.size, name: p.name, fullName: p.fullName, kind: p.kind, obj: p.obj, argBytes: p.argBytes, aliases: [], ctl: p.ctl, event: p.event };
          this.an.funcs.push(f);
          this.an.funcByVA.set(p.va, f);
        }
      }
      this.an.funcs.sort((a, b) => a.va - b.va);
      // string literals and API calls referenced from P-Code (through the constant pools)
      for (const p of this.pcode.values()) for (const i of p.insns) for (const o of i.ops) {
        if ((o.k !== 's' && o.k !== 'x' && o.k !== 'c') || !p.constPool) continue;
        const a = this.img.u32(p.constPool + o.v * 4);
        if (!this.img.isMapped(a)) continue;
        if (o.k === 's') {
          const str = probeString(this.img, a);
          if (!str) continue;
          const ex = this.an.strings.get(a);
          if (ex) ex.refs++; else this.an.strings.set(a, { va: a, text: str.text, kind: str.kind, refs: 1 });
        } else if (!this.an.declareStubs.has(a) && !this.img.importsByIat.has(a)) continue;
        const xs = this.an.xrefs.get(a) ?? [];
        xs.push({ from: i.va, kind: o.k === 's' ? 'str' : 'call', func: p.va });
        this.an.xrefs.set(a, xs);
      }
    }
    this.fileHash = quickHash(bytes);
    progress?.('Ready', 1);
  }

  // --- overview ---------------------------------------------------------------
  overview() {
    const p = this.project;
    const kinds: Record<string, number> = {};
    for (const o of p.objects) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
    const funcKinds: Record<string, number> = {};
    for (const f of this.an.funcs) funcKinds[f.kind] = (funcKinds[f.kind] ?? 0) + 1;
    // runtime usage
    const usage = new Map<string, number>();
    for (const [va, xs] of this.an.xrefs) {
      const n = this.an.thunks.get(va) ?? this.an.iatNames.get(va);
      if (n) usage.set(n, (usage.get(n) ?? 0) + xs.length);
    }
    const topRuntime = [...usage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const sizes = this.an.funcs.map(f => f.end - f.va);
    const controls = [...this.forms.values()].reduce((a, f) => a + f.controls.length, 0);
    const libs = new Map<string, number>();
    for (const d of p.declares) if (d.lib) libs.set(d.lib.toLowerCase(), (libs.get(d.lib.toLowerCase()) ?? 0) + 1);
    return {
      fileName: this.name,
      fileSize: this.img.bytes.length,
      hash: this.fileHash,
      projectName: p.projectName,
      exeName: p.projectExeName,
      description: p.projectDescription,
      helpFile: p.projectHelpFile,
      vbVersion: p.vbVersion,
      compile: p.isPCode ? 'P-Code' : 'Native code',
      runtimeBuild: p.runtimeBuild,
      lcid: p.lcid,
      timestamp: this.img.timestamp,
      imageBase: this.img.imageBase,
      entryPoint: this.img.entryPoint,
      headerVA: p.headerVA,
      subMain: p.subMainVA,
      pathInformation: p.pathInformation,
      threading: p.threadFlags,
      objects: kinds,
      funcKinds,
      functions: this.an.funcs.length,
      instructions: this.an.stats.instructions,
      analysisMs: this.an.stats.ms,
      strings: this.an.strings.size,
      declares: p.declares.length,
      components: p.components.map(c => ({ name: c.name, file: c.file, progId: c.libName, guid: c.guid })),
      controls,
      topRuntime,
      apiLibs: [...libs.entries()].sort((a, b) => b[1] - a[1]),
      largest: this.an.funcs.map(f => ({ name: f.fullName, va: f.va, size: f.end - f.va })).sort((a, b) => b.size - a.size).slice(0, 10),
      totalCode: sizes.reduce((a, b) => a + b, 0),
      sections: this.img.sections.map(s => ({ name: s.name, va: s.va, vsize: s.vsize, rawSize: s.rawSize, exec: s.executable })),
      warnings: p.warnings.slice(0, 50),
      projectGuid: p.projectGuid,
    };
  }

  // --- project tree -------------------------------------------------------------
  tree(): TreeNode[] {
    const p = this.project;
    const groups = new Map<string, TreeNode>();
    const order = ['Forms', 'Modules', 'Classes', 'User Controls', 'Property Pages', 'User Documents', 'Designers'];
    for (const o of p.objects) {
      const g = KIND_LABEL[o.kind] ?? 'Other';
      if (!groups.has(g)) groups.set(g, { id: 'grp:' + g, label: g, kind: 'folder', children: [] });
      const funcs = this.an.funcs.filter(f => f.obj === o.index);
      const node: TreeNode = { id: 'obj:' + o.index, label: o.name, kind: o.kind.toLowerCase(), obj: o.index, children: [], badge: String(funcs.length) };
      const pf = this.forms.get(o.index);
      if (pf?.root) {
        const ctlNode: TreeNode = { id: `ctls:${o.index}`, label: 'Controls', kind: 'controls', obj: o.index, children: [], badge: String(pf.controls.length - 1) };
        const walk = (c: FormControl, parent: TreeNode) => {
          for (const ch of c.children) {
            const n: TreeNode = { id: `ctl:${o.index}:${ch.cId}:${ch.name}:${ch.arrayIndex ?? ''}`, label: ch.arrayIndex !== undefined ? `${ch.name}(${ch.arrayIndex})` : ch.name, kind: 'control', obj: o.index, detail: ch.className.replace(/^VB\./, ''), children: [] };
            parent.children!.push(n);
            walk(ch, n);
            if (!n.children!.length) delete n.children;
          }
        };
        walk(pf.root, ctlNode);
        node.children!.push(ctlNode);
      }
      for (const f of funcs.sort((a, b) => a.name.localeCompare(b.name))) {
        node.children!.push({ id: 'fn:' + f.va, label: f.name, kind: f.kind === 'event' ? 'event' : 'proc', va: f.va, obj: o.index, detail: f.attributionGuess ? '~' : undefined });
      }
      groups.get(g)!.children!.push(node);
    }
    const out: TreeNode[] = [{ id: 'overview', label: 'Overview', kind: 'overview' }];
    for (const g of order) if (groups.has(g)) { const n = groups.get(g)!; n.badge = String(n.children!.length); out.push(n); }
    const loose = this.an.funcs.filter(f => f.obj < 0);
    if (loose.length) out.push({ id: 'grp:loose', label: 'Unattributed code', kind: 'folder', badge: String(loose.length), children: loose.map(f => ({ id: 'fn:' + f.va, label: f.name, kind: f.kind === 'main' ? 'event' : 'proc', va: f.va })) });
    out.push({ id: 'declares', label: 'API Declares', kind: 'declares', badge: String(p.declares.filter(d => d.func).length) });
    out.push({ id: 'components', label: 'References', kind: 'components', badge: String(p.components.length) });
    out.push({ id: 'strings', label: 'Strings', kind: 'strings', badge: String(this.an.strings.size) });
    out.push({ id: 'imports', label: 'Imports', kind: 'imports', badge: String(this.img.imports.length) });
    out.push({ id: 'hex', label: 'Hex view', kind: 'hex' });
    return out;
  }

  // --- code -----------------------------------------------------------------------
  private decomp(f: Func): DecompileResult {
    let r = this.decompCache.get(f.va);
    if (!r) {
      const pc = this.pcode.get(f.va);
      r = pc ? decompilePCodeProc(this.img, this.project, this.an, pc, this.pcode) : decompileNative(this.an, f, { forms: this.forms });
      this.decompCache.set(f.va, r);
    }
    return r;
  }

  decompile(va: number): CodeDoc {
    const f = this.an.funcByVA.get(va) ?? funcContaining(this.an, va);
    if (!f) return { title: hex(va), header: '', lines: [{ text: `' No procedure at ${hex(va)}`, indent: 0, kind: 'comment' }], errors: [] };
    const r = this.decomp(f);
    const kw = endKeyword(r.header);
    return {
      title: f.fullName,
      header: r.header,
      lines: this.withComments(r.lines.map(l => ({ text: l.text, va: l.va, indent: l.indent, kind: l.kind }))),
      va: f.va, end: f.end, obj: f.obj, errors: r.errors,
      footer: `End ${kw}`,
    };
  }

  private withComments(lines: CodeLine[]): CodeLine[] {
    if (!this.comments.size) return lines;
    const done = new Set<number>();
    return lines.map(l => {
      if (l.va === undefined || done.has(l.va) || !this.comments.has(l.va)) return l;
      done.add(l.va);
      return { ...l, text: `${l.text}  ' ${this.comments.get(l.va)}` };
    });
  }

  /** Full source of an object (form/module/class) — all procedures decompiled. */
  objectSource(objIdx: number): CodeDoc {
    const o = this.project.objects[objIdx];
    const funcs = this.an.funcs.filter(f => f.obj === objIdx).sort((a, b) => a.va - b.va);
    const lines: CodeLine[] = [];
    lines.push({ text: `Attribute VB_Name = "${o.name}"`, indent: 0, kind: 'decl' });
    if (o.kind === 'Module') {
      const decl = this.declaresFor(objIdx);
      for (const d of decl) lines.push({ text: d, indent: 0, kind: 'decl' });
    }
    if (funcs.some(f => f.attributionGuess)) lines.push({ text: `' Note: procedures were attributed to this module by layout analysis`, indent: 0, kind: 'comment' });
    for (const f of funcs) {
      const r = this.decomp(f);
      lines.push({ text: '', indent: 0 });
      lines.push({ text: `' ${hex(f.va)}`, indent: 0, kind: 'comment', va: f.va });
      lines.push({ text: r.header, indent: 0, va: f.va, kind: 'header' });
      for (const l of r.lines) lines.push({ text: l.text, va: l.va, indent: l.indent, kind: l.kind });
      lines.push({ text: `End ${endKeyword(r.header)}`, indent: 0 });
    }
    return { title: o.name, header: '', lines, obj: objIdx, errors: [] };
  }

  /** API declares, grouped heuristically with the module whose code calls them most. */
  declaresFor(objIdx: number): string[] {
    const owner = new Map<number, number>(); // declare index -> obj
    if (!this._declOwner) {
      this._declOwner = new Map();
      for (const [stub, d] of this.an.declareStubs) {
        const counts = new Map<number, number>();
        for (const x of this.an.xrefs.get(stub) ?? []) { const f = this.an.funcByVA.get(x.func); if (f && f.obj >= 0) counts.set(f.obj, (counts.get(f.obj) ?? 0) + 1); }
        let best = -1, n = 0;
        for (const [o, c] of counts) if (c > n) { best = o; n = c; }
        this._declOwner.set(d.index, best);
      }
    }
    void owner;
    const out: string[] = [];
    for (const d of this.project.declares) {
      if (!d.func) continue;
      if ((this._declOwner.get(d.index) ?? -1) !== objIdx) continue;
      out.push(`Private Declare Function ${d.func} Lib "${d.lib}" (...)`);
    }
    return out;
  }
  private _declOwner?: Map<number, number>;

  disasm(va: number): { title: string; rows: DisasmRow[]; va: number; end: number } {
    const f = this.an.funcByVA.get(va) ?? funcContaining(this.an, va);
    if (!f) return { title: hex(va), rows: this.rawDisasm(va, 200), va, end: va };
    if (this.pcode.has(f.va)) {
      const pc = this.pcode.get(f.va)!;
      return { title: f.fullName, rows: pc.rows, va: f.va, end: f.end };
    }
    const fc = disassembleFunction(this.an, f);
    const rows: DisasmRow[] = [];
    const starts = new Set(fc.blocks.map(b => b.start));
    const items: { va: number; row: DisasmRow }[] = [];
    for (const i of fc.insns) items.push({ va: i.va, row: this.row(i, starts.has(i.va)) });
    for (const u of fc.unreached) {
      for (let a = u.start; a < u.end; a += 16) {
        const n = Math.min(16, u.end - a);
        const b = this.img.slice(a, n);
        items.push({ va: a, row: { va: a, bytes: [...b].map(x => x.toString(16).padStart(2, '0')).join(' '), toks: [{ k: 'kw', t: 'db ' }, { k: 'num', t: [...b].map(x => '0x' + x.toString(16).padStart(2, '0')).join(', ') }], data: true } });
      }
    }
    items.sort((a, b) => a.va - b.va);
    for (const it of items) rows.push(it.row);
    if (rows.length) rows[0].label = f.fullName;
    return { title: f.fullName, rows, va: f.va, end: f.end };
  }

  private symResolver = {
    name: (a: number) => {
      const s = symbolName(this.an, a);
      if (s) return s;
      return undefined;
    },
    isAddr: (a: number) => this.img.inImage(a) && this.img.isMapped(a),
  };

  private row(i: import('./x86/decoder').Insn, blockStart: boolean): DisasmRow {
    const bytes = this.img.slice(i.va, i.len);
    const toks = insnTokens(i, this.symResolver);
    let comment = this.comments.get(i.va);
    if (!comment) {
      for (const op of i.ops) {
        let a: number | undefined;
        if (op.t === 'i' && op.sz === 4) a = op.v;
        else if (op.t === 'm' && !op.base && !op.idx && op.disp !== undefined) a = op.disp >>> 0;
        if (a === undefined) continue;
        const s = this.an.strings.get(a);
        if (s) { comment = JSON.stringify(s.text.length > 80 ? s.text.slice(0, 80) + '…' : s.text); break; }
      }
    }
    const label = this.an.labels.get(i.va);
    return { va: i.va, bytes: [...bytes].map(x => x.toString(16).padStart(2, '0')).join(' '), toks, comment, blockStart, label };
  }

  private rawDisasm(va: number, count: number): DisasmRow[] {
    const rows: DisasmRow[] = [];
    let a = va;
    const off0 = this.img.offsetOf(va);
    if (off0 < 0) return rows;
    for (let n = 0; n < count; n++) {
      const o = this.img.offsetOf(a);
      if (o < 0) break;
      const i = decodeAt(this.img, a);
      rows.push(this.row(i, false));
      a += i.len;
    }
    return rows;
  }

  graph(va: number): GraphData {
    const f = this.an.funcByVA.get(va) ?? funcContaining(this.an, va);
    if (!f) return { nodes: [], edges: [], entry: va };
    const pc = this.pcode.get(f.va);
    if (pc) return this.pcodeGraph(pc);
    const fc = disassembleFunction(this.an, f);
    const nodes = fc.blocks.map(b => ({ id: b.start, rows: b.insns.map(i => this.row(i, false)) }));
    const edges: GraphData['edges'] = [];
    for (const b of fc.blocks) {
      const last = b.insns[b.insns.length - 1];
      const cond = last && last.mn[0] === 'j' && last.mn !== 'jmp';
      for (const s of b.succ) {
        let kind: GraphData['edges'][number]['kind'] = 'jump';
        if (cond) kind = s === last.ops[0]?.v ? 'true' : 'false';
        else if (last && last.mn !== 'jmp') kind = 'fall';
        edges.push({ from: b.start, to: s, kind });
      }
    }
    return { nodes, edges, entry: f.va };
  }

  /** Control-flow graph of a P-Code procedure (blocks split at branch targets). */
  private pcodeGraph(pc: PCodeProc): GraphData {
    const ins = pc.insns;
    const target = (i: (typeof ins)[number]) => i.ops.find(o => o.k === 'l')?.target;
    const starts = new Set<number>([pc.va]);
    ins.forEach((i, k) => {
      const t = target(i);
      if (t !== undefined && /^(Branch|Next|For|OnError)/.test(i.mn)) { if (!i.mn.startsWith('OnError')) starts.add(t); if (ins[k + 1]) starts.add(ins[k + 1].va); }
      if (/^ExitProc/.test(i.mn) && ins[k + 1]) starts.add(ins[k + 1].va);
    });
    const rowBy = new Map(pc.rows.map(r => [r.va, r]));
    const nodes: GraphData['nodes'] = [];
    const edges: GraphData['edges'] = [];
    let cur: GraphData['nodes'][number] | undefined;
    ins.forEach((i, k) => {
      if (starts.has(i.va) || !cur) { cur = { id: i.va, rows: [] }; nodes.push(cur); }
      const r = rowBy.get(i.va);
      if (r) cur.rows.push({ va: r.va, bytes: r.bytes, toks: r.toks, comment: r.comment });
      const next = ins[k + 1];
      const end = !next || starts.has(next.va);
      if (!end) return;
      const t = target(i);
      if (i.mn === 'Branch' && t !== undefined) edges.push({ from: cur.id, to: t, kind: 'jump' });
      else if (/^Branch[FT]/.test(i.mn) && t !== undefined) {
        edges.push({ from: cur.id, to: t, kind: i.mn.startsWith('BranchF') ? 'false' : 'true' });
        if (next) edges.push({ from: cur.id, to: next.va, kind: i.mn.startsWith('BranchF') ? 'true' : 'false' });
      } else if (/^Next/.test(i.mn) && t !== undefined) {
        edges.push({ from: cur.id, to: t, kind: 'true' });
        if (next) edges.push({ from: cur.id, to: next.va, kind: 'false' });
      } else if (!/^ExitProc/.test(i.mn) && next) edges.push({ from: cur.id, to: next.va, kind: 'fall' });
    });
    return { nodes, edges, entry: pc.va };
  }

  hexDump(va: number, len: number): { va: number; bytes: Uint8Array } {
    const off = this.img.offsetOf(va);
    if (off < 0) return { va, bytes: new Uint8Array(0) };
    return { va, bytes: this.img.bytes.slice(off, Math.min(off + len, this.img.bytes.length)) };
  }

  hexRange() {
    return this.img.sections.map(s => ({ name: s.name, va: s.va, size: Math.min(s.rawSize, s.vsize || s.rawSize) }));
  }

  funcInfo(va: number) {
    const f = this.an.funcByVA.get(va) ?? funcContaining(this.an, va);
    if (!f) return undefined;
    const callers = (this.an.xrefs.get(f.va) ?? []).map(x => ({ from: x.from, kind: x.kind, func: x.func, name: this.an.funcByVA.get(x.func)?.fullName ?? hex(x.from) }));
    // callees and strings
    const callees = new Map<number, string>();
    const strs = new Map<number, string>();
    for (const [to, xs] of this.an.xrefs) {
      for (const x of xs) {
        if (x.func !== f.va) continue;
        if (x.kind === 'call' || x.kind === 'jmp') {
          const n = symbolName(this.an, to);
          if (n && to !== f.va && !(to >= f.va && to < f.end)) callees.set(to, n);
        } else if (x.kind === 'str') strs.set(to, this.an.strings.get(to)!.text);
      }
    }
    const o = f.obj >= 0 ? this.project.objects[f.obj] : undefined;
    return {
      va: f.va, end: f.end, size: f.end - f.va, name: f.name, fullName: f.fullName, kind: f.kind, obj: f.obj, objName: o?.name, objKind: o?.kind,
      args: f.argBytes / 4, guess: !!f.attributionGuess, aliases: f.aliases, control: f.ctl, event: f.event, vtable: f.vtableOffset,
      callers, callees: [...callees].map(([va, name]) => ({ va, name })).sort((a, b) => a.name.localeCompare(b.name)),
      strings: [...strs].map(([va, text]) => ({ va, text })),
      pcode: this.pcode.has(f.va),
    };
  }

  xrefsTo(va: number) {
    return (this.an.xrefs.get(va) ?? []).map(x => ({ from: x.from, kind: x.kind, func: x.func, name: this.an.funcByVA.get(x.func)?.fullName ?? hex(x.func) }));
  }

  strings() {
    return [...this.an.strings.values()].sort((a, b) => a.va - b.va).map(s => ({ va: s.va, text: s.text, refs: s.refs }));
  }

  imports() {
    const counts = new Map<string, number>();
    const refVA = new Map<string, number[]>();
    for (const [va, xs] of this.an.xrefs) {
      const n = this.an.thunks.get(va) ?? this.an.iatNames.get(va);
      if (n) { counts.set(n, (counts.get(n) ?? 0) + xs.length); (refVA.get(n) ?? refVA.set(n, []).get(n)!).push(va); }
    }
    return this.img.imports.map(i => {
      const name = this.an.iatNames.get(i.iatVA) ?? '';
      return { dll: i.dll, name, ordinal: i.ordinal, iat: i.iatVA, uses: counts.get(name) ?? 0, refs: refVA.get(name) ?? [] };
    });
  }

  /** xrefs to any of several addresses (e.g. an import's IAT slot and its thunk). */
  xrefsToMany(vas: number[]) {
    return vas.flatMap(v => this.xrefsTo(v).map(x => ({ ...x, to: v }))).sort((a, b) => a.from - b.from);
  }

  /** Names the code view can link: procedure names -> address. */
  symbols() {
    const out: [string, number, number][] = []; // name, va, obj
    for (const f of this.an.funcs) { out.push([f.fullName, f.va, f.obj]); if (f.name !== f.fullName) out.push([f.name, f.va, f.obj]); }
    for (const [va, n] of this.an.globals) out.push([n, va, -2]);
    return out;
  }

  declares() {
    return this.project.declares.filter(d => d.func).map(d => {
      let stub = 0;
      for (const [s, dd] of this.an.declareStubs) if (dd === d) stub = s;
      return { index: d.index, lib: d.lib, func: d.func, stub, uses: stub ? (this.an.xrefs.get(stub)?.length ?? 0) : 0 };
    });
  }

  components() { return this.project.components.map(c => ({ name: c.name, file: c.file, progId: c.libName, guid: c.guid })); }

  form(objIdx: number): FormView | undefined {
    const o = this.project.objects[objIdx];
    const pf = this.forms.get(objIdx);
    if (!o || !pf) return undefined;
    const handlers = new Map<string, { name: string; va: number }[]>();
    for (const f of this.an.funcs) if (f.obj === objIdx && f.kind === 'event' && f.ctl) {
      const l = handlers.get(f.ctl) ?? [];
      l.push({ name: f.event ?? f.name, va: f.va });
      handlers.set(f.ctl, l);
    }
    const formCtl = o.controls.find(c => ['Form', 'MDIForm', 'UserControl'].includes(c.className))?.name ?? 'Form';
    const conv = (c: FormControl, isRoot: boolean): FormControlView => ({
      name: c.name, className: c.className, typeCode: c.typeCode, cId: c.cId, index: c.arrayIndex,
      left: c.left, top: c.top, width: c.width, height: c.height, clientWidth: c.clientWidth, clientHeight: c.clientHeight,
      caption: c.caption, text: c.text, backColor: c.backColor, foreColor: c.foreColor, visible: c.visible, enabled: c.enabled,
      font: c.font ? { name: c.font.name, size: c.font.size, bold: c.font.bold, italic: c.font.italic, underline: c.font.underline, charset: c.font.charset } : undefined,
      borderStyle: c.borderStyle, alignment: c.alignment, style: c.style, value: c.value, checked: c.checked,
      props: c.props.map(p => ({ name: p.name, value: p.value })),
      pictures: c.pictures.map(p => ({ prop: p.prop, mime: p.mime, bytes: p.bytes.slice() })),
      children: c.children.map(ch => conv(ch, false)),
      rtl: c.props.some(p => p.name === 'RightToLeft' && p.value.startsWith('-1')),
      events: handlers.get(isRoot ? formCtl : c.name) ?? [],
      list: c.props.find(p => p.name === 'List')?.value.split(/",\s*"/).map(x => x.replace(/^"|"$/g, '')),
    });
    return { obj: objIdx, name: o.name, frm: pf.frm, errors: pf.errors, codepage: pf.codepage, root: pf.root ? conv(pf.root, true) : undefined };
  }

  // --- navigation / search ------------------------------------------------------------
  resolve(va: number): { kind: 'func' | 'string' | 'global' | 'import' | 'code' | 'data' | 'none'; va: number; func?: number; name?: string } {
    if (this.an.funcByVA.has(va)) return { kind: 'func', va, func: va, name: this.an.funcByVA.get(va)!.fullName };
    const f = funcContaining(this.an, va);
    if (f) return { kind: 'code', va, func: f.va, name: f.fullName };
    if (this.an.strings.has(va)) return { kind: 'string', va, name: this.an.strings.get(va)!.text };
    if (this.an.thunks.has(va) || this.an.iatNames.has(va)) return { kind: 'import', va, name: this.an.thunks.get(va) ?? this.an.iatNames.get(va) };
    if (this.an.globals.has(va)) return { kind: 'global', va, name: this.an.globals.get(va) };
    if (this.img.isMapped(va)) return { kind: 'data', va };
    return { kind: 'none', va };
  }

  search(q: string, limit = 60) {
    const res: { kind: string; label: string; detail?: string; va?: number; obj?: number; score: number }[] = [];
    const ql = q.toLowerCase();
    const score = (s: string) => {
      const l = s.toLowerCase();
      if (l === ql) return 100;
      if (l.startsWith(ql)) return 80;
      const i = l.indexOf(ql);
      if (i >= 0) return 60 - Math.min(i, 30);
      // fuzzy subsequence
      let k = 0;
      for (const ch of l) if (ch === ql[k]) k++;
      return k === ql.length ? 20 : -1;
    };
    if (/^(0x)?[0-9a-f]{5,8}$/i.test(q)) {
      const va = parseInt(q.replace(/^0x/i, ''), 16);
      const r = this.resolve(va);
      if (r.kind !== 'none') res.push({ kind: 'address', label: hex(va), detail: r.name ?? r.kind, va, score: 200 });
    }
    for (const o of this.project.objects) { const s = score(o.name); if (s > 0) res.push({ kind: o.kind.toLowerCase(), label: o.name, detail: o.kind, obj: o.index, score: s + 5 }); }
    for (const f of this.an.funcs) { const s = Math.max(score(f.name), score(f.fullName) - 5); if (s > 0) res.push({ kind: f.kind === 'event' ? 'event' : 'proc', label: f.fullName, detail: hex(f.va), va: f.va, score: s }); }
    for (const [oi, pf] of this.forms) for (const c of pf.controls) { const s = score(c.name); if (s > 0) res.push({ kind: 'control', label: c.name, detail: `${this.project.objects[oi].name} · ${c.className}`, obj: oi, score: s - 3 }); }
    if (q.length >= 3) for (const st of this.an.strings.values()) { if (st.text.toLowerCase().includes(ql)) res.push({ kind: 'string', label: st.text.slice(0, 100), detail: hex(st.va), va: st.va, score: 30 }); }
    for (const d of this.project.declares) if (d.func) { const s = score(d.func); if (s > 0) res.push({ kind: 'declare', label: d.func, detail: d.lib, score: s - 2 }); }
    return res.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Full-text search over decompiled code (decompiles everything once). */
  grepCode(q: string, limit = 200) {
    const out: { va: number; func: string; text: string; fva: number }[] = [];
    const ql = q.toLowerCase();
    for (const f of this.an.funcs) {
      const r = this.decomp(f);
      for (const l of r.lines) if (l.text.toLowerCase().includes(ql)) { out.push({ va: l.va ?? f.va, func: f.fullName, text: l.text.trim(), fva: f.va }); if (out.length >= limit) return out; }
    }
    return out;
  }

  /** Callers found in decompiled code (covers calls through vtables / late binding). */
  deepCallers(va: number) {
    const f = this.an.funcByVA.get(va);
    if (!f) return [];
    const o = f.obj >= 0 ? this.project.objects[f.obj] : undefined;
    const esc = f.name.replace(/[$]/g, '\\$');
    const re = !o || o.kind === 'Module' ? new RegExp(`(^|[^\\w.])(${o ? o.name + '\\.' : ''})?${esc}\\b`) : new RegExp(`\\.${esc}\\b`);
    const out: { from: number; kind: string; name: string; text: string }[] = [];
    for (const g of this.an.funcs) {
      if (g.va === f.va) continue;
      for (const l of this.decomp(g).lines) if (re.test(l.text)) { out.push({ from: l.va ?? g.va, kind: 'code', name: g.fullName, text: l.text.trim() }); break; }
      if (out.length >= 300) break;
    }
    return out;
  }

  rename(va: number, name: string) {
    const f = this.an.funcByVA.get(va);
    if (f) {
      f.name = name;
      f.fullName = f.obj >= 0 ? `${this.project.objects[f.obj].name}.${name}` : name;
    } else if (this.an.globals.has(va)) this.an.globals.set(va, name);
    else this.an.labels.set(va, name);
    this.decompCache.clear();
    return true;
  }

  setComment(va: number, text: string) {
    if (text) this.comments.set(va, text); else this.comments.delete(va);
    return true;
  }

  loadTypeLib(bytes: Uint8Array) {
    const tl = loadTypeLibFromFile(bytes);
    const classes = registerTypeLib(tl);
    // re-resolve unknown control classes
    for (const o of this.project.objects) for (const c of o.controls) {
      const k = classes.find(k => k.eventsGuid === c.eventGuid);
      if (k) {
        c.className = k.name; c.libName = tl.name;
        for (const e of c.events) e.name = k.events[e.slot] ?? e.name;
        const f = this.an.funcByVA.get(c.events[0]?.targetVA ?? -1);
        void f;
      }
    }
    // rename event handlers whose names were generic
    for (const o of this.project.objects) for (const c of o.controls) for (const e of c.events) {
      const f = this.an.funcByVA.get(e.targetVA);
      if (f && f.kind === 'event' && f.ctl === c.name && /_Event\d+$/.test(f.name)) {
        f.name = `${c.name}_${e.name}`; f.event = e.name; f.fullName = `${o.name}.${f.name}`;
      }
    }
    this.decompCache.clear();
    return { name: tl.name, classes: classes.length, types: tl.types.length };
  }

  // --- export -----------------------------------------------------------------------------
  exportZip(progress?: ProgressFn): Uint8Array {
    const files: Record<string, Uint8Array> = {};
    const p = this.project;
    const vbp: string[] = ['Type=Exe'];
    const ext: Record<string, string> = { Form: 'frm', MDIForm: 'frm', Module: 'bas', Class: 'cls', UserControl: 'ctl', PropertyPage: 'pag', UserDocument: 'dob', Designer: 'dsr' };
    const used = new Set<string>();
    const total = p.objects.length;
    p.objects.forEach((o, k) => {
      progress?.(`Exporting ${o.name}`, k / total);
      const e = ext[o.kind] ?? 'txt';
      let fname = `${o.name}.${e}`;
      while (used.has(fname.toLowerCase())) fname = `_${fname}`;
      used.add(fname.toLowerCase());
      const src = this.objectSource(o.index);
      const body = src.lines.map(l => (l.kind === 'label' ? l.text : '    '.repeat(Math.max(0, l.indent)) + l.text)).join('\r\n');
      let text = '';
      if (o.kind === 'Form' || o.kind === 'MDIForm' || o.kind === 'UserControl') {
        const pf = this.forms.get(o.index);
        text = (pf?.frm ? pf.frm.replace(/Attribute VB_Name = .*\r\n/, '') : `VERSION 5.00\r\nBegin VB.Form ${o.name}\r\nEnd`) + '\r\n' + body.replace(/^Attribute VB_Name = .*\r\n/, `Attribute VB_Name = "${o.name}"\r\n`);
        vbp.push(o.kind === 'UserControl' ? `UserControl=${fname}` : `Form=${fname}`);
        // pictures
        if (pf) for (const c of pf.controls) c.pictures.forEach((pic, n) => {
          const extn = pic.mime.split('/')[1]?.replace('x-icon', 'ico').replace('jpeg', 'jpg') ?? 'bin';
          files[`resources/${o.name}/${c.name}${c.arrayIndex !== undefined ? '_' + c.arrayIndex : ''}_${pic.prop}${n ? n : ''}.${extn}`] = pic.bytes.slice();
        });
      } else if (o.kind === 'Class') {
        text = `VERSION 1.0 CLASS\r\nBEGIN\r\n  MultiUse = -1  'True\r\nEND\r\n` + body;
        vbp.push(`Class=${o.name}; ${fname}`);
      } else {
        text = body;
        vbp.push(`Module=${o.name}; ${fname}`);
      }
      files[fname] = strToU8(text);
    });
    for (const c of p.components) if (c.guid && c.file) vbp.push(`Object=${c.guid}#1.0#0; ${c.file}`);
    vbp.push(`Startup="${p.subMainVA ? 'Sub Main' : (p.objects.find(o => o.kind === 'Form' || o.kind === 'MDIForm')?.name ?? '')}"`);
    vbp.push(`ExeName32="${p.projectExeName}.exe"`, `Name="${p.projectName}"`);
    if (p.projectDescription) vbp.push(`Description="${p.projectDescription}"`);
    vbp.push(`CompilationType=${p.isPCode ? -1 : 0}`);
    files[`${p.projectName || 'Project1'}.vbp`] = strToU8(vbp.join('\r\n'));
    const decl = p.declares.filter(d => d.func).map(d => `Public Declare Function ${d.func} Lib "${d.lib}" ()`).join('\r\n');
    files['API_Declares.txt'] = strToU8(`' API declares found in the executable (signatures are not stored in the binary)\r\n${decl}`);
    files['README.txt'] = strToU8(`Decompiled with VBLens from ${this.name}\r\nThe output is a reconstruction for analysis purposes and will usually not recompile as-is.\r\n`);
    return zipSync(files, { level: 6 });
  }
}

function quickHash(b: Uint8Array): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(b.length / 65536));
  for (let i = 0; i < b.length; i += step) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  h ^= b.length;
  return (h >>> 0).toString(16).padStart(8, '0');
}

import { decode } from './x86/decoder';
function decodeAt(img: Image, va: number) { return decode(img.bytes, img.offsetOf(va), va); }

export type { VBObject };
