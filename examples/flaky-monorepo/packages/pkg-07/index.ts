/**
 * True when `at` falls inside the trailing window.
 *
 * Defect: the clock is not injectable, so every caller (and every test) races
 * the wall clock, and the default window is tight enough to lose that race.
 */
export function withinWindow(at: number, windowMs = 3): boolean {
  return Date.now() - at < windowMs;
}
