<template>
  <aside
    v-if="ai.visible"
    ref="panelElement"
    class="ai-panel"
    :style="{ width: `${ai.width}px` }"
    :aria-busy="ai.loading"
  >
    <div
      class="ai-resize-handle"
      @pointerdown="startResize"
    />
    <header class="ai-header">
      <div>
        <strong>{{ labels.title }}</strong>
        <span class="ai-subtitle">{{ modeLabel }}</span>
      </div>
      <div class="ai-header-actions">
        <button
          class="icon-button"
          :title="labels.settings"
          @click="openSettings"
        >
          ⚙
        </button>
      </div>
    </header>

    <div
      class="ai-mode-switch"
      role="tablist"
    >
      <button
        :class="{ active: ai.mode === 'answer' }"
        @click="ai.setMode('answer')"
      >
        {{ labels.answer }}
      </button>
      <button
        :class="{ active: ai.mode === 'edit' }"
        @click="ai.setMode('edit')"
      >
        {{ labels.edit }}
      </button>
      <button
        :class="{ active: ai.mode === 'rewrite' }"
        @click="ai.setMode('rewrite')"
      >
        {{ labels.rewrite }}
      </button>
    </div>

    <div class="ai-model-select">
      <label for="ai-model-selector">{{ labels.model }}</label>
      <select
        id="ai-model-selector"
        :value="ai.selectedModelKey"
        :disabled="!ai.modelOptions.length"
        @change="selectModel"
      >
        <option
          v-if="!ai.modelOptions.length"
          value=""
        >
          {{ labels.noModels }}
        </option>
        <optgroup
          v-for="group in modelGroups"
          :key="group.connectionId"
          :label="group.connectionName"
        >
          <option
            v-for="option in group.models"
            :key="option.modelId"
            :value="modelOptionValue(option.ref)"
          >
            {{ option.label }}{{ option.label === option.model ? '' : ` (${option.model})` }}
          </option>
        </optgroup>
      </select>
      <small>{{ labels.modelHint }}</small>
    </div>

    <p class="ai-mode-help">
      {{ modeHelp }}
    </p>

    <div
      ref="messagesElement"
      class="ai-messages"
      @scroll="handleMessagesScroll"
    >
      <div
        v-if="!ai.messages.length"
        class="ai-empty"
      >
        {{ labels.empty }}
      </div>
      <article
        v-for="message in ai.messages"
        :key="message.id"
        class="ai-message"
        :class="[message.role, { 'ai-status-message': message.kind === 'status' }]"
      >
        <div
          v-if="message.kind === 'status' && message.progress?.phase === 'agent-plan'"
          class="ai-plan-card"
          role="status"
        >
          <div class="ai-plan-title">
            {{ labels.editPlan }}
          </div>
          <div class="ai-plan-summary">
            {{ message.progress.planSummary }}
          </div>
          <div class="ai-plan-count">
            {{ labels.planSteps(message.progress.planStepCount ?? 0) }}
          </div>
          <ol>
            <li
              v-for="(description, index) in message.progress.planStepDescriptions || []"
              :key="`${index}-${description}`"
            >
              {{ description }}
            </li>
          </ol>
        </div>
        <div
          v-else-if="message.kind === 'status' && message.progress?.phase === 'agent-step' && hasStepDiff(message.progress)"
          class="ai-step-diff"
          role="status"
        >
          <div class="ai-step-diff-title">
            {{ progressLabel(message) }}
          </div>
          <div class="ai-step-diff-row removed">
            <span class="ai-step-diff-label">{{ labels.stepDeleted }}</span>
            <pre>{{ message.progress.stepRemovedText || labels.emptyDiff }}</pre>
          </div>
          <div class="ai-step-diff-row added">
            <span class="ai-step-diff-label">{{ labels.stepAdded }}</span>
            <pre>{{ message.progress.stepAddedText || labels.emptyDiff }}</pre>
          </div>
        </div>
        <div
          v-else-if="message.kind === 'status'"
          class="ai-status-content"
          role="status"
        >
          <span
            class="ai-status-dot"
            aria-hidden="true"
          />
          {{ progressLabel(message) }}
        </div>
        <details
          v-if="message.kind === 'status' && message.progress?.failureOutput"
          class="ai-failure-output"
        >
          <summary>{{ labels.failureOutputTitle }}</summary>
          <pre>{{ message.progress.failureOutput }}</pre>
          <small v-if="message.progress.failureOutputTruncated">{{ labels.failureOutputTruncated }}</small>
          <button
            class="secondary-button ai-copy-failure"
            type="button"
            @click="copyFailureOutput(message)"
          >
            {{ copiedFailureId === message.id ? labels.copied : labels.copyFailureOutput }}
          </button>
        </details>
        <template v-else-if="message.kind !== 'status'">
          <div class="ai-message-role">
            {{ message.role === 'user' ? labels.you : labels.ai }}
          </div>
          <div
            v-if="message.model"
            class="ai-message-model"
          >
            {{ message.model.connectionName }} / {{ message.model.model }}
          </div>
          <div
            v-if="message.content"
            class="ai-message-content"
          >
            {{ message.content }}
          </div>
          <details
            v-if="message.reasoning"
            class="ai-message-reasoning"
          >
            <summary>{{ labels.modelReasoning }}</summary>
            <div>{{ message.reasoning }}</div>
          </details>
          <div
            v-if="message.attachments?.length"
            class="ai-message-attachments"
          >
            <div
              v-for="attachment in message.attachments"
              :key="attachment.id"
              class="ai-attachment-chip"
              :title="attachment.name"
            >
              <span
                v-if="attachment.mimeType === 'application/pdf'"
                class="ai-attachment-icon ai-pdf-icon"
                aria-hidden="true"
              >
                PDF
              </span>
              <span
                v-else
                class="ai-attachment-icon"
                aria-hidden="true"
              >
                <svg
                  viewBox="0 0 16 16"
                  focusable="false"
                >
                  <rect
                    x="1.5"
                    y="2"
                    width="13"
                    height="12"
                    rx="1.5"
                  />
                  <circle
                    cx="5"
                    cy="5.5"
                    r="1.25"
                  />
                  <path d="m3 12 3.2-3.2 2.3 2.1 1.6-1.6L13 12" />
                </svg>
              </span>
              <span class="ai-attachment-name">{{ attachment.name }}</span>
              <span
                v-if="attachment.mimeType === 'application/pdf' && attachment.pages?.length"
                class="ai-attachment-pages"
              >
                {{ formatPages(attachment.pages) }}
              </span>
            </div>
          </div>
          <div
            v-if="message.editSummary || message.mode === 'rewrite'"
            class="ai-edit-summary"
          >
            {{ editSummaryLabel(message) }}
          </div>
        </template>
      </article>
    </div>

    <div
      v-if="ai.error"
      class="ai-error"
    >
      {{ ai.error }}
    </div>

    <div
      v-if="ai.pendingRecovery"
      class="ai-recovery"
    >
      <p>{{ labels.recoveryWarning }}</p>
      <pre>{{ recoveryPreview }}</pre>
      <div class="ai-recovery-actions">
        <button
          class="primary-button"
          @click="ai.acceptPendingRecovery"
        >
          {{ labels.recoveryApply }}
        </button>
        <button
          class="secondary-button"
          @click="ai.discardPendingRecovery"
        >
          {{ labels.recoveryDiscard }}
        </button>
      </div>
    </div>

    <div
      v-if="ai.loading"
      class="ai-working"
      role="status"
      aria-live="polite"
    >
      <span
        class="ai-spinner"
        aria-hidden="true"
      />
      <span>{{ currentProgressLabel || (ai.renderingPdf ? labels.preparingPdf : labels.working) }}</span>
    </div>

    <div class="ai-composer">
      <input
        id="ai-attachment-input"
        class="ai-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf"
        multiple
        :disabled="ai.loading || !hasDocument"
        @change="selectFiles"
      >
      <label
        for="ai-attachment-input"
        class="ai-attachment-dropzone"
        :class="{ active: dragOver, disabled: ai.loading || !hasDocument }"
      >
        <span>📎 {{ labels.attachHint }}</span>
      </label>
      <p class="ai-attachment-privacy">
        {{ labels.attachmentPrivacy }}
      </p>
      <div
        v-if="ai.pendingAttachments.length"
        class="ai-pending-attachments"
      >
        <div
          v-for="pending in ai.pendingAttachments"
          :key="pending.attachment.id"
          class="ai-pending-attachment"
          :title="pending.attachment.name"
        >
          <span
            v-if="pending.attachment.mimeType === 'application/pdf'"
            class="ai-attachment-icon ai-pdf-icon"
            aria-hidden="true"
          >
            PDF
          </span>
          <span
            v-else
            class="ai-attachment-icon"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 16 16"
              focusable="false"
            >
              <rect
                x="1.5"
                y="2"
                width="13"
                height="12"
                rx="1.5"
              />
              <circle
                cx="5"
                cy="5.5"
                r="1.25"
              />
              <path d="m3 12 3.2-3.2 2.3 2.1 1.6-1.6L13 12" />
            </svg>
          </span>
          <span class="ai-attachment-name">{{ pending.attachment.name }}</span>
          <template v-if="pending.attachment.mimeType === 'application/pdf'">
            <span class="ai-pdf-page-count">
              {{ labels.pdfPages(pending.pdfPageCount ?? 0) }}
            </span>
            <input
              class="ai-pdf-page-input"
              type="text"
              :value="pending.pdfPageSelection ?? ''"
              :placeholder="pending.pdfPageCount && pending.pdfPageCount > 10 ? labels.pdfPagePlaceholder : ''"
              :aria-label="labels.pdfPageLabel"
              @input="updatePdfPageSelection(pending.attachment.id, ($event.target as HTMLInputElement).value)"
            >
          </template>
          <button
            type="button"
            :title="labels.removeAttachment"
            @click="ai.removePendingAttachment(pending.attachment.id)"
          >
            ×
          </button>
        </div>
      </div>
      <p
        v-if="pendingPdfCount"
        class="ai-pdf-budget"
      >
        {{ labels.pdfBudget(pendingImageBudget) }}
      </p>
      <p
        v-if="attachmentErrorLabel"
        class="ai-attachment-error"
      >
        {{ attachmentErrorLabel }}
      </p>
      <textarea
        v-model="draft"
        :placeholder="labels.placeholder"
        :disabled="ai.loading || !hasDocument"
        rows="4"
        @paste="pasteFiles"
      />
      <div class="ai-composer-actions">
        <span class="ai-hint">{{ labels.sendHint }}</span>
        <button
          v-if="ai.loading"
          class="secondary-button"
          @click="ai.stop"
        >
          {{ labels.stop }}
        </button>
        <button
          class="primary-button"
          :disabled="!draft.trim() || ai.loading || !!ai.pendingRecovery || !hasDocument"
          @click="send"
        >
          {{ ai.loading ? labels.thinking : labels.send }}
        </button>
      </div>
    </div>

    <footer class="ai-footer">
      <button
        class="link-button"
        :disabled="!ai.messages.length"
        @click="ai.clearChat"
      >
        {{ labels.clear }}
      </button>
      <button
        class="link-button"
        @click="ai.undoAiEdit"
      >
        {{ labels.undo }}
      </button>
      <span
        v-if="!ai.hasAnyApiKey"
        class="ai-unconfigured"
      >
        {{ labels.unconfigured }}
      </span>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAiStore } from '@/store/ai'
import { getCurrentLanguage } from '@/i18n'
import bus from '@/bus'
import type { AiChatMessage, AiModelRef, AiProgressEvent, AiProgressInfo } from '@shared/types/ai'
import { createAiPanelLabels } from './labels'
import { hasFilePayload, isInsidePanel, stopPanelFileDrag } from './dragDrop'
import { formatPages, makeUnifiedDiff } from './formatters'

const ai = useAiStore()
const { currentDocumentId } = storeToRefs(ai)
const panelElement = ref<HTMLElement | null>(null)
const messagesElement = ref<HTMLElement | null>(null)
const draft = ref('')
const dragOver = ref(false)
const copiedFailureId = ref('')
const resizing = ref(false)
const resizeStartX = ref(0)
const resizeStartWidth = ref(380)
const followMessages = ref(true)
let stopProgressListener: (() => void) | undefined

const chinese = computed(() => getCurrentLanguage().toLowerCase().startsWith('zh'))
const labels = computed(() => createAiPanelLabels(chinese.value))
const modeLabel = computed(() => {
  if (ai.mode === 'rewrite') return labels.value.rewrite
  return ai.mode === 'answer' ? labels.value.answer : labels.value.edit
})
const modeHelp = computed(() => {
  if (ai.mode === 'rewrite') return labels.value.rewriteHelp
  return ai.mode === 'answer' ? labels.value.answerHelp : labels.value.editHelp
})
const modelGroups = computed(() => {
  const groups = new Map<string, { connectionId: string; connectionName: string; models: typeof ai.modelOptions }>()
  for (const option of ai.modelOptions) {
    const group = groups.get(option.connectionId) ?? {
      connectionId: option.connectionId,
      connectionName: option.connectionName,
      models: []
    }
    group.models.push(option)
    groups.set(option.connectionId, group)
  }
  return Array.from(groups.values())
})
const hasDocument = computed(() => !!currentDocumentId.value)
const pendingPdfCount = computed(() => ai.pendingAttachments.filter(item => item.attachment.mimeType === 'application/pdf').length)
const pendingImageBudget = computed(() => {
  const used = ai.pendingAttachments.reduce((total, item) => {
    if (item.attachment.mimeType !== 'application/pdf') return total + 1
    return total + (item.attachment.pages?.length ?? 0)
  }, 0)
  return Math.max(0, 10 - used)
})
const modelOptionValue = (value: AiModelRef): string => JSON.stringify(value)
const attachmentErrorLabel = computed(() => {
  if (ai.attachmentError === 'unsupported') return labels.value.attachmentUnsupported
  if (ai.attachmentError === 'too-large') return labels.value.attachmentTooLarge
  if (ai.attachmentError === 'pdf-too-large') return labels.value.attachmentPdfTooLarge
  if (ai.attachmentError === 'too-many') return labels.value.attachmentTooMany
  if (ai.attachmentError === 'total-too-large') return labels.value.attachmentTotalTooLarge
  if (ai.attachmentError === 'read-failed') return labels.value.attachmentReadFailed
  if (ai.attachmentError === 'pdf-pages-required') return labels.value.pdfPagesRequired
  if (ai.attachmentError === 'pdf-invalid-pages') return labels.value.pdfInvalidPages
  if (ai.attachmentError === 'pdf-render-failed') return labels.value.attachmentReadFailed
  return ''
})
const recoveryPreview = computed(() => {
  const proposal = ai.pendingRecovery
  if (!proposal) return ''
  return makeUnifiedDiff(proposal.beforeMarkdown, proposal.response.markdown ?? '')
})

const editSummaryLabel = (message: AiChatMessage): string => {
  if (message.mode === 'rewrite') return labels.value.rewriteApplied
  if (!message.editSummary || message.editSummary.operationCount === 0) return labels.value.noChanges
  return labels.value.editApplied(
    message.editSummary.operationCount,
    message.editSummary.addedLines,
    message.editSummary.removedLines
  )
}

const stepDeltaLabel = (progress: AiProgressInfo | AiProgressEvent | undefined): string => {
  if (progress?.stepAddedLines === undefined && progress?.stepRemovedLines === undefined) return ''
  const added = progress.stepAddedLines ?? 0
  const removed = progress.stepRemovedLines ?? 0
  return chinese.value ? `+${added}行-${removed}行` : `+${added} lines -${removed} lines`
}

const hasStepDiff = (progress: AiProgressInfo | undefined): boolean =>
  progress?.stepRemovedText !== undefined || progress?.stepAddedText !== undefined

const progressLabelFor = (progress: AiProgressInfo | undefined): string => {
  const current = progress?.current
  const total = progress?.total
  const baseTokenUsage = progress?.outputTokens === undefined
    ? ''
    : progress.inputTokens !== undefined
      ? chinese.value
        ? `${progress.outputTokensEstimated ? '约 ' : ''}${progress.inputTokens + progress.outputTokens} tokens（输入 ${progress.inputTokens} / 输出 ${progress.outputTokens}）`
        : `${progress.outputTokensEstimated ? 'about ' : ''}${progress.inputTokens + progress.outputTokens} tokens (input ${progress.inputTokens} / output ${progress.outputTokens})`
      : chinese.value
        ? `${progress.outputTokensEstimated ? '约 ' : ''}输出 ${progress.outputTokens} tokens`
        : `${progress.outputTokensEstimated ? 'about ' : ''}${progress.outputTokens} output tokens`
  const cacheUsage = progress?.cachedInputTokens !== undefined
    ? chinese.value ? `缓存输入 ${progress.cachedInputTokens}` : `cached input ${progress.cachedInputTokens}`
    : ''
  const totalTokenUsage = progress?.totalInputTokens !== undefined || progress?.totalOutputTokens !== undefined
    ? chinese.value
      ? `累计 ${(progress.totalInputTokens ?? 0) + (progress.totalOutputTokens ?? 0)} tokens（输入 ${progress.totalInputTokens ?? 0} / 输出 ${progress.totalOutputTokens ?? 0}）`
      : `total ${(progress.totalInputTokens ?? 0) + (progress.totalOutputTokens ?? 0)} tokens (input ${progress.totalInputTokens ?? 0} / output ${progress.totalOutputTokens ?? 0})`
    : ''
  const tokenUsage = [baseTokenUsage, cacheUsage].filter(Boolean).join(' · ')
  const displayedTokenUsage = ['completed', 'failed', 'partial', 'cancelled'].includes(progress?.phase ?? '')
    ? [totalTokenUsage, cacheUsage].filter(Boolean).join(' · ')
    : tokenUsage
  const attempt = progress?.attempt
    ? chinese.value ? `第 ${progress.attempt} 次尝试` : `attempt ${progress.attempt}`
    : ''
  const failureReason = progress?.failureReason === 'exact-match'
    ? chinese.value ? 'SEARCH 未精确匹配' : 'SEARCH did not match exactly'
    : progress?.failureReason === 'scope'
      ? chinese.value ? '编辑计划定位失败，正在重新规划' : 'Edit plan target failed; replanning'
      : progress?.failureReason === 'truncated'
        ? chinese.value ? '输出被截断' : 'Output was truncated'
        : progress?.failureReason === 'provider'
          ? chinese.value ? '模型请求失败' : 'Model request failed'
          : progress?.failureReason === 'capability'
            ? chinese.value ? '模型不支持工具调用' : 'Model does not support tool calling'
            : chinese.value ? '格式不符合要求' : 'Format validation failed'
  if (chinese.value) {
    switch (progress?.phase) {
      case 'pdf-rendering':
        return current && total ? `正在将 PDF 转换为图片（第 ${current}/${total} 张）` : '正在将 PDF 转换为图片…'
      case 'pdf-rendered': return `PDF 已转换为 ${total ?? current ?? 0} 张图片`
      case 'attachment-extracting': return '正在提取附件来源笔记…'
      case 'sending': return '正在发送给模型…'
      case 'sent': return '已发送给模型'
      case 'waiting': return '正在等待模型响应…'
      case 'compacting': return '正在压缩对话上下文…'
      case 'streaming': return tokenUsage ? `模型已开始输出 · ${tokenUsage}` : '模型已开始输出'
      case 'responded': return '模型已响应'
      case 'validating': return attempt ? `正在校验编辑指令… · ${attempt}` : '正在校验编辑指令…'
      case 'agent-plan': return `${progress?.planRevisionCount ? '正在修订剩余编辑计划' : '正在制定编辑计划'}${progress?.planStepCount !== undefined ? ` · ${progress.planStepCount} 步` : ''}`
      case 'agent-step': return `第 ${progress?.step ?? 0}/${progress?.planStepCount ?? progress?.maxSteps ?? 0} 步已应用${stepDeltaLabel(progress) ? ` · ${stepDeltaLabel(progress)}` : ''}`
      case 'attempt-failed': return `${attempt || '本次尝试'}失败 · ${failureReason}${tokenUsage ? ` · 消耗${tokenUsage}` : ''}`
      case 'retrying': return `正在自动重试… · ${attempt}${tokenUsage ? ` · 上次消耗${tokenUsage}` : ''}`
      case 'fallback': return `正在生成安全替代结果… · ${attempt}`
      case 'local-processing': return '正在本地解析和编辑…'
      case 'completed': return tokenUsage ? `处理完成 · ${tokenUsage}` : '本地解析和编辑完成'
      case 'cancelled': return '请求已停止'
      case 'partial': return `部分完成${attempt ? ` · ${attempt}` : ''}${displayedTokenUsage ? ` · ${displayedTokenUsage}` : ''}`
      case 'failed': return `请求失败${attempt ? ` · ${attempt}` : ''}${displayedTokenUsage ? ` · ${displayedTokenUsage}` : ''}`
      default: return '正在处理…'
    }
  }
  switch (progress?.phase) {
    case 'pdf-rendering':
      return current && total ? `Rendering PDF pages (${current}/${total})…` : 'Rendering PDF pages…'
    case 'pdf-rendered': return `PDF converted to ${total ?? current ?? 0} images`
    case 'attachment-extracting': return 'Extracting attachment source brief…'
    case 'sending': return 'Sending to model…'
    case 'sent': return 'Sent to model'
    case 'waiting': return 'Waiting for model response…'
    case 'compacting': return 'Compacting conversation context…'
    case 'streaming': return tokenUsage ? `Model is responding · ${tokenUsage}` : 'Model is responding'
    case 'responded': return 'Model responded'
    case 'validating': return attempt ? `Validating edit instructions… · ${attempt}` : 'Validating edit instructions…'
    case 'agent-plan': return `${progress?.planRevisionCount ? 'Revising remaining edit plan' : 'Creating edit plan'}${progress?.planStepCount !== undefined ? ` · ${progress.planStepCount} steps` : ''}`
    case 'agent-step': return `Applied agent step ${progress?.step ?? 0}/${progress?.planStepCount ?? progress?.maxSteps ?? 0}${stepDeltaLabel(progress) ? ` · ${stepDeltaLabel(progress)}` : ''}`
    case 'attempt-failed': return `${attempt || 'Attempt'} failed · ${failureReason}${tokenUsage ? ` · ${tokenUsage} used` : ''}`
    case 'retrying': return `Retrying automatically… · ${attempt}${tokenUsage ? ` · previous ${tokenUsage}` : ''}`
    case 'fallback': return `Generating safe fallback… · ${attempt}`
    case 'local-processing': return 'Parsing and editing locally…'
    case 'completed': return tokenUsage ? `Completed · ${tokenUsage}` : 'Local parsing and editing completed'
    case 'cancelled': return 'Request stopped'
    case 'partial': return `Partially completed${attempt ? ` · ${attempt}` : ''}${displayedTokenUsage ? ` · ${displayedTokenUsage}` : ''}`
    case 'failed': return `Request failed${attempt ? ` · ${attempt}` : ''}${displayedTokenUsage ? ` · ${displayedTokenUsage} used` : ''}`
    default: return 'Working…'
  }
}

const progressLabel = (message: AiChatMessage): string => progressLabelFor(message.progress)

const liveProgressLabel = (progress: AiProgressEvent | undefined, elapsedMs: number): string => {
  if (!progress) return ''
  const elapsed = chinese.value
    ? `${Math.max(0, Math.floor(elapsedMs / 1000))} 秒`
    : `${Math.max(0, Math.floor(elapsedMs / 1000))} seconds`
  const outputTokens = progress.outputTokensEstimated
    ? chinese.value ? `输出约 ${progress.outputTokens} tokens` : `about ${progress.outputTokens} output tokens`
    : chinese.value ? `输出 ${progress.outputTokens} tokens` : `${progress.outputTokens} output tokens`
  const tokens = progress.cachedInputTokens !== undefined
    ? `${outputTokens} · ${chinese.value ? `缓存输入 ${progress.cachedInputTokens}` : `cached input ${progress.cachedInputTokens}`}`
    : outputTokens
  const usage = progress.inputTokens !== undefined
    ? chinese.value ? `输入 ${progress.inputTokens} / ${tokens}` : `input ${progress.inputTokens} / ${tokens}`
    : tokens
  const stepTotal = progress.planStepCount ?? progress.maxSteps ?? 0
  const totalUsage = progress.totalInputTokens !== undefined || progress.totalOutputTokens !== undefined
    ? chinese.value
      ? `累计输入 ${progress.totalInputTokens ?? 0} / 输出 ${progress.totalOutputTokens ?? 0}`
      : `total input ${progress.totalInputTokens ?? 0} / output ${progress.totalOutputTokens ?? 0}`
    : ''
  if (chinese.value) {
    switch (progress.phase) {
      case 'waiting': return `正在等待模型响应… · ${elapsed}`
      case 'attachment-extracting': return `正在提取附件来源笔记… · ${elapsed}`
      case 'compacting': return `正在压缩对话上下文… · ${elapsed}`
      case 'streaming': return `模型已开始输出 · ${usage} · ${elapsed}`
      case 'validating': return `正在校验编辑指令… · 第 ${progress.attempt} 次尝试 · ${elapsed}`
      case 'agent-plan': return `${progress.planRevisionCount ? '正在修订剩余编辑计划' : '正在制定编辑计划'}… · ${elapsed}`
      case 'agent-step': return `第 ${progress.step ?? 0}/${stepTotal} 步已应用${stepDeltaLabel(progress) ? ` · ${stepDeltaLabel(progress)}` : ''}，继续执行… · ${elapsed}`
      case 'attempt-failed': return `第 ${progress.attempt} 次尝试失败 · ${usage} · ${elapsed}`
      case 'retrying': return `格式不符合要求，正在重试… · 第 ${progress.attempt} 次尝试 · ${elapsed}`
      case 'fallback': return `正在生成安全替代结果… · 第 ${progress.attempt} 次尝试 · ${elapsed}`
      case 'completed': return `处理完成${totalUsage ? ` · ${totalUsage}` : ''} · ${elapsed}`
      case 'partial': return `部分完成${totalUsage ? ` · ${totalUsage}` : ''} · ${elapsed}`
      case 'failed': return `请求失败 · 第 ${progress.attempt} 次尝试 · ${usage} · ${elapsed}`
      case 'cancelled': return `请求已停止 · ${elapsed}`
      default: return `${tokens} · ${elapsed}`
    }
  }
  switch (progress.phase) {
    case 'waiting': return `Waiting for model response… · ${elapsed}`
    case 'attachment-extracting': return `Extracting attachment source brief… · ${elapsed}`
    case 'compacting': return `Compacting conversation context… · ${elapsed}`
    case 'streaming': return `Model is responding · ${usage} · ${elapsed}`
    case 'validating': return `Validating edit instructions… · attempt ${progress.attempt} · ${elapsed}`
    case 'agent-plan': return `${progress.planRevisionCount ? 'Revising remaining edit plan' : 'Creating edit plan'}… · ${elapsed}`
    case 'agent-step': return `Applied agent step ${progress.step ?? 0}/${stepTotal}${stepDeltaLabel(progress) ? ` · ${stepDeltaLabel(progress)}` : ''}; continuing… · ${elapsed}`
    case 'attempt-failed': return `Attempt ${progress.attempt} failed · ${usage} · ${elapsed}`
    case 'retrying': return `Format validation failed; retrying… · attempt ${progress.attempt} · ${elapsed}`
    case 'fallback': return `Generating safe fallback… · attempt ${progress.attempt} · ${elapsed}`
    case 'completed': return `Completed${totalUsage ? ` · ${totalUsage}` : ''} · ${elapsed}`
    case 'partial': return `Partially completed${totalUsage ? ` · ${totalUsage}` : ''} · ${elapsed}`
    case 'failed': return `Request failed · attempt ${progress.attempt} · ${usage} · ${elapsed}`
    case 'cancelled': return `Request stopped · ${elapsed}`
    default: return `${tokens} · ${elapsed}`
  }
}

const currentProgressLabel = computed(() => ai.loading && ai.liveProgress
  ? liveProgressLabel(ai.liveProgress, ai.liveProgressElapsedMs)
  : progressLabelFor(ai.currentProgress))

const isNearMessagesBottom = (element: HTMLElement): boolean =>
  element.scrollHeight - element.scrollTop - element.clientHeight <= 48

const handleMessagesScroll = (): void => {
  const element = messagesElement.value
  if (element) followMessages.value = isNearMessagesBottom(element)
}

const scrollMessagesToBottom = (): void => {
  nextTick().then(() => {
    const element = messagesElement.value
    if (element && followMessages.value) element.scrollTop = element.scrollHeight
  }).catch(() => undefined)
}

const copyFailureOutput = async (message: AiChatMessage): Promise<void> => {
  const output = message.progress?.failureOutput
  if (!output) return
  try {
    await navigator.clipboard.writeText(output)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = output
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  copiedFailureId.value = message.id
  window.setTimeout(() => {
    if (copiedFailureId.value === message.id) copiedFailureId.value = ''
  }, 1600)
}

const send = (): void => {
  const value = draft.value.trim()
  if (!value) return
  draft.value = ''
  ai.submit(value).catch(() => undefined)
}

const updatePdfPageSelection = (id: string, value: string): void => {
  ai.setPendingPdfPageSelection(id, value)
}

const selectModel = (event: Event): void => {
  const value = (event.target as HTMLSelectElement).value
  const option = ai.modelOptions.find(item => modelOptionValue(item.ref) === value)
  if (option) ai.selectModel(option.ref)
}

const addFiles = (files: File[]): void => {
  if (!files.length) return
  ai.addAttachmentFiles(files).catch(() => undefined)
}

const handleWindowDragOver = (event: DragEvent): void => {
  if (!hasFilePayload(event)) return
  if (!isInsidePanel(event, panelElement.value)) {
    dragOver.value = false
    return
  }
  stopPanelFileDrag(event, panelElement.value)
  bus.emit('importDialog', false)
  if (event.dataTransfer) event.dataTransfer.dropEffect = ai.loading || !hasDocument.value ? 'none' : 'copy'
  dragOver.value = true
}

const handleWindowDrop = (event: DragEvent): void => {
  if (!stopPanelFileDrag(event, panelElement.value)) return
  dragOver.value = false
  if (ai.loading || !hasDocument.value || !event.dataTransfer) return
  addFiles(Array.from(event.dataTransfer.files))
}

const selectFiles = (event: Event): void => {
  const input = event.target as HTMLInputElement
  addFiles(input.files ? Array.from(input.files) : [])
  input.value = ''
}

const pasteFiles = (event: ClipboardEvent): void => {
  const files: File[] = []
  if (event.clipboardData) {
    for (const item of Array.from(event.clipboardData.items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length) {
    event.preventDefault()
    addFiles(files)
  }
}

const openSettings = (): void => {
  window.electron.ipcRenderer.send('mt::open-setting-window', 'ai')
}

const startResize = (event: PointerEvent): void => {
  resizing.value = true
  resizeStartX.value = event.clientX
  resizeStartWidth.value = ai.width
  window.addEventListener('pointermove', resize)
  window.addEventListener('pointerup', stopResize, { once: true })
}

const resize = (event: PointerEvent): void => {
  if (!resizing.value) return
  ai.setWidth(resizeStartWidth.value - (event.clientX - resizeStartX.value))
}

const stopResize = (): void => {
  resizing.value = false
  window.removeEventListener('pointermove', resize)
}

onMounted(() => {
  ai.loadSettings().catch(() => undefined)
  ai.loadChat()
    .then(() => scrollMessagesToBottom())
    .catch(() => undefined)
  stopProgressListener = ai.listenForProgress()
  window.electron.ipcRenderer.on('mt::ai-settings-changed', (_event, value) => {
    ai.setSettings(value)
  })
  window.electron.ipcRenderer.on('mt::ai-toggle-panel', ai.togglePanel)
  window.addEventListener('dragover', handleWindowDragOver, true)
  window.addEventListener('drop', handleWindowDrop, true)
})

watch(currentDocumentId, (value) => {
  followMessages.value = true
  ai.discardPendingRecovery()
  ai.clearPendingAttachments()
  if (value) ai.loadChat(value).catch(() => undefined)
})

watch(() => ai.messages, () => {
  scrollMessagesToBottom()
}, { deep: true })

watch(() => ai.loading, (loading, wasLoading) => {
  if (loading && !wasLoading) {
    followMessages.value = true
    scrollMessagesToBottom()
  }
})

watch(() => ai.visible, (visible) => {
  if (visible) {
    followMessages.value = true
    scrollMessagesToBottom()
  }
})

onUnmounted(() => {
  stopProgressListener?.()
  stopProgressListener = undefined
  window.electron.ipcRenderer.removeAllListeners('mt::ai-toggle-panel')
  window.electron.ipcRenderer.removeAllListeners('mt::ai-settings-changed')
  ai.clearPendingAttachments()
  stopResize()
  window.removeEventListener('dragover', handleWindowDragOver, true)
  window.removeEventListener('drop', handleWindowDrop, true)
})
</script>

<style scoped>
.ai-panel {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  height: 100vh;
  box-sizing: border-box;
  border-left: 1px solid var(--itemBgColor);
  background: var(--sideBarBgColor);
  color: var(--editorColor);
  z-index: 8;
}
.ai-resize-handle {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  z-index: 2;
}
.ai-header, .ai-footer, .ai-composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ai-header { padding: 16px; border-bottom: 1px solid var(--itemBgColor); color: var(--sideBarTitleColor); }
.ai-subtitle { display: block; margin-top: 3px; color: var(--editorColor60); font-size: 12px; }
.ai-header-actions { display: flex; gap: 4px; }
.icon-button, .link-button, .primary-button, .secondary-button, .ai-mode-switch button {
  border: 0; cursor: pointer; font: inherit;
}
.icon-button { width: 28px; height: 28px; background: transparent; color: var(--sideBarIconColor); font-size: 18px; }
.icon-button:hover:not(:disabled), .link-button:hover:not(:disabled) { color: var(--themeColor); }
.ai-mode-switch { display: flex; gap: 4px; padding: 12px 12px 0; }
.ai-mode-switch button { flex: 1; padding: 8px; border: 1px solid transparent; border-radius: 5px; color: var(--sideBarColor); background: transparent; }
.ai-mode-switch button:hover:not(:disabled) { background: var(--sideBarItemHoverBgColor); }
.ai-mode-switch button.active { border-color: var(--themeColor); color: var(--themeColor); background: var(--buttonBgColorActive); font-weight: 600; }
.ai-model-select { display: flex; flex-direction: column; gap: 5px; margin: 10px 14px 0; }
.ai-model-select label { color: var(--editorColor60); font-size: 11px; font-weight: 600; }
.ai-model-select select { width: 100%; box-sizing: border-box; padding: 7px 8px; border: 1px solid var(--editorColor20); border-radius: 4px; color: var(--editorColor); background: var(--editorBgColor); font: inherit; }
.ai-model-select small { color: var(--editorColor50); font-size: 10px; }
.ai-mode-help { margin: 8px 14px; color: var(--editorColor60); font-size: 12px; line-height: 1.4; }
.ai-messages { flex: 1; overflow: auto; padding: 0 12px 12px; }
.ai-plan-card { margin: 6px 0 10px; padding: 8px 9px; border: 1px solid var(--editorColor20); border-radius: 5px; color: var(--editorColor70); background: var(--editorColor05, transparent); font-size: 11px; line-height: 1.4; }
.ai-plan-title { color: var(--themeColor); font-weight: 600; }
.ai-plan-summary { margin-top: 3px; }
.ai-plan-count { margin-top: 4px; color: var(--editorColor50); }
.ai-plan-card ol { margin: 5px 0 0 18px; padding: 0; }
.ai-empty { padding: 30px 8px; color: var(--editorColor60); text-align: center; font-size: 13px; }
.ai-message { margin: 10px 0; padding: 9px 0; border-bottom: 1px solid var(--editorColor10); }
.ai-message.user { padding-left: 9px; border-left: 2px solid var(--themeColor); }
.ai-status-message { margin: 4px 0; padding: 2px 0; border-bottom: 0; }
.ai-status-content { display: flex; align-items: center; gap: 6px; color: var(--editorColor50); font-size: 10px; line-height: 1.35; }
.ai-status-dot { width: 4px; height: 4px; flex: 0 0 auto; border-radius: 50%; background: var(--editorColor40); }
.ai-step-diff { margin: 5px 0 8px; font-size: 10px; }
.ai-step-diff-title { margin-bottom: 4px; color: var(--editorColor60); }
.ai-step-diff-row { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 5px; align-items: start; margin-top: 3px; }
.ai-step-diff-label { padding: 4px 0; font-weight: 600; }
.ai-step-diff-row pre { min-width: 0; max-height: 180px; margin: 0; padding: 5px 7px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 10px/1.4 monospace; }
.ai-step-diff-row.removed .ai-step-diff-label { color: var(--errorColor, #d33); }
.ai-step-diff-row.removed pre { color: var(--errorColor, #d33); background: color-mix(in srgb, var(--errorColor, #d33) 12%, transparent); border-left: 2px solid var(--errorColor, #d33); }
.ai-step-diff-row.added .ai-step-diff-label { color: #218739; }
.ai-step-diff-row.added pre { color: #218739; background: color-mix(in srgb, #218739 12%, transparent); border-left: 2px solid #218739; }
.ai-message-role { margin-bottom: 5px; color: var(--editorColor60); font-size: 11px; font-weight: 600; }
.ai-message-model { margin: -2px 0 6px; color: var(--editorColor50); font-size: 10px; }
.ai-edit-summary { color: var(--editorColor80); font-size: 13px; line-height: 1.4; }
.ai-message-content { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.45; }
.ai-message-reasoning { margin-top: 8px; color: var(--editorColor50); font-size: 11px; line-height: 1.4; }
.ai-message-reasoning summary { cursor: pointer; color: var(--editorColor60); }
.ai-message-reasoning div { max-height: 220px; margin-top: 5px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.ai-failure-output { margin-top: 7px; color: var(--editorColor60); font-size: 11px; }
.ai-failure-output summary { cursor: pointer; }
.ai-failure-output pre { max-height: 280px; margin: 6px 0; padding: 7px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--editorColor); background: var(--editorColor10); font: 11px/1.35 monospace; }
.ai-failure-output small { display: block; margin-bottom: 5px; color: var(--editorColor50); }
.ai-copy-failure { margin-top: 3px; }
.ai-message-attachments, .ai-pending-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
.ai-attachment-chip, .ai-pending-attachment { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; box-sizing: border-box; padding: 4px 7px; border: 1px solid var(--editorColor20); border-radius: 5px; color: var(--editorColor70); background: var(--editorColor05, transparent); font-size: 11px; overflow: hidden; }
.ai-attachment-name { min-width: 0; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-attachment-pages, .ai-pdf-page-count { flex: 0 0 auto; color: var(--editorColor50); font-size: 10px; }
.ai-pdf-page-input { width: 92px; min-width: 0; padding: 2px 4px; border: 1px solid var(--editorColor20); border-radius: 3px; color: var(--editorColor); background: var(--editorBgColor); font: 10px monospace; }
.ai-attachment-icon { display: inline-flex; flex: 0 0 auto; width: 15px; height: 15px; color: var(--themeColor); }
.ai-attachment-icon svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.35; }
.ai-attachment-icon circle { fill: currentColor; stroke: none; }
.ai-pdf-icon { align-items: center; justify-content: center; border: 1px solid currentColor; border-radius: 2px; font-size: 7px; font-weight: 700; line-height: 1; }
.ai-pending-attachment button { padding: 0 2px; border: 0; color: var(--editorColor60); background: transparent; cursor: pointer; font: inherit; }
.ai-pending-attachment button:hover { color: var(--errorColor, #d33); }
.ai-pdf-budget { margin: 5px 0; color: var(--editorColor50); font-size: 10px; }
  .ai-error { margin: 0 12px 8px; padding: 8px; color: var(--errorColor, #d33); border: 1px solid currentColor; border-radius: 5px; font-size: 12px; }
  .ai-recovery { margin: 0 12px 8px; padding: 8px; border: 1px solid var(--themeColor); border-radius: 5px; font-size: 12px; }
  .ai-recovery p { margin: 0 0 7px; line-height: 1.4; }
  .ai-recovery pre { max-height: 220px; margin: 0 0 7px; padding: 6px; overflow: auto; color: var(--editorColor); background: var(--editorColor10); font: 11px/1.35 monospace; white-space: pre-wrap; }
  .ai-recovery-actions { display: flex; gap: 7px; }
.ai-attachment-error { margin: 6px 0 0; color: var(--errorColor, #d33); font-size: 11px; }
.ai-working { display: flex; align-items: center; gap: 7px; margin: 0 12px 8px; padding: 7px 8px; color: var(--editorColor60); background: var(--floatHoverColor); border-radius: 5px; font-size: 12px; }
.ai-spinner { width: 12px; height: 12px; box-sizing: border-box; border: 2px solid var(--editorColor30); border-top-color: var(--themeColor); border-radius: 50%; animation: ai-spinner-rotation .8s linear infinite; }
@keyframes ai-spinner-rotation { to { transform: rotate(360deg); } }
.ai-composer { padding: 10px 12px; border-top: 1px solid var(--itemBgColor); }
.ai-file-input { display: none; }
.ai-attachment-dropzone { display: block; margin-bottom: 7px; padding: 6px 8px; border: 1px dashed var(--editorColor30); border-radius: 4px; color: var(--editorColor60); cursor: pointer; font-size: 11px; text-align: center; -webkit-app-region: no-drag; app-region: no-drag; }
.ai-attachment-dropzone:hover, .ai-attachment-dropzone.active { border-color: var(--themeColor); color: var(--themeColor); background: var(--buttonBgColorActive); }
.ai-attachment-dropzone.disabled { cursor: default; opacity: .55; }
.ai-attachment-dropzone.disabled:hover { border-color: var(--editorColor30); color: var(--editorColor60); background: transparent; }
.ai-attachment-privacy { margin: -2px 0 6px; color: var(--editorColor50); font-size: 10px; }
.ai-composer textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 76px; padding: 9px; border: 1px solid var(--editorColor30); border-radius: 5px; background: var(--inputBgColor); color: var(--editorColor); font: inherit; }
.ai-composer textarea:focus { outline: none; border-color: var(--themeColor); }
.ai-composer-actions { margin-top: 7px; gap: 8px; }
.ai-hint { flex: 1; color: var(--editorColor50); font-size: 11px; }
.primary-button, .secondary-button { padding: 6px 10px; border-radius: 4px; }
.primary-button { color: var(--buttonPrimaryFontColor); background: var(--buttonPrimaryBgColor); }
.primary-button:hover:not(:disabled) { background: var(--buttonPrimaryBgColorHover); }
.secondary-button { border: var(--buttonBorder); color: var(--buttonFontColor); background: var(--buttonBgColor); }
.secondary-button:hover:not(:disabled) { background: var(--buttonBgColorHover); }
button:disabled { cursor: default; opacity: .45; }
.ai-footer { padding: 8px 12px 12px; gap: 10px; border-top: 1px solid var(--itemBgColor); }
.link-button { padding: 0; color: var(--themeColor); background: transparent; font-size: 12px; }
.ai-unconfigured { margin-left: auto; color: var(--editorColor50); font-size: 11px; }
button:focus-visible, textarea:focus-visible { outline: 1px solid var(--themeColor); outline-offset: 1px; }
</style>
