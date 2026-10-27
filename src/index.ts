import { Context, Schema, Time } from 'koishi'
import { LocalPackageUploadService, DEFAULT_CHUNK_SIZE, DEFAULT_MAX_SIZE, DEFAULT_TTL } from './store'
import { setupConsole } from './console'

export const name = 'local-package-upload'

export interface Config {
  enabled: boolean
  chunkSize: number
  maxSize: number
  ttl: number
  directory: string
  prefix: string
  maxSessions: number
  maxConcurrentChunks: number
  scanBudget: number
}

const CHUNK_OPTIONS: [number, string][] = [
  [8 * 1024, '8 KiB —— 默认，兼容性最好（单帧约 11 KB）'],
  [16 * 1024, '16 KiB（单帧约 22 KB）'],
  [32 * 1024, '32 KiB（单帧约 44 KB）'],
  [64 * 1024, '64 KiB（单帧约 87 KB）'],
  [128 * 1024, '128 KiB（单帧约 175 KB）'],
  [256 * 1024, '256 KiB（单帧约 350 KB）'],
  [512 * 1024, '512 KiB —— 单帧约 683 KB，受限链路会超时'],
]

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用本地上传。'),
  chunkSize: Schema.union(CHUNK_OPTIONS.map(([size, label]) => Schema.const(size).description(label)))
    .default(DEFAULT_CHUNK_SIZE)
    .description('上传分片大小。数值越小越能适应受限链路，但分片数量更多。'),
  maxSize: Schema.natural().min(1024).max(1024 * 1024 * 1024).default(DEFAULT_MAX_SIZE)
    .description('单个归档大小上限（字节），默认 64 MiB。'),
  ttl: Schema.natural().min(Time.second * 10).default(DEFAULT_TTL)
    .description('未完成上传的保留时间（毫秒），默认 15 分钟。'),
  directory: Schema.string().default('.yarn/local').description('归档落盘目录，相对应用根目录。'),
  prefix: Schema.string().default('package').description('归档内清单所在目录，npm pack 生成的是 package。'),
  maxSessions: Schema.natural().min(1).max(64).default(8).description('同时存在的上传会话上限。'),
  maxConcurrentChunks: Schema.natural().min(1).max(32).default(4).description('单个会话并发处理的分片上限。'),
  scanBudget: Schema.natural().min(Time.second).max(Time.minute * 10).default(Time.second * 30)
    .description('单个归档安全扫描的时间上限（毫秒）。'),
})

export const inject = {
  optional: ['console'],
}

const MAX_DIRECTORY_DEPTH = 32
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/
const WINDOWS_RESERVED = /[<>:"|?*]/

function normalizeChunkSize(value: unknown) {
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024) return DEFAULT_CHUNK_SIZE
  return size
}

function normalizeMaxSize(value: unknown) {
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size <= 0) return DEFAULT_MAX_SIZE
  return size
}

function normalizeTtl(value: unknown) {
  const ttl = Number(value)
  if (!Number.isSafeInteger(ttl) || ttl <= 0) return DEFAULT_TTL
  return ttl
}

function normalizeBounded(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback
  return n
}

function normalizeDirectory(value: unknown) {
  if (typeof value !== 'string') return '.yarn/local'
  const trimmed = value.trim().replace(/^[/\\]+|[/\\]+$/g, '')
  if (!trimmed || trimmed.includes('..')) return '.yarn/local'
  if (CONTROL_CHARACTERS.test(trimmed) || WINDOWS_RESERVED.test(trimmed)) return '.yarn/local'
  if (trimmed.split(/[/\\]/).length > MAX_DIRECTORY_DEPTH) return '.yarn/local'
  return trimmed
}

function normalizePrefix(value: unknown) {
  if (typeof value !== 'string') return 'package'
  const trimmed = value.trim().replace(/^[/\\]+|[/\\]+$/g, '')
  if (!trimmed || trimmed.includes('..')) return 'package'
  if (!/^[\w.@ -]+$/.test(trimmed)) return 'package'
  return trimmed
}

export function apply(ctx: Context, config: Config = {} as Config) {
  if (config?.enabled === false) return

  const logger = ctx.logger('local-package-upload')
  const service = new LocalPackageUploadService({
    baseDir: ctx.baseDir || process.cwd(),
    chunkSize: normalizeChunkSize(config?.chunkSize),
    maxSize: normalizeMaxSize(config?.maxSize),
    ttl: normalizeTtl(config?.ttl),
    directory: normalizeDirectory(config?.directory),
    prefix: normalizePrefix(config?.prefix),
    maxSessions: normalizeBounded(config?.maxSessions, 8, 1, 64),
    maxConcurrentChunks: normalizeBounded(config?.maxConcurrentChunks, 4, 1, 32),
    scanBudget: normalizeBounded(config?.scanBudget, Time.second * 30, Time.second, Time.minute * 10),
    onWarn: (message) => logger.warn(message),
  })

  ctx.setInterval(() => {
    service.pruneExpired().catch((error) => logger.warn(error))
  }, Time.minute * 5)

  ctx.on('dispose', () => {
    service.dispose().catch((error) => logger.warn(error))
  })

  const register = (consoleService: any) => {
    try {
      if (setupConsole(ctx, consoleService, service)) {
        logger.info('console page registered at /local-upload')
        return true
      }
    } catch (error) {
      logger.warn('failed to register console integration: ' + (error instanceof Error ? error.message : error))
    }
    return false
  }

  const current = ctx.get('console' as any)
  if (current && register(current)) return

  ctx.inject(['console'], (ctx) => {
    register(ctx.get('console' as any))
  })
}
