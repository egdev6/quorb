export function disclosureOpen(provider: string, section: 'pace' | 'history'): boolean {
  try {
    const stored = localStorage.getItem(`popup:${provider}:${section}`);
    if (stored === 'true' || stored === 'false') return stored === 'true';
  } catch { /* Storage may be unavailable. */ }
  return section === 'pace';
}

export function saveDisclosure(provider: string, section: 'pace' | 'history', open: boolean): void {
  try { localStorage.setItem(`popup:${provider}:${section}`, String(open)); }
  catch { /* Keep native disclosures usable without storage. */ }
}
