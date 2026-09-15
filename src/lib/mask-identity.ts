// Display-only; formats match the backend's pan_masked / aadhaar_masked (services/user.service.js).

export function maskAadhaar(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? `XXXX XXXX ${digits.slice(-4)}` : null;
}

export function maskPan(value: unknown): string | null {
  const chars = String(value ?? '').replace(/\s/g, '').toUpperCase();
  return chars ? `XXXXXX${chars.slice(-4)}` : null;
}
