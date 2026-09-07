import type { TfsClient } from "../client.js";

export const IDENTITIES_API_VERSION = "6.0-preview.1";
export const CONNECTION_DATA_API_VERSION = "6.0-preview";

type TypedProps = Record<string, { $type?: string; $value?: unknown } | unknown>;

export interface RawIdentity {
  id: string;
  descriptor?: string;
  subjectDescriptor?: string;
  providerDisplayName?: string;
  customDisplayName?: string;
  isActive?: boolean;
  isContainer?: boolean;
  members?: string[];
  memberOf?: string[];
  properties?: TypedProps;
  resourceVersion?: number;
  metaTypeId?: number;
}

export interface RawConnectionData {
  authenticatedUser?: RawIdentity;
  authorizedUser?: RawIdentity;
  instanceId?: string;
  deploymentId?: string;
  deploymentType?: string;
  locationServiceData?: { serviceOwner?: string; defaultAccessMappingMoniker?: string };
}

export interface IdentityView {
  id: string;
  displayName: string | undefined;
  /** Account name as TFS knows it, e.g. DOMAIN\\user or user@domain.com */
  uniqueName: string | undefined;
  account: string | undefined;
  mail: string | undefined;
  domain: string | undefined;
  descriptor: string | undefined;
  subjectDescriptor: string | undefined;
  isActive: boolean | undefined;
  isGroup: boolean;
  /** Value ready to be passed as `assignedTo` to update_work_item(s). */
  assignedToValue: string | undefined;
}

export function prop(props: TypedProps | undefined, key: string): string | undefined {
  const v = props?.[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object" && "$value" in (v as object)) {
    const inner = (v as { $value?: unknown }).$value;
    return inner === undefined || inner === null ? undefined : String(inner);
  }
  return String(v);
}

/** Extract "DOMAIN\\user" / "user@domain" from a descriptor like "System.Security.Principal.WindowsIdentity;S-1-5-...\\DOMAIN\\user". */
export function accountFromDescriptor(descriptor: string | undefined): string | undefined {
  if (!descriptor) return undefined;
  const afterType = descriptor.includes(";") ? descriptor.slice(descriptor.indexOf(";") + 1) : descriptor;
  // Windows identity: "S-1-5-21-...\\DOMAIN\\user" -> keep last two segments
  const parts = afterType.split("\\");
  if (parts.length >= 3 && /^S-\d/.test(parts[0] ?? "")) return parts.slice(-2).join("\\");
  if (parts.length === 2 && /^S-\d/.test(parts[0] ?? "")) return parts[1];
  if (afterType.includes("@")) return afterType;
  return undefined;
}

export function toIdentityView(raw: RawIdentity): IdentityView {
  const displayName = raw.customDisplayName || raw.providerDisplayName;
  const account = prop(raw.properties, "Account");
  const mail = prop(raw.properties, "Mail");
  const domain = prop(raw.properties, "Domain");
  const schemaClass = prop(raw.properties, "SchemaClassName");
  const isGroup = raw.isContainer === true || schemaClass === "Group";
  let uniqueName: string | undefined = account;
  if (uniqueName && domain && !uniqueName.includes("\\") && !uniqueName.includes("@")) uniqueName = `${domain}\\${uniqueName}`;
  if (!uniqueName) uniqueName = accountFromDescriptor(raw.descriptor) ?? mail;

  const assignedToValue = isGroup
    ? undefined
    : displayName && uniqueName
      ? `${displayName} <${uniqueName}>`
      : uniqueName ?? displayName;

  return {
    id: raw.id,
    displayName,
    uniqueName,
    account,
    mail,
    domain,
    descriptor: raw.descriptor,
    subjectDescriptor: raw.subjectDescriptor,
    isActive: raw.isActive,
    isGroup,
    assignedToValue,
  };
}

export async function getConnectionData(client: TfsClient): Promise<RawConnectionData> {
  return client.get<RawConnectionData>({
    path: "connectionData",
    apiVersion: CONNECTION_DATA_API_VERSION,
    query: { connectOptions: "IncludeServices" },
  });
}

export async function readIdentities(client: TfsClient, ids: string[]): Promise<RawIdentity[]> {
  if (!ids.length) return [];
  const res = await client.get<{ count: number; value: RawIdentity[] }>({
    path: "identities",
    apiVersion: IDENTITIES_API_VERSION,
    query: { identityIds: ids.join(","), queryMembership: "None" },
  });
  return res.value ?? [];
}

export type IdentitySearchFilter = "General" | "AccountName" | "DisplayName" | "MailAddress" | "LocalGroupName";

export async function searchIdentities(client: TfsClient, query: string, filter: IdentitySearchFilter): Promise<RawIdentity[]> {
  const res = await client.get<{ count: number; value: RawIdentity[] }>({
    path: "identities",
    apiVersion: IDENTITIES_API_VERSION,
    query: { searchFilter: filter, filterValue: query, queryMembership: "None" },
  });
  return res.value ?? [];
}
