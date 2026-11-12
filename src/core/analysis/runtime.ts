// MSVBVM50/60 export names (ordinal imports are resolved through this table).
import table from '../data/msvbvm.json';

const T = table as unknown as Record<'5' | '6', Record<string, string>>;

export function runtimeOrdinalName(dll: string, ordinal: number): string | undefined {
  const v = /msvbvm50/i.test(dll) ? '5' : '6';
  return T[v][String(ordinal)];
}
