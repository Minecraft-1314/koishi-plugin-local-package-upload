export interface UploadStartRequest {
  filename: string
  size: number
}

export interface UploadStartResult {
  uploadId: string
  chunkSize: number
  maxSize: number
}

export interface UploadChunkRequest {
  uploadId: string
  index: number
  data: string
}

export interface UploadProgress {
  received: number
  size: number
}

export interface UploadFinishRequest {
  uploadId: string
}

export interface ArchiveManifest {
  name: string
  version: string
  description?: string
  scripts: Record<string, unknown>
  lifecycle: string[]
}

export interface ValidatedPackage {
  uploadId: string
  filename: string
  name: string
  version: string
  description?: string
  size: number
  hash: string
  scripts: string[]
}

export interface CommitResult {
  name: string
  version: string
  filename: string
  request: string
  size: number
  hash: string
}