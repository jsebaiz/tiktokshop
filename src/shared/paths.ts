export const DESK_BASE = "/automatezynn3";
export const API_BASE = `${DESK_BASE}/api`;

export function deskPath(suffix = ""): string {
  if (!suffix) return DESK_BASE;
  return `${DESK_BASE}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

export function apiPath(suffix = ""): string {
  if (!suffix) return API_BASE;
  return `${API_BASE}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}
