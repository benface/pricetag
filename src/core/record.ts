/** A JSON object's fields, or null when it's anything else. Whatever came over the wire starts here. */
export const recordOf = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
