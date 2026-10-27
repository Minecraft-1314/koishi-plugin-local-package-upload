import { createHash, randomUUID } from 'crypto'
import { FileHandle, open } from 'fs/promises'
import { promises as fsp, type Dirent } from 'fs'
import { dirname, resolve } from 'path'
import {
  assertInside,
  createBindingRequest,
  createHashedFilename,
  formatBytes,
  hashFile,
  inspectArchive,
  isValidPackFilename,
} from './archive'
import type {
  CommitResult,
  UploadChunkRequest,
  UploadFinishRequest,
  UploadProgress,
  UploadStartRequest,
  UploadStartResult,
  ValidatedPackage,
} from './types'

const DEFAULT_CHUNK_SIZE = 8 * 1024
const DEFAULT_MAX_SIZE = 64 * 1024 * 1024
const DEFAULT_TTL = 15 * 60 * 1000
const DEFAULT_DIRECTORY = '.yarn/local'
const DEFAULT_PREFIX = 'package'
const DEFAULT_MAX_SESSIONS = 8
const DEFAULT_MAX_CONCURRENT_CHUNKS = 4
const DEFAULT_SCAN_BUDGET = 30 * 1000
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface StoreOptions {
  baseDir: string
  chunkSize?: number
  maxSize?: number
  ttl?: number
  directory?: string
  prefix?: string
  maxSessions?: number
  maxConcurrentChunks?: number
  scanBudget?: number
  onWarn?: (message: string) => void
}

interface UploadSession {
  id: string
  originalFilename: string
  path: string
  size: number
  received: number
  nextIndex: number
  touchedAt: number
  handle?: FileHandle
  hash: ReturnType<typeof createHash>
  validated?: ValidatedPackage
  inflight: number
  pending: Promise<void>
}

export class LocalPackageUploadService {
  private readonly root: string
  private readonly temporaryRoot: string
  private readonly sessions = new Map<string, UploadSession>()
  private readonly chunkSize: number
  private readonly maxSize: number
  private readonly ttl: number
  private readonly directory: string
  private readonly prefix: string
  private readonly maxSessions: number
  private readonly maxConcurrentChunks: number
  private readonly scanBudget: number
  private readonly onWarn: (message: string) => void
  private disposed = false

  constructor(options: StoreOptions) {
    const baseDir = resolve(options?.baseDir || '.')
    this.directory = options?.directory || DEFAULT_DIRECTORY
    this.root = resolve(baseDir, this.directory)
    this.temporaryRoot = resolve(this.root, '.local-upload')
    this.chunkSize = this.normalizeChunkSize(options?.chunkSize)
    this.maxSize = this.normalizeMaxSize(options?.maxSize)
    this.ttl = this.normalizeTtl(options?.ttl)
    this.prefix = this.normalizePrefix(options?.prefix)
    this.maxSessions = this.normalizeBounded(options?.maxSessions, DEFAULT_MAX_SESSIONS, 1, 64)
    this.maxConcurrentChunks = this.normalizeBounded(options?.maxConcurrentChunks, DEFAULT_MAX_CONCURRENT_CHUNKS, 1, 32)
    this.scanBudget = this.normalizeBounded(options?.scanBudget, DEFAULT_SCAN_BUDGET, 1000, 600 * 1000)
    this.onWarn = typeof options?.onWarn === 'function' ? options.onWarn : () => {}
  }

  get chunkSizeValue() {
    return this.chunkSize
  }

  get maxSizeValue() {
    return this.maxSize
  }

  get directoryValue() {
    return this.directory
  }

  get sessionCount() {
    return this.sessions.size
  }

  private normalizeChunkSize(value: unknown) {
    const size = Number(value)
    if (!Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024) return DEFAULT_CHUNK_SIZE
    return size
  }

  private normalizeMaxSize(value: unknown) {
    const size = Number(value)
    if (!Number.isSafeInteger(size) || size <= 0) return DEFAULT_MAX_SIZE
    return size
  }

  private normalizeTtl(value: unknown) {
    const ttl = Number(value)
    if (!Number.isSafeInteger(ttl) || ttl <= 0) return DEFAULT_TTL
    return ttl
  }

  private normalizeBounded(value: unknown, fallback: number, min: number, max: number) {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < min || n > max) return fallback
    return n
  }

  private normalizePrefix(value: unknown) {
    if (typeof value !== 'string') return DEFAULT_PREFIX
    const trimmed = value.trim().replace(/\/+$/, '')
    if (!trimmed || trimmed.includes('..')) return DEFAULT_PREFIX
    if (!/^[\w.@ -]+$/.test(trimmed)) return DEFAULT_PREFIX
    return trimmed
  }

  async start(request: UploadStartRequest): Promise<UploadStartResult> {
    if (this.disposed) throw new Error('本地上传已停止。')
    await this.pruneExpired()
    await this.enforceSessionLimit()

    const filename = request?.filename
    if (!isValidPackFilename(filename)) throw new Error('请选择 npm pack 生成的 .tgz 文件。')

    const size = Number(request?.size)
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('本地插件归档大小无效。')
    if (size > this.maxSize) {
      throw new Error('本地插件归档超过大小上限 ' + formatBytes(this.maxSize) + '。')
    }

    const uploadId = randomUUID()
    const path = resolve(this.temporaryRoot, uploadId + '.part')
    assertInside(this.temporaryRoot, path)

    const session: UploadSession = {
      id: uploadId,
      originalFilename: filename,
      path,
      size,
      received: 0,
      nextIndex: 0,
      touchedAt: Date.now(),
      handle: undefined,
      hash: createHash('sha256'),
      inflight: 0,
      pending: Promise.resolve(),
    }
    this.sessions.set(uploadId, session)

    let handle: FileHandle
    try {
      await fsp.mkdir(this.temporaryRoot, { recursive: true })
      handle = await open(path, 'wx')
    } catch (error) {
      this.sessions.delete(uploadId)
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') throw new Error('本地插件上传临时文件冲突，请重试。')
      if (code === 'EACCES' || code === 'EPERM') throw new Error('本地上传目录没有写入权限。')
      if (code === 'ENOSPC') throw new Error('磁盘空间不足，无法开始上传。')
      throw new Error('无法创建本地上传临时文件：' + describe(error))
    }
    session.handle = handle

    return { uploadId, chunkSize: this.chunkSize, maxSize: this.maxSize }
  }

  async append(request: UploadChunkRequest): Promise<UploadProgress> {
    const session = this.getSession(request?.uploadId)
    return this.runSession(session, async () => {
      if (session.validated) throw new Error('本地插件归档已完成校验。')
      if (session.received >= session.size) throw new Error('本地插件归档已接收完毕。')
      if (!Number.isSafeInteger(request?.index) || request.index !== session.nextIndex) {
        throw new Error('本地插件上传分片顺序无效，请重新上传。')
      }

      const buffer = this.decodeChunk(request?.data)
      const remaining = session.size - session.received
      if (!buffer.length || buffer.length > this.chunkSize || buffer.length > remaining) {
        throw new Error('本地插件上传分片大小无效，请重新上传。')
      }

      const handle = session.handle
      if (!handle) throw new Error('本地插件上传会话已关闭。')

      const { bytesWritten } = await handle.write(buffer, 0, buffer.length, session.received)
      if (bytesWritten !== buffer.length) throw new Error('本地插件归档写入不完整，请重新上传。')

      session.hash.update(buffer)
      session.received += bytesWritten
      session.nextIndex++
      session.touchedAt = Date.now()
      return { received: session.received, size: session.size }
    }, true)
  }

  async finish(request: UploadFinishRequest): Promise<ValidatedPackage> {
    const session = this.getSession(request?.uploadId)
    return this.runSession(session, async () => {
      if (session.validated) return { ...session.validated }
      if (session.received !== session.size) {
        throw new Error(
          '本地插件归档尚未上传完成（' + formatBytes(session.received) + ' / ' + formatBytes(session.size) + '）。',
        )
      }
      await this.closeHandle(session)

      try {
        const hash = session.hash.digest('hex')
        const manifest = await inspectArchive(session.path, this.prefix, this.scanBudget)
        const targetFilename = createHashedFilename(session.originalFilename, hash)
        session.validated = {
          uploadId: session.id,
          filename: targetFilename,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          size: session.size,
          hash,
          scripts: manifest.lifecycle,
        }
        session.touchedAt = Date.now()
        return { ...session.validated }
      } catch (error) {
        await this.removeSession(session)
        throw error instanceof Error ? error : new Error('本地插件归档校验失败。')
      }
    })
  }

  async commit(uploadId: string): Promise<CommitResult> {
    const session = this.getSession(uploadId)
    return this.runSession(session, async () => {
      const validated = session.validated
      if (!validated) throw new Error('请先完成本地插件归档校验。')

      await this.closeHandle(session)
      await fsp.mkdir(this.root, { recursive: true })

      const target = resolve(this.root, validated.filename)
      assertInside(this.root, target)

      const existing = await hashFile(target)
      if (existing && existing !== validated.hash) {
        throw new Error('同名本地插件归档已存在，但文件内容不一致。')
      }

      if (existing) {
        await fsp.rm(session.path, { force: true })
      } else {
        try {
          await fsp.rename(session.path, target)
        } catch (error) {
          const concurrent = await hashFile(target)
          if (concurrent === validated.hash) {
            await fsp.rm(session.path, { force: true })
          } else if ((error as NodeJS.ErrnoException)?.code === 'EXDEV') {
            await fsp.copyFile(session.path, target)
            await fsp.rm(session.path, { force: true })
          } else {
            throw error
          }
        }
      }

      this.sessions.delete(session.id)
      return {
        name: validated.name,
        version: validated.version,
        filename: validated.filename,
        request: createBindingRequest(validated.filename, this.directory),
        size: validated.size,
        hash: validated.hash,
      }
    })
  }

  async cancel(uploadId: string) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID_PATTERN.test(uploadId)) return false
    const session = this.sessions.get(uploadId)
    if (!session) return false
    return this.runSession(session, async () => {
      await this.removeSession(session)
      return true
    }, false).catch((error) => {
      this.onWarn('failed to cancel upload ' + uploadId + ': ' + describe(error))
      return false
    })
  }

  async pruneExpired(now = Date.now()) {
    const expired = [...this.sessions.values()].filter((session) => now - session.touchedAt > this.ttl)
    await Promise.all(expired.map((session) => this.runSession(session, async () => {
      if (now - session.touchedAt > this.ttl) await this.removeSession(session)
    }, false).catch((error) => {
      this.onWarn('failed to clean expired upload ' + session.id + ': ' + describe(error))
    })))

    const activePaths = new Set([...this.sessions.values()].map((session) => session.path))
    const entries = await fsp.readdir(this.temporaryRoot, { withFileTypes: true }).catch(() => [] as Dirent[])
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.part')) return
      const path = resolve(this.temporaryRoot, entry.name)
      if (activePaths.has(path)) return
      const stat = await fsp.stat(path).catch(() => undefined)
      if (!stat || now - stat.mtimeMs <= this.ttl) return
      await fsp.rm(path, { force: true }).catch(() => {})
    }))
  }

  async dispose() {
    this.disposed = true
    await Promise.all([...this.sessions.values()].map((session) => this.runSession(session, () => this.removeSession(session), false).catch((error) => {
      this.onWarn('failed to dispose upload ' + session.id + ': ' + describe(error))
    })))
  }

  private async enforceSessionLimit() {
    if (this.sessions.size < this.maxSessions) return
    const oldest = [...this.sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt)
    for (const session of oldest) {
      if (this.sessions.size < this.maxSessions) break
      await this.runSession(session, () => this.removeSession(session), false).catch((error) => {
        this.onWarn('failed to evict upload ' + session.id + ': ' + describe(error))
      })
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error('同时进行的本地上传过多，请稍后重试。')
    }
  }

  private getSession(uploadId: string) {
    if (this.disposed) throw new Error('本地上传已停止。')
    if (typeof uploadId !== 'string' || !UPLOAD_ID_PATTERN.test(uploadId)) {
      throw new Error('本地插件上传会话无效。')
    }
    const session = this.sessions.get(uploadId)
    if (!session) throw new Error('本地插件上传已过期，请重新选择文件。')
    return session
  }

  private runSession<T>(session: UploadSession, action: () => Promise<T>, throttle = false): Promise<T> {
    if (throttle && session.inflight >= this.maxConcurrentChunks) {
      return Promise.reject(new Error('本地插件上传请求过于频繁，请稍后重试。'))
    }
    if (throttle) session.inflight++
    const result = session.pending.then(() => {
      if (this.sessions.get(session.id) !== session) throw new Error('本地插件上传已过期，请重新选择文件。')
      return action()
    })
    session.pending = result.then(() => {}, () => {})
    if (!throttle) return result
    return result.finally(() => {
      session.inflight = Math.max(0, session.inflight - 1)
    })
  }

  private async closeHandle(session: UploadSession) {
    const handle = session.handle
    session.handle = undefined
    await handle?.close().catch(() => {})
  }

  private async removeSession(session: UploadSession) {
    this.sessions.delete(session.id)
    await this.closeHandle(session)
    await fsp.rm(session.path, { force: true }).catch(() => {})
  }

  private decodeChunk(value: unknown) {
    const maxLength = Math.ceil(this.chunkSize / 3) * 4 + 4
    if (typeof value !== 'string' || !value || value.length > maxLength || value.length % 4) {
      throw new Error('本地插件上传分块编码无效。')
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('本地插件上传分块编码无效。')
    const buffer = Buffer.from(value, 'base64')
    if (buffer.length > this.chunkSize) throw new Error('本地插件上传分块大小无效。')
    if (buffer.toString('base64') !== value) throw new Error('本地插件上传分块编码无效。')
    return buffer
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MAX_SIZE,
  DEFAULT_TTL,
  DEFAULT_DIRECTORY,
  DEFAULT_PREFIX,
}