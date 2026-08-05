import "server-only";

export class ValidationError extends Error {}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ValidationError("Content-Type must be application/json");
  }

  const text = await request.text();
  if (text.length > maxBytes) {
    throw new ValidationError("Request body too large");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Malformed JSON");
  }
}

export function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertKnownKeys(obj: Record<string, unknown>, allowedKeys: string[], label: string) {
  const unknown = Object.keys(obj).filter((k) => !allowedKeys.includes(k));
  if (unknown.length > 0) {
    throw new ValidationError(`${label} has unexpected field(s): ${unknown.join(", ")}`);
  }
}

export function assertRequiredString(value: unknown, field: string, maxLength = 150): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} is required and must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`${field} exceeds max length of ${maxLength}`);
  }
  return value;
}

export function assertFiniteNumber(
  value: unknown,
  field: string,
  { min = -100_000, max = 100_000 }: { min?: number; max?: number } = {}
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new ValidationError(`${field} out of range`);
  }
  return value;
}

// Loosely-typed scalar field used for pass-through provider data (ESPN/Cito
// values reach this API already-shaped, and the exact type — string vs.
// number — has drifted historically depending on the upstream provider).
// Still rejects the shapes that matter for abuse: objects, arrays, and
// oversized strings.
export function assertLooseScalar(value: unknown, field: string, maxLength = 300): void {
  if (value === undefined || value === null) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`${field} must be a finite number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > maxLength) throw new ValidationError(`${field} exceeds max length of ${maxLength}`);
    return;
  }
  throw new ValidationError(`${field} must be a string or number`);
}

// Shared honeypot check for public-facing forms (feedback, notify-signup):
// a field real users never see or fill (kept off-screen via .form-honeypot
// in globals.css) but simple bots fill indiscriminately. Deliberately
// indistinguishable from success on the caller's end — the route should
// still return its normal 200 rather than a 400, so a bot never learns
// which signal tripped it.
export class SpamDetected extends Error {}

export function assertHoneypotEmpty(value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    throw new SpamDetected("honeypot field was filled");
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Provider call timed out")), ms)),
  ]);
}
