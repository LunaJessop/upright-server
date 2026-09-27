export const ESTIMATED_MINUTES_ERROR =
  "Estimated minutes must be a whole number of minutes.";

/**
 * Normalize a value for an INTEGER estimated_minutes column.
 * null, undefined, and blank strings are stored as null.
 * Anything else must be a non-negative whole number.
 * @param {unknown} value
 * @returns {{ ok: true, minutes: number | null } | { ok: false, error: string }}
 */
export function parseEstimatedMinutes(value) {
  if (value == null) return { ok: true, minutes: null };

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return { ok: true, minutes: null };
    value = trimmed;
  }

  if (typeof value !== "number" && typeof value !== "string") {
    return { ok: false, error: ESTIMATED_MINUTES_ERROR };
  }

  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0) {
    return { ok: false, error: ESTIMATED_MINUTES_ERROR };
  }

  return { ok: true, minutes };
}
