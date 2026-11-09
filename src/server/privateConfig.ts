import type { AgentSlug } from "../shared/catalog";
import type { Env } from "./env";
import { isDriveId } from "../shared/urls";

export const TRACKER_SHEET_ID = "1IcxeyGUA6Hg-FWu5Ux_R2EZy4M1aVN7AHep8EhxOy0U";

export const AGENT_IDS: Record<AgentSlug, string> = {
  bling: "0314d30a-41ba-49ad-b164-6cfa42fe0b5f",
  cling: "0ce484ce-4233-41d5-b7a4-ff45bc986423",
  fling: "3a010ad4-fe0f-40a2-b53c-d586151c59f0",
  pling: "791315b7-2cab-42d5-aa4d-e2f918636447",
  sling: "aaf3776f-342f-46f5-bdc5-a60b6acaab37",
  slack: "f2ea00b8-03fc-4f41-9c80-e95ba6e5692a",
};

export interface FolderTarget {
  key: string;
  label: string;
  group: "brand" | "slack";
  id: string;
}

const BRAND_FOLDERS: FolderTarget[] = [
  {
    key: "brands",
    label: "Brands",
    group: "brand",
    id: "1GBC2osWqB3gFY1w7raqYfOo1joOnBsmH",
  },
  {
    key: "ready-to-post",
    label: "Ready to Post (brand)",
    group: "brand",
    id: "1QNagh1F0zewpplTgd-BikS4WrIoRqVft",
  },
];

export function configuredFolders(env: Env): FolderTarget[] {
  const slack: Array<{ key: string; label: string; id: string | undefined }> = [
    { key: "postr", label: "Postr (Normal)", id: env.SLACK_FOLDER_POSTR },
    { key: "slack-ready", label: "Ready to Post (Slack)", id: env.SLACK_FOLDER_READY },
    { key: "posted", label: "Posted", id: env.SLACK_FOLDER_POSTED },
  ];
  const extras: FolderTarget[] = [];
  for (const folder of slack) {
    if (folder.id && isDriveId(folder.id)) {
      extras.push({ key: folder.key, label: folder.label, group: "slack", id: folder.id });
    }
  }
  return [...BRAND_FOLDERS, ...extras];
}

export function folderByKey(env: Env, key: string): FolderTarget | undefined {
  return configuredFolders(env).find((folder) => folder.key === key);
}

export function folderById(env: Env, id: string): FolderTarget | undefined {
  return configuredFolders(env).find((folder) => folder.id === id);
}

export function publicFolders(env: Env): Array<{ key: string; label: string; group: "brand" | "slack"; configured: boolean }> {
  const configured = new Set(configuredFolders(env).map((folder) => folder.key));
  return [
    { key: "brands", label: "Brands", group: "brand", configured: true },
    { key: "ready-to-post", label: "Ready to Post (brand)", group: "brand", configured: true },
    { key: "postr", label: "Postr (Normal)", group: "slack", configured: configured.has("postr") },
    { key: "slack-ready", label: "Ready to Post (Slack)", group: "slack", configured: configured.has("slack-ready") },
    { key: "posted", label: "Posted", group: "slack", configured: configured.has("posted") },
  ];
}
