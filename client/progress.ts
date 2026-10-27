import { reactive } from 'vue'

export interface InstallLog {
  type: 'stdout' | 'stderr' | 'info'
  line: string
}

export type InstallStatus = 'running' | 'success' | 'error'

export interface InstallProgressState {
  visible: boolean
  title: string
  status: InstallStatus
  logs: InstallLog[]
  packageName: string
  packageVersion: string
  detail: string
}

export const installProgress = reactive<InstallProgressState>({
  visible: false,
  title: '正在安装本地插件',
  status: 'running',
  logs: [],
  packageName: '',
  packageVersion: '',
  detail: '',
})

export function pushLog(line: string, type: InstallLog['type'] = 'stdout') {
  const text = String(line ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (!text) return
  if (installProgress.logs.length >= 500) installProgress.logs.shift()
  installProgress.logs.push({ type, line: text })
}

export function openProgress(name: string, version: string) {
  installProgress.visible = true
  installProgress.status = 'running'
  installProgress.title = '正在安装 ' + name
  installProgress.packageName = name
  installProgress.packageVersion = version
  installProgress.detail = ''
  installProgress.logs = []
  pushLog('正在校验归档完整性', 'info')
}

export function succeedProgress(detail: string) {
  installProgress.status = 'success'
  installProgress.detail = detail
  pushLog(detail, 'info')
}

export function failProgress(detail: string) {
  installProgress.status = 'error'
  installProgress.detail = detail
  pushLog(detail, 'stderr')
}

export function closeProgress() {
  if (installProgress.status === 'running') return false
  installProgress.visible = false
  return true
}
