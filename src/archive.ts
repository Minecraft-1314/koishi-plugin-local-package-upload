import { basename, dirname, relative, resolve } from 'path'
import { promises as fsp } from 'fs'
import { createHash } from 'crypto'
import { list } from 'tar'
import type { ArchiveManifest } from './types'

const MAX_ARCHIVE_ENTRIES = 8192
const MAX_ARCHIVE_EXPANDED_SIZE = 256 * 1024 * 1024
const MAX_ARCHIVE_SINGLE_FILE_SIZE = 64 * 1024 * 1024
const MAX_MANIFEST_SIZE = 1024 * 1024
const MAX_PATH_SEGMENT_LENGTH = 128
const MAX_PATH_LENGTH = 512
const MAX_PATH_DEPTH = 32
const MAX_MANIFEST_KEYS = 512
const MAX_MANIFEST_DEPTH = 16
const MAX_DECOMPRESSION_RATIO = 1000
const MAX_NAME_LENGTH = 214
const MAX_SCRIPT_NAME_LENGTH = 64

const BLOCKED_ENTRY_TYPES = ['SymbolicLink', 'Link', 'CharacterDevice', 'BlockDevice', 'FIFO']
const ALLOWED_ENTRY_TYPES = ['File', 'Directory', 'OldFile', 'ContiguousFile', 'ExtendedFile', 'GNUDumpDir', 'pax-header', 'pax-global-header', 'PaxHeader', 'GlobalPaxHeader']

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const SCRIPT_NAME = /^[a-z][a-z0-9:_-]*$/i
const PLUGIN_PATTERN = /(^|\/)koishi-plugin-|^@[^/]+\/koishi-plugin-|^@koishijs\/plugin-/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/

function reject(message: string): never {
  throw new Error(message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isValidPluginName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!value || value.length > MAX_NAME_LENGTH) return false
  if (CONTROL_CHARACTERS.test(value)) return false
  if (value !== value.trim()) return false
  if (value.startsWith('.') || value.startsWith('_') || value.startsWith('-')) return false
  if (/\s/.test(value)) return false
  if (value.includes('..')) return false
  if (!PLUGIN_PATTERN.test(value)) return false
  const segments = value.split('/')
  if (segments.length > 3) return false
  if (segments[0].startsWith('@') && !/^@[a-z0-9][a-z0-9._-]*$/i.test(segments[0])) return false
  for (const segment of segments) {
    if (!segment) return false
    if (segment === '.' || segment === '..') return false
    if (segment.length > MAX_PATH_SEGMENT_LENGTH) return false
    if (CONTROL_CHARACTERS.test(segment)) return false
  }
  return true
}

function isValidVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length > 128) return false
  if (CONTROL_CHARACTERS.test(value)) return false
  return SEMVER_PATTERN.test(value)
}

export function isValidPackFilename(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!value) return false
  if (basename(value) !== value) return false
  if (value.length > MAX_NAME_LENGTH) return false
  if (CONTROL_CHARACTERS.test(value)) return false
  if (value.includes('..')) return false
  if (!/^[a-z0-9@._+-]+\.tgz$/i.test(value)) return false
  if (WINDOWS_RESERVED_NAME.test(value)) return false
  return true
}

function normalizeArchiveEntry(value: string, type: string) {
  if (typeof value !== 'string' || !value) reject('本地插件归档包含非法路径。')
  if (CONTROL_CHARACTERS.test(value)) reject('本地插件归档路径包含控制字符。')
  if (value.length > MAX_PATH_LENGTH) reject('本地插件归档路径过长。')
  const path = value.replace(/\\/g, '/')
  if (path.startsWith('/')) reject('本地插件归档包含绝对路径：' + value)
  if (/^[a-zA-Z]:/.test(path)) reject('本地插件归档包含盘符路径：' + value)
  const parts = path.split('/').filter(Boolean)
  if (!parts.length) reject('本地插件归档包含空路径。')
  if (parts.length > MAX_PATH_DEPTH) reject('本地插件归档路径层级过深。')
  for (const part of parts) {
    if (part === '.' || part === '..') reject('本地插件归档包含路径穿越片段：' + value)
    if (part.length > MAX_PATH_SEGMENT_LENGTH) reject('本地插件归档路径片段过长。')
    if (CONTROL_CHARACTERS.test(part)) reject('本地插件归档路径片段包含控制字符。')
  }
  if (BLOCKED_ENTRY_TYPES.includes(type)) reject('本地插件归档包含不允许的条目类型：' + type)
  if (!ALLOWED_ENTRY_TYPES.includes(type)) reject('本地插件归档包含未知条目类型：' + type)
  return { path }
}

function assertManifestShape(value: unknown) {
  let depth = 0
  const seen = new Set<unknown>()
  const walk = (node: unknown) => {
    if (depth > MAX_MANIFEST_DEPTH) reject('本地插件 package.json 嵌套层级过深。')
    if (node === null || typeof node !== 'object') return
    if (seen.has(node)) reject('本地插件 package.json 存在循环引用。')
    seen.add(node)
    depth++
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
    } else {
      const keys = Object.keys(node)
      if (keys.length > MAX_MANIFEST_KEYS) reject('本地插件 package.json 字段过多。')
      for (const key of keys) {
        if (key.length > MAX_NAME_LENGTH) reject('本地插件 package.json 字段名过长。')
        if (CONTROL_CHARACTERS.test(key)) reject('本地插件 package.json 字段名包含控制字符。')
        walk((node as Record<string, unknown>)[key])
      }
    }
    depth--
  }
  walk(value)
}

function assertSafeString(value: unknown, label: string, max = 4096) {
  if (value === undefined || value === null) return
  if (typeof value !== 'string') reject('本地插件 package.json 的 ' + label + ' 必须是字符串。')
  if (value.length > max) reject('本地插件 package.json 的 ' + label + ' 过长。')
  if (CONTROL_CHARACTERS.test(value.replace(/[\n\r\t]/g, ''))) reject('本地插件 package.json 的 ' + label + ' 包含控制字符。')
}

function validateScripts(scripts: unknown): string[] {
  if (scripts === undefined || scripts === null) return []
  if (!isPlainObject(scripts)) reject('本地插件 package.json 的 scripts 无效。')
  const keys = Object.keys(scripts)
  if (keys.length > 128) reject('本地插件 package.json 的 scripts 条目过多。')
  const lifecycle: string[] = []
  for (const key of keys) {
    if (key.length > MAX_SCRIPT_NAME_LENGTH) reject('本地插件 package.json 的脚本名过长。')
    if (!SCRIPT_NAME.test(key)) reject('本地插件 package.json 包含非法脚本名：' + key.slice(0, 32))
    assertSafeString(scripts[key], '脚本内容', 64 * 1024)
    if (['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack'].includes(key)) lifecycle.push(key)
  }
  return lifecycle
}

function validateDependencies(value: unknown) {
  if (value === undefined || value === null) return
  if (!isPlainObject(value)) reject('本地插件 package.json 的 dependencies 无效。')
  const keys = Object.keys(value)
  if (keys.length > 512) reject('本地插件 package.json 的依赖条目过多。')
  for (const key of keys) {
    if (key.length > MAX_NAME_LENGTH) reject('本地插件依赖名过长。')
    if (CONTROL_CHARACTERS.test(key)) reject('本地插件依赖名包含控制字符。')
    assertSafeString(value[key], '依赖版本范围', 1024)
  }
}

function validateBin(value: unknown) {
  if (value === undefined || value === null) return
  if (typeof value === 'string') {
    assertSafeString(value, 'bin', 1024)
    if (!value || value.includes('..') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) reject('本地插件 bin 路径非法。')
    return
  }
  if (!isPlainObject(value)) reject('本地插件 package.json 的 bin 无效。')
  const keys = Object.keys(value)
  if (keys.length > 64) reject('本地插件 package.json 的 bin 条目过多。')
  for (const key of keys) {
    if (key.length > MAX_PATH_SEGMENT_LENGTH) reject('本地插件 bin 名称过长。')
    if (CONTROL_CHARACTERS.test(key)) reject('本地插件 bin 名称包含控制字符。')
    assertSafeString(value[key], 'bin 路径', 1024)
    const target = value[key] as string
    if (!target || target.includes('..') || target.startsWith('/') || /^[a-zA-Z]:/.test(target)) reject('本地插件 bin 路径非法。')
  }
}

function inspectManifest(parsed: unknown): ArchiveManifest {
  assertManifestShape(parsed)
  if (!isPlainObject(parsed)) reject('本地插件 package.json 无效。')

  const raw = parsed
  if (!isValidPluginName(raw.name)) reject('归档中的包名不是有效的 Koishi 插件名称。')
  if (!isValidVersion(raw.version)) reject('归档中的插件版本不是有效的 SemVer。')

  assertSafeString(raw.description, 'description', 2048)
  assertSafeString(raw.license, 'license', 128)
  assertSafeString(raw.author, 'author')
  assertSafeString(raw.homepage, 'homepage', 2048)
  assertSafeString(raw.main, 'main', 1024)
  assertSafeString(raw.module, 'module', 1024)

  if (raw.bin !== undefined) validateBin(raw.bin)
  if (raw.engines !== undefined && !isPlainObject(raw.engines)) reject('本地插件 package.json 的 engines 无效。')
  if (raw.engines !== undefined && isPlainObject(raw.engines)) {
    const engines = raw.engines as Record<string, unknown>
    for (const key of Object.keys(engines)) {
      assertSafeString(engines[key], 'engines 约束', 256)
    }
  }

  validateDependencies(raw.dependencies)
  validateDependencies(raw.devDependencies)
  validateDependencies(raw.peerDependencies)
  validateDependencies(raw.optionalDependencies)

  const scripts = raw.scripts === undefined || raw.scripts === null ? {} : raw.scripts
  const lifecycle = validateScripts(scripts)

  return {
    name: raw.name as string,
    version: raw.version as string,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    scripts: isPlainObject(scripts) ? scripts : {},
    lifecycle,
  }
}

export async function inspectArchive(path: string, prefix: string, budget: number): Promise<ArchiveManifest> {
  const manifestPath = prefix.replace(/\/+$/, '') + '/package.json'
  const deadline = Date.now() + Math.max(1000, budget)
  let entryCount = 0
  let expandedSize = 0
  let manifestFound = false
  let failure: Error | undefined
  const chunks: Buffer[] = []

  const fail = (message: string) => {
    if (!failure) failure = new Error(message)
  }

  try {
    await list({
      file: path,
      strict: true,
      maxReadSize: MAX_MANIFEST_SIZE,
      maxMetaEntrySize: MAX_MANIFEST_SIZE,
      maxDecompressionRatio: MAX_DECOMPRESSION_RATIO,
      onReadEntry(entry) {
        if (failure) return
        entryCount++
        if (entryCount > MAX_ARCHIVE_ENTRIES) {
          fail('本地插件归档条目数量超过上限 ' + MAX_ARCHIVE_ENTRIES + '。')
          return
        }
        if (Date.now() > deadline) {
          fail('本地插件归档安全扫描超时。')
          return
        }
        const size = Number(entry.size)
        if (Number.isSafeInteger(size) && size >= 0) {
          expandedSize += size
          if (expandedSize > MAX_ARCHIVE_EXPANDED_SIZE) {
            fail('本地插件归档解压后总大小超过上限 ' + Math.ceil(MAX_ARCHIVE_EXPANDED_SIZE / 1024 / 1024) + ' MiB。')
            return
          }
          if (size > MAX_ARCHIVE_SINGLE_FILE_SIZE) {
            fail('本地插件归档包含过大的单个文件。')
            return
          }
        }
        let normalized: { path: string }
        try {
          normalized = normalizeArchiveEntry(entry.path, entry.type)
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error))
          return
        }
        if (normalized.path !== manifestPath) return
        if (manifestFound) {
          fail('本地插件归档包含重复的 package.json。')
          return
        }
        if (!(size > 0) || size > MAX_MANIFEST_SIZE) {
          fail('本地插件 package.json 大小无效。')
          return
        }
        manifestFound = true
        entry.on('data', (chunk) => {
          if (failure) return
          chunks.push(Buffer.from(chunk))
        })
      },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/decompression ratio/i.test(detail)) throw new Error('本地插件归档压缩比异常，疑似压缩炸弹。')
    if (/unexpected end of (file|data)/i.test(detail)) throw new Error('本地插件归档数据不完整或已损坏。')
    if (/invalid tar/i.test(detail)) throw new Error('本地插件归档不是有效的 tar 格式。')
    throw new Error('无法读取本地插件归档：' + detail)
  }

  if (failure) throw failure

  if (!manifestFound) {
    throw new Error('本地插件归档中缺少 ' + manifestPath + '。请使用 npm pack 生成 .tgz。')
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  if (total > MAX_MANIFEST_SIZE) throw new Error('本地插件 package.json 超过大小上限。')

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('本地插件 package.json 不是有效的 JSON。')
  }

  return inspectManifest(parsed)
}

export function createHashedFilename(filename: string, hash: string) {
  if (!isValidPackFilename(filename)) throw new Error('本地插件文件名无效。')
  if (!/^[a-f0-9]{12,64}$/i.test(hash)) throw new Error('本地插件哈希无效。')
  const slug = filename
    .slice(0, -4)
    .replace(/^@/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9@._+-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  if (!slug) throw new Error('本地插件文件名规范化后为空。')
  return slug + '-' + hash.slice(0, 12).toLowerCase() + '.tgz'
}

export function createBindingRequest(filename: string, directory = '.yarn/local') {
  if (!isValidPackFilename(filename)) throw new Error('本地插件文件名无效。')
  const safeDirectory = typeof directory === 'string' && directory && !directory.includes('..')
    ? directory.replace(/[/\\]+$/, '')
    : '.yarn/local'
  return 'file:' + safeDirectory + '/' + filename
}

export async function hashFile(path: string) {
  try {
    const stat = await fsp.stat(path)
    if (!stat.isFile()) return undefined
    if (stat.size > MAX_ARCHIVE_SINGLE_FILE_SIZE) return undefined
    return createHash('sha256').update(await fsp.readFile(path)).digest('hex')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'EPERM' || code === 'EACCES') return undefined
    throw error
  }
}

export function assertInside(root: string, target: string) {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  if (dirname(normalizedTarget) !== normalizedRoot) throw new Error('本地插件目标路径越界。')
  const rel = relative(normalizedRoot, normalizedTarget)
  if (!rel || rel.includes('..')) throw new Error('本地插件目标路径越界。')
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return Math.ceil(value / 1024) + ' KiB'
  return Math.ceil(value / 1024 / 1024) + ' MiB'
}

