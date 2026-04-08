/** Encode any URL or text payload as a scannable QR (third-party image API; swap for self-hosted later). */
export function qrCodeImageUrl(payload: string, size = 200): string {
  const data = encodeURIComponent(payload);
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&ecc=M&data=${data}`;
}
