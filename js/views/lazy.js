// Screens that are opened from many places but rarely used load on first use. The service
// worker precaches them, so after the first visit this is instant and works offline.
import { showError } from '../ui/dom.js';

const lazy = (load, name) => (...args) => load()
  .then((m) => m[name](...args))
  .catch((e) => showError(e, `load ${name}`));

export const openCoach = lazy(() => import('./chat.js'), 'openCoach');
export const openScale = lazy(() => import('./weigh-in.js'), 'openScale');
export const openWeightSheet = lazy(() => import('./weigh-in.js'), 'openWeightSheet');
export const openBluetoothHelp = lazy(() => import('./weigh-in.js'), 'openBluetoothHelp');
export const openImport = lazy(() => import('./import.js'), 'openImport');
export const openCalendar = lazy(() => import('./calendar.js'), 'openCalendar');
export const openActivityLogger = lazy(() => import('./activity-log.js'), 'openActivityLogger');
export const openTargetsExplainer = lazy(() => import('./targets.js'), 'openTargetsExplainer');
