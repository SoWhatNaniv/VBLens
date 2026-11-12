import type { Session } from '../core/session';
export type { TreeNode, CodeDoc, CodeLine, DisasmRow, GraphData, FormView, FormControlView } from '../core/session';
export type Overview = ReturnType<Session['overview']>;
export type FuncInfo = NonNullable<ReturnType<Session['funcInfo']>>;
export type SearchResult = ReturnType<Session['search']>[number];
export type Tok = import('../core/x86/format').Tok;

export type TabKind = 'proc' | 'object' | 'form' | 'overview' | 'strings' | 'imports' | 'declares' | 'components' | 'hex' | 'grep';
export type ProcView = 'code' | 'asm' | 'graph' | 'split';
export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  va?: number;
  obj?: number;
  view?: string;
  focus?: number; // address to reveal
  query?: string;
  cursor?: number;
  sel?: string; // selected control in the designer
  preview?: boolean;
  seq?: number; // bumps to re-trigger focus
}
