import { resolve } from 'path'
import type { Context } from 'koishi'
import type { Client } from '@koishijs/console'
import type { LocalPackageUploadService } from './store'

export interface InstallResult {
  name: string
  version: string
  request: string
}

declare module '@koishijs/console' {
  interface Events {
    'local-package-upload/start'(this: Client, request: { filename: string; size: number }): Promise<{
      uploadId: string
      chunkSize: number
      maxSize: number
    }>
    'local-package-upload/chunk'(this: Client, request: {
      uploadId: string
      index: number
      data: string
    }): Promise<{ received: number; size: number }>
    'local-package-upload/finish'(this: Client, request: { uploadId: string }): Promise<{
      uploadId: string
      filename: string
      name: string
      version: string
      description?: string
      size: number
      hash: string
      scripts: string[]
    }>
    'local-package-upload/commit'(this: Client, uploadId: string): Promise<{
      name: string
      version: string
      filename: string
      request: string
      size: number
      hash: string
    }>
    'local-package-upload/cancel'(this: Client, uploadId: string): Promise<boolean>
    'local-package-upload/install'(this: Client, uploadId: string): Promise<InstallResult>
  }
}

export function setupConsole(ctx: Context, consoleService: any, store: LocalPackageUploadService) {
  if (!consoleService || typeof consoleService.addEntry !== 'function') return false
  if (typeof consoleService.addListener !== 'function') return false
  if (!store || typeof store.start !== 'function') return false

  consoleService.addEntry({
    dev: resolve(__dirname, '../client/index.ts'),
    prod: resolve(__dirname, '../dist'),
  })

  const add = (event: string, callback: (...args: any[]) => any) => {
    consoleService.addListener('local-package-upload/' + event, callback, { authority: 4 })
  }

  add('start', (request) => store.start(request))
  add('chunk', (request) => store.append(request))
  add('finish', (request) => store.finish(request))
  add('commit', (uploadId) => store.commit(uploadId))
  add('cancel', (uploadId) => store.cancel(uploadId))
  add('install', async (uploadId: string): Promise<InstallResult> => {
    const committed = await store.commit(uploadId)
    const installer: any = ctx.get('installer' as any)
    if (!installer || typeof installer.install !== 'function') {
      throw new Error('未找到 installer 服务，无法自动安装。请手动添加依赖：' + committed.request)
    }
    await installer.install({ [committed.name]: committed.request })
    return { name: committed.name, version: committed.version, request: committed.request }
  })

  return true
}
