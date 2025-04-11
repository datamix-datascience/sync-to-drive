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
  mimeType?: string;
  hash?: string; // md5Checksum
  owned: boolean;
  permissions: DrivePermission[];
}
