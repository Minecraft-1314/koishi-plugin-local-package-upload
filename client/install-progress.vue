<template>
  <el-dialog
    :model-value="state.visible"
    @update:model-value="onVisibleChange"
    append-to-body
    width="min(720px, calc(100vw - 24px))"
    :show-close="state.status !== 'running'"
    :close-on-click-modal="false"
    :close-on-press-escape="state.status !== 'running'"
    :title="state.title"
  >
    <div class="lp-status" :class="state.status">
      <span v-if="state.status === 'running'" class="lp-spinner" />
      <k-icon v-else-if="state.status === 'success'" name="check-full" />
      <k-icon v-else name="exclamation-full" />
      <div class="lp-status-text">
        <strong>{{ statusText }}</strong>
        <span v-if="state.detail">{{ state.detail }}</span>
      </div>
    </div>

    <div class="lp-terminal">
      <div class="lp-terminal-head">
        <span>安装日志</span>
        <span class="lp-count">{{ state.logs.length }} 条</span>
      </div>
      <div ref="viewport" class="lp-terminal-view">
        <div v-if="!state.logs.length" class="lp-empty">正在初始化…</div>
        <div v-for="(log, index) in state.logs" :key="index" class="lp-line" :class="log.type">
          <span class="lp-prefix">$</span>
          <span class="lp-text">{{ log.line }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button
        :type="state.status === 'error' ? 'danger' : 'primary'"
        :disabled="state.status === 'running'"
        @click="close"
      >
        {{ state.status === 'running' ? '安装中…' : '关闭' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { closeProgress, installProgress } from './progress'

const state = installProgress
const viewport = ref<HTMLElement>()

const statusText = computed(() => {
  if (state.status === 'running') return '正在安装，请勿关闭'
  if (state.status === 'success') return '安装完成'
  return '安装失败'
})

watch(() => state.logs.length, async () => {
  await nextTick()
  if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight
})

function onVisibleChange(value: boolean) {
  if (!value && state.status === 'running') return
  state.visible = value
}

function close() {
  closeProgress()
}
</script>

<style scoped>
.lp-status {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.75rem 0.9rem;
  border-radius: 8px;
  margin-bottom: 0.9rem;
  font-size: 0.875rem;
}

.lp-status.running {
  background: var(--k-color-primary-fade);
  color: var(--k-color-primary);
}

.lp-status.success {
  background: var(--k-color-success-fade);
  color: var(--k-color-success);
}

.lp-status.error {
  background: var(--k-color-danger-fade);
  color: var(--k-color-danger);
}

.lp-status-text {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.lp-status-text strong {
  font-weight: 600;
}

.lp-status-text span {
  opacity: 0.85;
  word-break: break-all;
}

.lp-spinner {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: lp-spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes lp-spin {
  to { transform: rotate(360deg); }
}

.lp-terminal {
  border: 1px solid var(--k-color-border);
  border-radius: 8px;
  overflow: hidden;
}

.lp-terminal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--k-activity-bg);
  color: var(--k-text-normal);
  font-size: 0.8125rem;
}

.lp-count {
  opacity: 0.65;
  font-size: 0.75rem;
}

.lp-terminal-view {
  max-height: 260px;
  overflow-y: auto;
  padding: 0.6rem 0.75rem;
  background: var(--k-card-bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  line-height: 1.7;
}

.lp-empty {
  color: var(--k-text-light);
  text-align: center;
  padding: 1rem 0;
}

.lp-line {
  display: flex;
  gap: 0.5rem;
  color: var(--k-text-dark);
  word-break: break-all;
}

.lp-line.stderr {
  color: var(--k-color-danger);
}

.lp-line.info {
  color: var(--k-text-normal);
}

.lp-prefix {
  opacity: 0.45;
  flex-shrink: 0;
}

@media (prefers-reduced-motion: reduce) {
  .lp-spinner { animation: none; }
}
</style>