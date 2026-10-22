// Catálogo inglés (T2b-U2 R2). `satisfies` obliga a tener exactamente las
// mismas claves que `es`: falta o sobra una clave → error de compilación.
import type { Messages } from './es';

export const en = {
  settings: {
    title: 'Settings',
    nav: {
      providers: 'Providers',
      look: 'Appearance',
      alerts: 'Alerts',
      shortcuts: 'Shortcuts',
      updates: 'Updates',
    },
    pages: {
      providers: { title: 'Subscriptions & APIs', desc: 'What gets checked and how each provider connects.' },
      look: { title: 'Appearance', desc: 'Ring size and color, and where the strip sits.' },
      alerts: { title: 'Alerts', desc: 'What happens when a limit is exceeded and when it resets.' },
      shortcuts: { title: 'Shortcuts', desc: 'Keyboard shortcuts that work from any app.' },
      updates: { title: 'Updates', desc: 'Installed version, automatic updates and the project.' },
    },
    language: {
      title: 'Language',
      label: 'Language',
      hint: 'Applies right away in every window.',
      error: 'Could not save the language',
    },
  },
} satisfies Messages;
