import { useEffect, useState } from 'react';
import { getName } from '@tauri-apps/api/app';

/** Display the installed product identity, not a user-switchable update channel. */
export function useAppName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getName().then(value => { if (alive) setName(value); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return name;
}

/** Unknown identity must not advertise a home folder that is not the stable one. */
export function ownedHomeDir(name: string | null): string {
  return name === 'Quorb' ? '.quorb' : '…';
}
