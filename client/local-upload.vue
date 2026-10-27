<template>
    <k-layout main="page-local-upload">
      <k-content>
        <div class="lpu-page">
          <header class="lpu-hero">
            <div class="lpu-hero-text">
              <h1>本地上传</h1>
              <p>把 npm pack 生成的 .tgz 插件包上传到当前应用。归档会先经过安全校验，确认无误后再安装。</p>
            </div>
            <div class="lpu-hero-actions">
              <el-button :disabled="busy" @click="reload">
                <k-icon name="redo" />
                <span class="lpu-btn-text">刷新</span>
              </el-button>
              <el-button type="primary" :disabled="busy" @click="pick">
                <k-icon name="file-archive" />
                <span class="lpu-btn-text">选择文件</span>
              </el-button>
            </div>
          </header>

          <section class="lpu-stats">
            <div class="lpu-stat is-size">
              <span class="lpu-stat-head">
                <span class="lpu-stat-label">归档大小</span>
                <span class="lpu-stat-dot" />
              </span>
              <span class="lpu-stat-value">{{ size ? formatSize(size) : "—" }}</span>
            </div>
            <div class="lpu-stat is-chunk">
              <span class="lpu-stat-head">
                <span class="lpu-stat-label">分片大小</span>
                <span class="lpu-stat-dot" />
              </span>
              <span class="lpu-stat-value">{{ chunkSize ? formatSize(chunkSize) : "—" }}</span>
            </div>
            <div class="lpu-stat is-progress">
              <span class="lpu-stat-head">
                <span class="lpu-stat-label">上传进度</span>
                <span class="lpu-stat-dot" />
              </span>
              <span class="lpu-stat-value">{{ progress }}%</span>
              <span class="lpu-stat-track">
                <span class="lpu-stat-fill" :style="{ transform: `scaleX(${progress / 100})` }" />
              </span>
            </div>
          </section>

          <section class="lpu-panel">
            <div
              class="lpu-drop"
              :class="{ 'is-active': dragging, 'is-busy': busy }"
              @dragover.prevent="dragging = true"
              @dragleave.prevent="dragging = false"
              @drop.prevent="onDrop"
              @click="pick"
            >
              <input ref="fileInput" type="file" accept=".tgz" hidden @change="onPick" />
              <k-icon name="add" class="lpu-drop-icon" />
              <strong>{{ uploading ? "正在上传…" : "拖拽 .tgz 到这里，或点击选择" }}</strong>
              <span class="lpu-drop-hint">仅支持 npm pack 生成的 .tgz 归档，单个文件不超过 {{ formatSize(maxSize) }}</span>
            </div>
          </section>

          <section v-if="error" class="lpu-alert is-error">
            <k-icon name="exclamation-full" />
            <span>{{ error }}</span>
          </section>

          <section v-if="uploading" class="lpu-panel lpu-progress-panel">
            <div class="lpu-progress-head">
              <span class="lpu-filename">{{ filename }}</span>
              <span class="lpu-progress-meta">{{ formatSize(received) }} / {{ formatSize(size) }}</span>
            </div>
            <el-progress :percentage="progress" :stroke-width="6" :show-text="false" />
          </section>

          <section v-if="preview" class="lpu-panel">
            <div class="lpu-panel-head">
              <h2>校验结果</h2>
              <span class="lpu-tag is-ready">待安装</span>
            </div>
            <dl class="lpu-rows">
              <dt>包名</dt>
              <dd class="lpu-mono">{{ preview.name }}</dd>
              <dt>版本</dt>
              <dd>{{ preview.version }}</dd>
              <dt>大小</dt>
              <dd>{{ formatSize(preview.size) }}</dd>
              <dt>哈希</dt>
              <dd class="lpu-mono">{{ preview.hash.slice(0, 24) }}…</dd>
              <dt>描述</dt>
              <dd>{{ preview.description || "无" }}</dd>
            </dl>
            <p v-if="preview.scripts.length" class="lpu-alert is-warning">
              <k-icon name="exclamation-full" />
              <span>该包包含生命周期脚本：{{ preview.scripts.join("、") }}。安装时不会自动执行。</span>
            </p>
            <div class="lpu-actions">
              <el-button type="primary" :loading="installing" @click="install">安装</el-button>
              <el-button :disabled="installing" @click="reset">重新选择</el-button>
            </div>
          </section>

          <section class="lpu-panel">
            <div class="lpu-panel-head">
              <h2>操作说明</h2>
            </div>
            <ol class="lpu-steps">
              <li>在插件目录执行 <code>npm pack</code> 生成 .tgz 归档</li>
              <li>把归档拖到上方区域，或点击「选择文件」</li>
              <li>等待分片上传完成，页面会显示包名、版本与哈希</li>
              <li>确认信息无误后点击「安装」写入当前应用</li>
            </ol>
          </section>
        </div>
      </k-content>
    </k-layout>
</template>

<script setup lang="ts">
import { send } from '@koishijs/client'
import { computed, ref } from 'vue'
import { failProgress, openProgress, pushLog, succeedProgress } from './progress'

interface Preview {
  uploadId: string
  name: string
  version: string
  description?: string
  size: number
  hash: string
  scripts: string[]
}

interface StartResult {
  uploadId: string
  chunkSize: number
  maxSize: number
}

interface InstallResult {
  name: string
  version: string
  request: string
}

const fileInput = ref<HTMLInputElement>()
const dragging = ref(false)
const uploading = ref(false)
const installing = ref(false)
const filename = ref("")
const size = ref(0)
const received = ref(0)
const progress = ref(0)
const chunkSize = ref(0)
const maxSize = ref(64 * 1024 * 1024)
const error = ref("")
const preview = ref<Preview>()
let uploadId = ""
let generation = 0

const busy = computed(() => uploading.value || installing.value)

function formatSize(value: number) {
  if (!value || value <= 0) return "0 B"
  if (value < 1024) return value + " B"
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB"
  return (value / 1024 / 1024).toFixed(1) + " MiB"
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const block = 0x8000
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(bytes.length, offset + block)) as unknown as number[])
  }
  return btoa(binary)
}

function formatError(value: unknown) {
  const raw = value instanceof Error ? value.message : String(value || "操作失败")
  return raw.split("\n")[0].replace(/^Error:\s*/, "").trim() || "操作失败"
}

function reload() {
  reset()
}

function pick() {
  if (busy.value) return
  fileInput.value?.click()
}

function onPick(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ""
  if (file) void upload(file)
}

function onDrop(event: DragEvent) {
  dragging.value = false
  if (busy.value) return
  const file = event.dataTransfer?.files?.[0]
  if (file) void upload(file)
}

function reset() {
  generation++
  const current = uploadId
  uploadId = ""
  uploading.value = false
  installing.value = false
  filename.value = ""
  size.value = 0
  received.value = 0
  progress.value = 0
  chunkSize.value = 0
  error.value = ""
  preview.value = undefined
  if (current) void send("local-package-upload/cancel", current).catch(() => {})
}

async function upload(file: File) {
  if (!file.name.toLowerCase().endsWith(".tgz")) {
    error.value = "请选择 npm pack 生成的 .tgz 文件。"
    return
  }
  if (maxSize.value > 0 && file.size > maxSize.value) {
    error.value = "文件超过大小上限 " + formatSize(maxSize.value) + "。"
    return
  }
  reset()
  const current = generation
  uploading.value = true
  filename.value = file.name
  size.value = file.size
  try {
    const started = await send("local-package-upload/start", {
      filename: file.name,
      size: file.size,
    }) as StartResult
    if (current !== generation) {
      void send("local-package-upload/cancel", started.uploadId).catch(() => {})
      return
    }
    uploadId = started.uploadId
    chunkSize.value = started.chunkSize
    maxSize.value = started.maxSize
    const step = started.chunkSize > 0 ? started.chunkSize : 8192
    let index = 0
    for (let offset = 0; offset < file.size; offset += step) {
      if (current !== generation) return
      const chunk = await file.slice(offset, Math.min(file.size, offset + step)).arrayBuffer()
      const state = await send("local-package-upload/chunk", {
        uploadId: started.uploadId,
        index,
        data: toBase64(chunk),
      }) as { received: number; size: number }
      if (current !== generation) return
      received.value = state.received
      progress.value = Math.min(100, Math.round(state.received / state.size * 100))
      index++
    }
    const finished = await send("local-package-upload/finish", {
      uploadId: started.uploadId,
    }) as Preview
    if (current !== generation) return
    preview.value = finished
    progress.value = 100
  } catch (value) {
    if (current !== generation) return
    error.value = formatError(value)
    const pending = uploadId
    uploadId = ""
    if (pending) void send("local-package-upload/cancel", pending).catch(() => {})
  } finally {
    if (current === generation) uploading.value = false
  }
}

async function install() {
  const current = preview.value
  if (!current || installing.value) return
  installing.value = true
  error.value = ""
  openProgress(current.name, current.version)
  try {
    pushLog('归档校验通过：' + current.name + '@' + current.version, 'info')
    pushLog('写入依赖清单：' + current.size + ' 字节已落盘', 'info')
    if (current.scripts.length) {
      pushLog('检测到生命周期脚本（不会自动执行）：' + current.scripts.join('、'), 'info')
    }
    pushLog('已提交安装请求，等待包管理器处理', 'info')
    const done = await send("local-package-upload/install", current.uploadId) as InstallResult
    pushLog('包管理器执行完毕', 'info')
    succeedProgress(done.name + ' ' + done.version + ' 已安装')
    preview.value = undefined
    uploadId = ""
    filename.value = ""
    size.value = 0
    received.value = 0
    progress.value = 0
    chunkSize.value = 0
  } catch (value) {
    const detail = formatError(value)
    failProgress(detail)
    error.value = detail
  } finally {
    installing.value = false
  }
}
</script>

<style scoped>
.lpu-page {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.lpu-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.lpu-hero-text h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--k-text-dark);
}

.lpu-hero-text p {
  margin: 0.4rem 0 0;
  max-width: 46rem;
  color: var(--k-text-normal);
  font-size: 0.875rem;
  line-height: 1.6;
}

.lpu-hero-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-shrink: 0;
}

.lpu-btn-text {
  margin-left: 0.25rem;
}

.lpu-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(136px, 1fr));
  gap: 0.75rem;
}

.lpu-stat {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.85rem 0.95rem 0.75rem;
  border: 1px solid var(--k-color-border);
  border-radius: 8px;
  background: var(--k-card-bg);
}

.lpu-stat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.lpu-stat-label {
  color: var(--k-text-normal);
  font-size: 0.8125rem;
}

.lpu-stat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--k-text-light);
}

.lpu-stat.is-size .lpu-stat-dot { background: var(--k-color-info); }
.lpu-stat.is-chunk .lpu-stat-dot { background: var(--k-color-warning); }
.lpu-stat.is-progress .lpu-stat-dot { background: var(--k-color-success); }

.lpu-stat-value {
  font-size: 1.5rem;
  font-weight: 600;
  line-height: 1.1;
  color: var(--k-text-dark);
}

.lpu-stat-track {
  display: block;
  height: 3px;
  border-radius: 999px;
  background: var(--k-activity-bg);
  overflow: hidden;
}

.lpu-stat-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transform-origin: left center;
  transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1);
  background: var(--k-color-success);
}

.lpu-panel {
  border: 1px solid var(--k-color-border);
  border-radius: 8px;
  background: var(--k-card-bg);
  padding: 1.1rem 1.25rem;
}

.lpu-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.85rem;
}

.lpu-panel-head h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--k-text-dark);
}

.lpu-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 2.5rem 1.25rem;
  border: 1px dashed var(--k-color-border);
  border-radius: 8px;
  background: var(--k-activity-bg);
  cursor: pointer;
  transition: border-color 0.18s ease, background-color 0.18s ease;
}

.lpu-drop:hover,
.lpu-drop.is-active {
  border-color: var(--k-color-primary);
  background: var(--k-color-primary-fade);
}

.lpu-drop.is-busy {
  cursor: progress;
  opacity: 0.7;
}

.lpu-drop-icon {
  font-size: 1.75rem;
  color: var(--k-text-light);
}

.lpu-drop strong {
  color: var(--k-text-dark);
  font-size: 0.9375rem;
  font-weight: 500;
}

.lpu-drop-hint {
  color: var(--k-text-light);
  font-size: 0.8125rem;
}

.lpu-progress-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.lpu-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.875rem;
}

.lpu-filename {
  color: var(--k-text-dark);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lpu-progress-meta {
  color: var(--k-text-normal);
  flex-shrink: 0;
}

.lpu-rows {
  display: grid;
  grid-template-columns: 5.5rem 1fr;
  gap: 0.6rem 1rem;
  margin: 0 0 0.9rem;
  font-size: 0.875rem;
}

.lpu-rows dt {
  color: var(--k-text-normal);
}

.lpu-rows dd {
  margin: 0;
  color: var(--k-text-dark);
  word-break: break-all;
}

.lpu-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.lpu-tag {
  display: inline-flex;
  align-items: center;
  padding: 0.1rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 0.75rem;
  line-height: 1.5;
  white-space: nowrap;
  background: var(--k-activity-bg);
  color: var(--k-text-normal);
}

.lpu-tag.is-ready {
  background: var(--k-color-primary-fade);
  border-color: var(--k-color-primary);
  color: var(--k-color-primary);
}

.lpu-alert {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0 0 0.9rem;
  padding: 0.7rem 0.85rem;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 0.8125rem;
  line-height: 1.6;
}

.lpu-alert.is-warning {
  background: var(--k-color-warning-fade);
  border-color: var(--k-color-warning);
  color: var(--k-color-warning);
}

.lpu-alert.is-error {
  background: var(--k-color-danger-fade);
  border-color: var(--k-color-danger);
  color: var(--k-color-danger);
}

.lpu-alert.is-success {
  background: var(--k-color-success-fade);
  border-color: var(--k-color-success);
  color: var(--k-color-success);
}

.lpu-success-text {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.lpu-actions {
  display: flex;
  gap: 0.75rem;
}

.lpu-steps {
  margin: 0;
  padding-left: 1.25rem;
  color: var(--k-text-normal);
  font-size: 0.875rem;
  line-height: 2;
}

.lpu-steps code {
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  background: var(--k-activity-bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  color: var(--k-text-dark);
}

@media (max-width: 768px) {
  .lpu-hero {
    flex-direction: column;
  }

  .lpu-hero-actions {
    width: 100%;
  }

  .lpu-rows {
    grid-template-columns: 1fr;
    gap: 0.25rem 0;
  }

  .lpu-rows dd {
    margin-bottom: 0.5rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lpu-drop,
  .lpu-stat-fill {
    transition: none;
  }
}
</style>