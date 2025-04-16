export interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  md5Checksum?: string;
  owners?: { emailAddress: string }[];
}

export interface DriveFilesListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

export interface DrivePermission {
  id: string;
  role: string;
  pendingOwner?: boolean;
  emailAddress?: string;
}

export interface DrivePermissionsListResponse {
  permissions?: DrivePermission[];
  nextPageToken?: string;
}

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  hash?: string; // md5Checksum for non-Google Docs files
  modifiedTime: string; // RFC 3339 timestamp (e.g., '2025-04-16T12:34:56.789Z')
  owned?: boolean; // Whether the file is owned by the authenticated user
  permissions?: DrivePermission[]; // Access control details
}
