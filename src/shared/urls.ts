const DRIVE_ID = /^[a-zA-Z0-9_-]{10,128}$/;

export function isDriveId(value: string): boolean {
  return DRIVE_ID.test(value);
}

export function isSafeHttpsUrl(value: string | null | undefined): boolean {
  if (!value || value.length > 500) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.hostname.length === 0) return false;
  return true;
}

export function isPublishedPostUrl(value: string | null | undefined): boolean {
  if (!isSafeHttpsUrl(value) || !value) return false;
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (host === "vm.tiktok.com") {
    return /^\/[A-Za-z0-9]+\/?$/.test(url.pathname);
  }
  if (host === "www.tiktok.com" || host === "tiktok.com") {
    return /^\/@[\w.-]+\/(video|photo)\/\d+\/?$/.test(url.pathname);
  }
  return false;
}

export function isAllowedWebhookUrl(value: string | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port !== "" && url.port !== "443") return false;
  if (url.hostname !== "api2.cursor.sh") return false;
  if (url.search !== "" || url.hash !== "") return false;
  return /^\/automations\/webhook\/[A-Za-z0-9_-]+$/.test(url.pathname);
}

export function safeDriveLink(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "drive.google.com" && url.hostname !== "docs.google.com") return null;
  return url.toString();
}

export function driveFileLink(fileId: string): string | null {
  if (!isDriveId(fileId)) return null;
  return `https://drive.google.com/file/d/${fileId}/view`;
}
