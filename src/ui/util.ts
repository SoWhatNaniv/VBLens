// Small browser helpers that must work from file:// and in restricted contexts.

/** Copy text to the clipboard; falls back to execCommand where the async API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.left = '-9999px';
    const prev = document.activeElement as HTMLElement | null;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    prev?.focus?.();
    return ok;
  } catch { return false; }
}

/** localStorage that never throws (disabled storage, quota, private mode). */
export const store = {
  get<T>(key: string, def: T): T {
    try { const v = localStorage.getItem(key); return v === null ? def : (JSON.parse(v) as T); } catch { return def; }
  },
  set(key: string, v: unknown) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
  },
};

export { vbIdentifierError } from '../core/vbident';
