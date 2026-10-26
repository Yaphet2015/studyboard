import { sessionClock } from "./sessions";

/** Profile timestamps spell out today; the sidebar keeps its compact clock. */
export function profileClock(iso: string, now = new Date()): string {
  const label = sessionClock(iso, now);
  return /^\d{2}:\d{2}$/.test(label) ? `今天 ${label}` : label;
}
