<template>
  <div class="pref-ai">
    <h4>{{ labels.title }}</h4>
    <p class="notes">
      {{ labels.description }}
    </p>

    <section class="ai-setting-group context-mode-setting">
      <label>{{ labels.contextMode }}</label>
      <select
        v-model="contextMode"
        @change="saveContextMode"
      >
        <option value="recent">
          {{ labels.contextModeRecent }}
        </option>
        <option value="summary">
          {{ labels.contextModeSummary }}
        </option>
      </select>
      <small>{{ labels.contextModeHint }}</small>
    </section>

    <section class="ai-setting-group retry-setting">
      <label>{{ labels.editAgentMaxSteps }}</label>
      <select
        v-model.number="editAgentMaxSteps"
        @change="saveEditAgentMaxSteps"
      >
        <option :value="16">
          16
        </option>
        <option :value="32">
          32
        </option>
        <option :value="64">
          64
        </option>
        <option :value="128">
          128
        </option>
      </select>
      <small>{{ labels.editAgentMaxStepsHint }}</small>
    </section>

    <section class="ai-setting-group failure-output-setting">
      <label>{{ labels.failureOutputAfter }}</label>
      <select
        v-model.number="failureOutputAfter"
        @change="saveFailureOutputAfter"
      >
        <option :value="0">
          0
        </option>
        <option :value="1">
          1
        </option>
        <option :value="2">
          2
        </option>
        <option :value="3">
          3
        </option>
      </select>
      <small>{{ labels.failureOutputAfterHint }}</small>
    </section>

    <div class="connection-toolbar">
      <button
        type="button"
        class="primary-button"
        @click="createConnection"
      >
        {{ labels.addConnection }}
      </button>
    </div>

    <div
      v-if="!settings.connections.length"
      class="empty-state"
    >
      {{ labels.noConnections }}
    </div>

    <div class="connection-layout">
      <div class="connection-list">
        <button
          v-for="connection in settings.connections"
          :key="connection.id"
          type="button"
          class="connection-card"
          :class="{ active: connection.id === form.id }"
          @click="selectConnection(connection.id)"
        >
          <strong>{{ connection.name }}</strong>
          <span>{{ connection.models.length }} {{ labels.models }}</span>
          <small>{{ connection.hasApiKey ? labels.keyPresent : labels.keyMissing }}</small>
        </button>
      </div>

      <section
        v-if="form.id || form.name"
        class="connection-editor"
      >
        <div class="editor-heading">
          <h5>{{ form.id ? labels.editConnection : labels.newConnection }}</h5>
          <button
            v-if="form.id"
            type="button"
            class="danger-button"
            @click="deleteConnection"
          >
            {{ labels.deleteConnection }}
          </button>
        </div>

        <section class="ai-setting-group">
          <label>{{ labels.connectionName }}</label>
          <input
            v-model="form.name"
            type="text"
            autocomplete="off"
          >
        </section>

        <section class="ai-setting-group">
          <label>{{ labels.protocol }}</label>
          <select v-model="form.protocol">
            <option value="openai-responses">
              OpenAI Responses / Compatible (Recommended)
            </option>
            <option value="openai-chat-completions">
              OpenAI Chat Completions / Compatible (Legacy)
            </option>
            <option value="anthropic-messages">
              Anthropic Messages
            </option>
          </select>
        </section>

        <section class="ai-setting-group">
          <label>{{ labels.endpoint }}</label>
          <input
            v-model="form.endpoint"
            type="url"
            autocomplete="url"
            placeholder="https://api.example.com/v1"
          >
          <small>{{ labels.endpointHint }}</small>
        </section>

        <section class="ai-setting-group">
          <label>{{ labels.apiKey }}</label>
          <input
            v-model="apiKey"
            type="password"
            autocomplete="new-password"
            :placeholder="
              selectedConnection?.hasApiKey ? labels.keyConfigured : labels.keyPlaceholder
            "
          >
          <small>{{ labels.keyHint }}</small>
        </section>

        <section class="ai-setting-group">
          <div class="group-heading">
            <label>{{ labels.modelList }}</label>
            <button
              type="button"
              class="secondary-button compact-button"
              :disabled="refreshing"
              @click="refreshModels"
            >
              {{ refreshing ? labels.refreshing : labels.refreshModels }}
            </button>
          </div>
          <div
            v-for="model in form.models"
            :key="model.id || model.model"
            class="model-editor"
          >
            <div class="model-row">
              <input
                v-model="model.model"
                type="text"
                :placeholder="labels.modelId"
              >
              <input
                v-model="model.label"
                type="text"
                :placeholder="labels.modelLabel"
              >
              <button
                class="icon-danger"
                type="button"
                :title="labels.removeModel"
                @click="removeModel(model.id)"
              >
                ×
              </button>
            </div>
            <div
              v-if="form.protocol === 'openai-responses'"
              class="responses-model-options"
            >
              <label>{{ labels.reasoningEffort }}</label>
              <select
                :value="model.capabilities?.responses?.reasoningEffort || ''"
                @change="setResponsesReasoningEffort(model, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">
                  {{ labels.providerDefault }}
                </option>
                <option value="none">
                  none
                </option>
                <option value="minimal">
                  minimal
                </option>
                <option value="low">
                  low
                </option>
                <option value="medium">
                  medium
                </option>
                <option value="high">
                  high
                </option>
                <option value="xhigh">
                  xhigh
                </option>
                <option value="max">
                  max
                </option>
              </select>
              <label class="checkbox-row">
                <input
                  type="checkbox"
                  :checked="model.capabilities?.responses?.reasoningSummary === true"
                  @change="setResponsesReasoningSummary(model, ($event.target as HTMLInputElement).checked)"
                >
                <span>{{ labels.reasoningSummary }}</span>
              </label>
              <small>{{ labels.responsesHint }}</small>
            </div>
            <details class="model-advanced">
              <summary>{{ labels.advancedCompatibility }}</summary>
              <label class="checkbox-row">
                <input
                  type="checkbox"
                  :checked="!!model.capabilities?.requestBodyPresets"
                  @change="toggleRequestBodyPresets(model, ($event.target as HTMLInputElement).checked)"
                >
                <span>{{ labels.requestBodyPresetsEnabled }}</span>
              </label>
              <template v-if="model.capabilities?.requestBodyPresets">
                <small>{{ labels.requestBodyPresetsHint }}</small>
                <div
                  v-for="(preset, index) in model.capabilities.requestBodyPresets.presets"
                  :key="preset.id"
                  class="request-preset-editor"
                >
                  <input
                    v-model="preset.name"
                    type="text"
                    :maxlength="64"
                    :placeholder="labels.requestBodyPresetName"
                  >
                  <button
                    class="icon-danger"
                    type="button"
                    :title="labels.removeRequestBodyPreset"
                    @click="removeRequestBodyPreset(model, index)"
                  >
                    ×
                  </button>
                  <textarea
                    :value="requestBodyPresetDraft(model, preset)"
                    :placeholder="labels.requestBodyPresetBody"
                    rows="5"
                    @input="setRequestBodyPresetDraft(model, preset, ($event.target as HTMLTextAreaElement).value)"
                  />
                  <small
                    v-if="requestBodyPresetError(model, preset)"
                    class="request-preset-error"
                  >{{ requestBodyPresetError(model, preset) }}</small>
                </div>
                <button
                  class="secondary-button compact-button"
                  type="button"
                  :disabled="model.capabilities.requestBodyPresets.presets.length >= 16"
                  @click="addRequestBodyPreset(model)"
                >
                  {{ labels.addRequestBodyPreset }}
                </button>
                <select
                  :value="model.capabilities.requestBodyPresets.defaultPresetId || ''"
                  @change="setRequestBodyPresetDefault(model, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">
                    {{ labels.requestBodyPresetNoDefault }}
                  </option>
                  <option
                    v-for="preset in model.capabilities.requestBodyPresets.presets"
                    :key="`${model.id || model.model}-default-${preset.id}`"
                    :value="preset.id"
                  >
                    {{ preset.name }}
                  </option>
                </select>
                <small>{{ labels.requestBodyPresetDefaultHint }}</small>
                <label>{{ labels.editAgentPreset }}</label>
                <select
                  :value="model.capabilities.requestBodyPresets.editAgentPresetId === null ? '__omit__' : model.capabilities.requestBodyPresets.editAgentPresetId || '__inherit__'"
                  @change="setEditAgentPreset(model, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="__inherit__">
                    {{ labels.editAgentPresetInherit }}
                  </option>
                  <option value="__omit__">
                    {{ labels.editAgentPresetNoExtra }}
                  </option>
                  <option
                    v-for="preset in model.capabilities.requestBodyPresets.presets"
                    :key="`${model.id || model.model}-edit-agent-${preset.id}`"
                    :value="preset.id"
                  >
                    {{ preset.name }}
                  </option>
                </select>
                <small>{{ labels.editAgentPresetHint }}</small>
              </template>
            </details>
          </div>
          <button
            class="secondary-button"
            type="button"
            @click="addModel"
          >
            {{ labels.addModel }}
          </button>
          <select
            v-if="form.id && form.models.some((model) => !!model.id && !!model.model.trim())"
            v-model="defaultModelId"
          >
            <option value="">
              {{ labels.defaultModel }}
            </option>
            <option
              v-for="model in form.models.filter((item) => !!item.id && !!item.model.trim())"
              :key="model.id"
              :value="model.id"
            >
              {{ model.label || model.model }}
            </option>
          </select>
          <small>{{ labels.modelHint }}</small>
        </section>

        <div
          v-if="discoveredModels.length"
          class="discovered-models"
        >
          <strong>{{ labels.discoveredModels }}</strong>
          <button
            v-for="model in discoveredModels"
            :key="model.model"
            type="button"
            class="discovered-model"
            :disabled="hasModel(model.model)"
            @click="addDiscoveredModel(model)"
          >
            {{ model.label || model.model }}
            <span v-if="!hasModel(model.model)">＋</span>
            <span v-else>✓</span>
          </button>
        </div>

        <div class="ai-setting-actions">
          <button
            type="button"
            class="primary-button"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? labels.saving : labels.save }}
          </button>
          <button
            type="button"
            class="secondary-button"
            :disabled="testing"
            @click="test"
          >
            {{ testing ? labels.testing : labels.test }}
          </button>
          <button
            type="button"
            class="secondary-button"
            :disabled="!form.id || !form.models.some((model) => !!model.id && !!model.model.trim())"
            @click="setDefault"
          >
            {{ labels.setDefault }}
          </button>
          <button
            type="button"
            class="danger-button"
            :disabled="!selectedConnection?.hasApiKey"
            @click="deleteKey"
          >
            {{ labels.deleteKey }}
          </button>
        </div>
        <p
          v-if="status"
          class="status"
          :class="{ failure: !statusOk }"
        >
          {{ status }}
        </p>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import log from 'electron-log'
import { useAiStore } from '@/store/ai'
import { getCurrentLanguage } from '@/i18n'
import type {
  AiConnectionInput,
  AiConnectionProfile,
  AiConnectionSettings,
  AiContextMode,
  AiDiscoveredModel,
  AiModelCapabilities,
  AiRequestBodyPreset,
  AiJsonValue,
  AiReasoningEffort
} from '@shared/types/ai'

type FormModel = AiConnectionInput['models'][number]

const ai = useAiStore()
const settings = ref<AiConnectionSettings>({ connections: [] })
const form = reactive<AiConnectionInput>({
  name: '',
  protocol: 'openai-responses',
  endpoint: '',
  models: []
})
const apiKey = ref('')
const saving = ref(false)
const testing = ref(false)
const refreshing = ref(false)
const status = ref('')
const statusOk = ref(true)
const discoveredModels = ref<AiDiscoveredModel[]>([])
const requestBodyPresetDrafts = reactive<Record<string, string>>({})
const requestBodyPresetErrors = reactive<Record<string, string>>({})
const defaultModelId = ref('')
const editAgentMaxSteps = ref(64)
const failureOutputAfter = ref(1)
const contextMode = ref<AiContextMode>('recent')
const chinese = computed(() => getCurrentLanguage().toLowerCase().startsWith('zh'))
const connectionLog = (message: string, ...args: unknown[]): void => {
  log.info(`[ai-connection] ${message}`, ...args)
}
const labels = computed(() =>
  chinese.value
    ? {
        title: 'AI 连接与模型',
        description:
          '配置多个 AI 连接。新连接默认优先使用 OpenAI Responses；Chat Completions 作为 Legacy compatibility 保留。密钥只保存在本机用户数据目录。',
        contextMode: '上下文模式',
        contextModeRecent: '保留最近对话',
        contextModeSummary: '自动摘要（适合便宜模型）',
        contextModeHint: '摘要模式只向模型发送滚动摘要、本轮任务和当前文档；界面历史仍会保留。',
        addConnection: '新增连接',
        noConnections: '还没有配置 AI 连接。',
        newConnection: '新连接',
        editConnection: '编辑连接',
        deleteConnection: '删除连接',
        connectionName: '连接名称',
        protocol: '协议',
        reasoningEffort: '推理 effort（模型默认）',
        providerDefault: 'Provider default',
        reasoningSummary: '显示推理摘要',
        responsesHint: 'Responses API 使用标准 reasoning.effort；无需手写 JSON。摘要默认关闭。',
        endpoint: 'API 地址 / Base URL',
        endpointHint:
          '支持 Base URL 或完整端点，必须使用 HTTPS。模型列表接口不可用时仍可手动添加模型。',
        apiKey: 'API 密钥',
        keyPresent: '已配置密钥',
        keyMissing: '未配置密钥',
        keyConfigured: '已配置（留空表示保持不变）',
        keyPlaceholder: '输入 API 密钥',
        keyHint: '保存后界面不会再次读取或显示密钥。',
        modelList: '模型列表',
        modelId: '模型 ID',
        modelLabel: '显示名称（可选）',
        models: '个模型',
        modelHint: '可手动添加模型，也可尝试刷新服务端模型列表。',
        addModel: '手动添加模型',
        removeModel: '移除模型',
        refreshModels: '刷新模型列表',
        refreshing: '刷新中…',
        discoveredModels: '发现的模型',
        modelAdvanced: '模型高级设置',
        advancedCompatibility: '高级兼容选项（JSON 预设）',
        requestBodyPresetsEnabled: '配置请求 JSON 预设',
        requestBodyPresetsHint: '仅用于 Chat/Anthropic 或特殊兼容网关；Responses 预设不能覆盖应用管理的请求字段。',
        requestBodyPresetName: '预设名称',
        requestBodyPresetBody: '{"thinking":{"type":"enabled"}}',
        addRequestBodyPreset: '添加预设',
        removeRequestBodyPreset: '移除预设',
        requestBodyPresetNoDefault: '不应用额外 JSON',
        requestBodyPresetDefaultHint: '默认预设影响模型请求；AI 面板可以按当前会话临时覆盖。',
        editAgentPreset: '编辑 Agent 预设',
        editAgentPresetInherit: '继承普通预设',
        editAgentPresetNoExtra: '无额外 JSON',
        editAgentPresetHint: '仅前台精准编辑流程使用；附件提取、计划、编辑步骤和完整文档回退都会使用此选择。',
        save: '保存连接',
        saving: '保存中…',
        test: '测试连接',
        testing: '测试中…',
        defaultModel: '选择默认模型',
        setDefault: '保存默认模型',
        deleteKey: '删除密钥',
        editAgentMaxSteps: '精准编辑 Agent 最大步骤数',
        editAgentMaxStepsHint: '每一步只执行一个局部修改；达到上限后会放弃本次虚拟编辑。',
        failureOutputAfter: '失败后显示模型原始输出',
        failureOutputAfterHint:
          '达到指定失败次数且请求最终失败后，可展开并复制最后一次模型输出；0 表示关闭。'
      }
    : {
        title: 'AI Connections & Models',
        description:
          'Configure AI connections. New connections use OpenAI Responses by default; Chat Completions remains available as Legacy compatibility. Keys stay in local user data.',
        contextMode: 'Context mode',
        contextModeRecent: 'Keep recent messages',
        contextModeSummary: 'Automatic summary (for cheaper models)',
        contextModeHint: 'Summary mode sends only rolling memory, the current task, and the current document; UI history is retained.',
        addConnection: 'Add connection',
        noConnections: 'No AI connections configured yet.',
        newConnection: 'New connection',
        editConnection: 'Edit connection',
        deleteConnection: 'Delete connection',
        connectionName: 'Connection name',
        protocol: 'Protocol',
        reasoningEffort: 'Reasoning effort (model default)',
        providerDefault: 'Provider default',
        reasoningSummary: 'Show reasoning summary',
        responsesHint: 'Responses API uses standard reasoning.effort; no JSON is required. Summaries are off by default.',
        endpoint: 'API endpoint / Base URL',
        endpointHint:
          'Base URLs and complete endpoints are supported over HTTPS. Models can still be added manually when discovery is unavailable.',
        apiKey: 'API key',
        keyPresent: 'Key configured',
        keyMissing: 'Key missing',
        keyConfigured: 'Configured (leave blank to keep it)',
        keyPlaceholder: 'Enter API key',
        keyHint: 'The key is never read back or displayed after saving.',
        modelList: 'Models',
        modelId: 'Model ID',
        modelLabel: 'Display name (optional)',
        models: 'models',
        modelHint: 'Add model IDs manually or refresh the provider model list.',
        addModel: 'Add model manually',
        removeModel: 'Remove model',
        refreshModels: 'Refresh models',
        refreshing: 'Refreshing…',
        discoveredModels: 'Discovered models',
        modelAdvanced: 'Advanced model settings',
        advancedCompatibility: 'Advanced compatibility options (JSON presets)',
        requestBodyPresetsEnabled: 'Configure request JSON presets',
        requestBodyPresetsHint: 'Use for Chat/Anthropic or special compatibility gateways; Responses presets cannot override app-managed request fields.',
        requestBodyPresetName: 'Preset name',
        requestBodyPresetBody: '{"thinking":{"type":"enabled"}}',
        addRequestBodyPreset: 'Add preset',
        removeRequestBodyPreset: 'Remove preset',
        requestBodyPresetNoDefault: 'Do not apply extra JSON',
        requestBodyPresetDefaultHint: 'The default preset applies to model requests; the AI panel can override it for the current session.',
        editAgentPreset: 'Edit Agent preset',
        editAgentPresetInherit: 'Inherit normal preset',
        editAgentPresetNoExtra: 'No extra JSON',
        editAgentPresetHint: 'Applies only to the foreground precise-edit workflow, including attachment extraction, planning, edit steps, and whole-document fallback.',
        save: 'Save connection',
        saving: 'Saving…',
        test: 'Test connection',
        testing: 'Testing…',
        defaultModel: 'Choose default model',
        setDefault: 'Save default model',
        deleteKey: 'Delete key',
        editAgentMaxSteps: 'Maximum Agent steps for precise editing',
        editAgentMaxStepsHint:
          'Each step performs one local edit; reaching the limit discards the virtual edit.',
        failureOutputAfter: 'Show raw model output after failure',
        failureOutputAfterHint:
          'After this many failures, a final failed request can show and copy the last model output; 0 disables it.'
      }
)

const selectedConnection = computed<AiConnectionProfile | undefined>(() =>
  settings.value.connections.find((connection) => connection.id === form.id)
)

const createId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') { return crypto.randomUUID() }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const formModelKey = (model: FormModel): string => model.id || model.model

const requestBodyPresetKey = (model: FormModel, preset: AiRequestBodyPreset): string =>
  `${formModelKey(model)}\u0000${preset.id}`

const requestBodyPresetDraft = (model: FormModel, preset: AiRequestBodyPreset): string =>
  requestBodyPresetDrafts[requestBodyPresetKey(model, preset)] ?? JSON.stringify(preset.body, null, 2)

const requestBodyPresetError = (model: FormModel, preset: AiRequestBodyPreset): string =>
  requestBodyPresetErrors[requestBodyPresetKey(model, preset)] ?? ''

const setRequestBodyPresetDraft = (model: FormModel, preset: AiRequestBodyPreset, value: string): void => {
  const key = requestBodyPresetKey(model, preset)
  requestBodyPresetDrafts[key] = value
  try {
    const parsed = JSON.parse(value) as AiJsonValue
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) {
      throw new Error('The preset body must be a non-empty JSON object.')
    }
    preset.body = parsed as Record<string, AiJsonValue>
    delete requestBodyPresetErrors[key]
  } catch (error) {
    requestBodyPresetErrors[key] = error instanceof Error ? error.message : 'Invalid JSON.'
  }
}

const setRequestBodyPresetConfig = (model: FormModel, capabilities: AiModelCapabilities | undefined): void => {
  model.capabilities = capabilities
}

const toggleRequestBodyPresets = (model: FormModel, enabled: boolean): void => {
  if (enabled) {
    setRequestBodyPresetConfig(model, {
      ...(model.capabilities ?? {}),
      requestBodyPresets: model.capabilities?.requestBodyPresets ?? { presets: [] }
    })
    return
  }
  const capabilities = model.capabilities ? { ...model.capabilities } : undefined
  if (capabilities) delete capabilities.requestBodyPresets
  setRequestBodyPresetConfig(model, capabilities && Object.keys(capabilities).length ? capabilities : undefined)
}

const setResponsesReasoningEffort = (model: FormModel, value: string): void => {
  const capabilities = { ...(model.capabilities ?? {}) }
  const responses = { ...(capabilities.responses ?? {}) }
  const valid: AiReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  if (!value) delete responses.reasoningEffort
  else if (valid.includes(value as AiReasoningEffort)) responses.reasoningEffort = value as AiReasoningEffort
  if (Object.keys(responses).length) capabilities.responses = responses
  else delete capabilities.responses
  model.capabilities = Object.keys(capabilities).length ? capabilities : undefined
}

const setResponsesReasoningSummary = (model: FormModel, enabled: boolean): void => {
  const capabilities = { ...(model.capabilities ?? {}) }
  const responses = { ...(capabilities.responses ?? {}) }
  if (enabled) responses.reasoningSummary = true
  else delete responses.reasoningSummary
  if (Object.keys(responses).length) capabilities.responses = responses
  else delete capabilities.responses
  model.capabilities = Object.keys(capabilities).length ? capabilities : undefined
}

const addRequestBodyPreset = (model: FormModel): void => {
  const config = model.capabilities?.requestBodyPresets
  if (!config || config.presets.length >= 16) return
  const preset: AiRequestBodyPreset = {
    id: createId(),
    name: chinese.value ? `新预设 ${config.presets.length + 1}` : `New preset ${config.presets.length + 1}`,
    body: {}
  }
  model.capabilities = {
    ...(model.capabilities ?? {}),
    requestBodyPresets: { ...config, presets: [...config.presets, preset] }
  }
  const key = requestBodyPresetKey(model, preset)
  requestBodyPresetDrafts[key] = '{}'
  requestBodyPresetErrors[key] = 'The preset body must be a non-empty JSON object.'
}

const removeRequestBodyPreset = (model: FormModel, index: number): void => {
  const config = model.capabilities?.requestBodyPresets
  if (!config) return
  const removed = config.presets[index]
  if (!removed) return
  const presets = config.presets.filter((_preset, presetIndex) => presetIndex !== index)
  model.capabilities = {
    ...(model.capabilities ?? {}),
    requestBodyPresets: {
      ...config,
      presets,
      ...(config.defaultPresetId === removed.id ? { defaultPresetId: undefined } : {}),
      ...(config.editAgentPresetId === removed.id ? { editAgentPresetId: undefined } : {})
    }
  }
  const key = requestBodyPresetKey(model, removed)
  delete requestBodyPresetDrafts[key]
  delete requestBodyPresetErrors[key]
}

const setRequestBodyPresetDefault = (model: FormModel, value: string): void => {
  const config = model.capabilities?.requestBodyPresets
  if (!config) return
  model.capabilities = {
    ...(model.capabilities ?? {}),
    requestBodyPresets: { ...config, ...(value ? { defaultPresetId: value } : { defaultPresetId: undefined }) }
  }
}

const setEditAgentPreset = (model: FormModel, value: string): void => {
  const config = model.capabilities?.requestBodyPresets
  if (!config) return
  const editAgentPresetId = value === '__omit__' ? null : value === '__inherit__' ? undefined : value
  model.capabilities = {
    ...(model.capabilities ?? {}),
    requestBodyPresets: { ...config, editAgentPresetId }
  }
}

const cloneCapabilities = (capabilities: AiModelCapabilities | undefined, model?: FormModel): AiModelCapabilities | undefined => {
  if (!capabilities) return undefined
  const presets = capabilities.requestBodyPresets?.presets.map(preset => {
    const draft = model ? requestBodyPresetDrafts[requestBodyPresetKey(model, preset)] : undefined
    const body = draft === undefined ? preset.body : JSON.parse(draft) as Record<string, AiJsonValue>
    return { ...preset, body: JSON.parse(JSON.stringify(body)) }
  })
  return {
    ...capabilities,
    ...(capabilities.responses ? { responses: { ...capabilities.responses } } : {}),
    ...(capabilities.requestBodyPresets && presets
      ? { requestBodyPresets: { ...capabilities.requestBodyPresets, presets } }
      : {})
  }
}

const resetForm = (): void => {
  form.id = undefined
  form.name = chinese.value ? '新连接' : 'New connection'
  form.protocol = 'openai-responses'
  form.endpoint = ''
  form.models = []
  defaultModelId.value = ''
  apiKey.value = ''
  discoveredModels.value = []
}

const selectConnection = (id: string): void => {
  const connection = settings.value.connections.find((item) => item.id === id)
  if (!connection) return
  form.id = connection.id
  form.name = connection.name
  form.protocol = connection.protocol
  form.endpoint = connection.endpoint
  form.models = connection.models.map((model) => ({
    id: model.id,
    model: model.model,
    label: model.label,
    source: model.source,
    capabilities: cloneCapabilities(model.capabilities, model)
  }))
  defaultModelId.value =
    settings.value.defaultModel?.connectionId === connection.id
      ? settings.value.defaultModel.modelId
      : ''
  apiKey.value = ''
  discoveredModels.value = []
  status.value = ''
}

const createConnection = (): void => {
  resetForm()
  status.value = ''
}

const input = (): AiConnectionInput => ({
  id: form.id,
  name: form.name,
  protocol: form.protocol,
  endpoint: form.endpoint,
  // The form is reactive. Send plain objects because Electron IPC cannot structured-clone Vue proxies.
  models: form.models.map((model) => ({
    id: model.id,
    model: model.model,
    label: model.label,
    source: model.source,
    capabilities: cloneCapabilities(model.capabilities, model)
  })),
  ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {})
})

const logInput = (action: string, value: AiConnectionInput): void => {
  connectionLog(
    '%s start connectionId=%s protocol=%s endpoint=%s modelCount=%s modelIds=%s',
    action,
    value.id ?? 'new',
    value.protocol,
    value.endpoint,
    value.models.length,
    value.models.map((model) => model.id || model.model).join(',')
  )
}

const applySettings = (value: AiConnectionSettings): void => {
  settings.value = value
  editAgentMaxSteps.value = value.editAgentMaxSteps ?? 64
  failureOutputAfter.value = value.failureOutputAfter ?? 1
  contextMode.value = value.contextMode ?? 'recent'
  ai.setSettings(value)
  if (value.connections.some((connection) => connection.id === form.id)) { selectConnection(form.id as string) } else if (value.connections[0]) selectConnection(value.connections[0].id)
  else resetForm()
}

const saveEditAgentMaxSteps = async (): Promise<void> => {
  try {
    const value = await window.electron.ipcRenderer.invoke(
      'mt::ai::set-edit-agent-max-steps',
      editAgentMaxSteps.value
    )
    applySettings(value)
    statusOk.value = true
    status.value = chinese.value ? 'Agent 步骤上限已保存。' : 'Agent step limit saved.'
  } catch (err) {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
  }
}

const saveFailureOutputAfter = async (): Promise<void> => {
  try {
    const value = await window.electron.ipcRenderer.invoke(
      'mt::ai::set-failure-output-after',
      failureOutputAfter.value
    )
    applySettings(value)
    statusOk.value = true
    status.value = chinese.value ? '失败输出设置已保存。' : 'Failure output setting saved.'
  } catch (err) {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
  }
}

const saveContextMode = async (): Promise<void> => {
  try {
    const value = await window.electron.ipcRenderer.invoke('mt::ai::set-context-mode', contextMode.value)
    applySettings(value)
    statusOk.value = true
    status.value = chinese.value ? '上下文模式已保存。' : 'Context mode saved.'
  } catch (err) {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
  }
}

const save = async (): Promise<void> => {
  saving.value = true
  status.value = ''
  try {
    const value = input()
    logInput('save', value)
    const saved = await window.electron.ipcRenderer.invoke('mt::ai::save-connection', value)
    apiKey.value = ''
    applySettings(saved)
    statusOk.value = true
    status.value = chinese.value ? '连接已保存。' : 'Connection saved.'
    connectionLog(
      'save succeeded connectionId=%s modelCount=%s',
      saved.connections.find((connection) => connection.id === (value.id ?? ''))?.models.length ??
        value.models.length
    )
  } catch (err) {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
    connectionLog('save failed errorName=%s', err instanceof Error ? err.name : 'unknown')
  } finally {
    saving.value = false
  }
}

const test = async (): Promise<void> => {
  testing.value = true
  status.value = ''
  try {
    const value = input()
    logInput('test', value)
    const result = await window.electron.ipcRenderer.invoke('mt::ai::test-connection', value)
    statusOk.value = result.ok
    status.value = result.message
    connectionLog('test finished ok=%s', result.ok)
  } catch (err) {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
    connectionLog('test failed errorName=%s', err instanceof Error ? err.name : 'unknown')
  } finally {
    testing.value = false
  }
}

const refreshModels = async (): Promise<void> => {
  refreshing.value = true
  status.value = ''
  try {
    discoveredModels.value = await window.electron.ipcRenderer.invoke('mt::ai::list-models', {
      connectionId: form.id,
      protocol: form.protocol,
      endpoint: form.endpoint,
      ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {})
    })
    statusOk.value = true
    status.value = chinese.value ? '模型列表已刷新。' : 'Model list refreshed.'
  } catch (err) {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
  } finally {
    refreshing.value = false
  }
}

const hasModel = (model: string): boolean => form.models.some((item) => item.model.trim() === model)

const addModel = (): void => {
  form.models.push({ id: createId(), model: '', label: '', source: 'manual' })
}

const addDiscoveredModel = (model: AiDiscoveredModel): void => {
  if (hasModel(model.model)) return
  form.models.push({
    id: createId(),
    model: model.model,
    label: model.label || model.model,
    source: 'discovered'
  })
}

const removeModel = (id?: string): void => {
  form.models = form.models.filter((model) => model.id !== id)
}

const setDefault = async (): Promise<void> => {
  const model =
    form.models.find((item) => item.id === defaultModelId.value && item.model.trim()) ??
    form.models.find((item) => item.id && item.model.trim())
  if (!form.id || !model?.id) return
  try {
    const value = await ai.setDefaultModel({ connectionId: form.id, modelId: model.id })
    settings.value = value
    statusOk.value = true
    status.value = chinese.value ? '默认模型已更新。' : 'Default model updated.'
  } catch (err) {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
  }
}

const deleteKey = async (): Promise<void> => {
  if (!form.id) return
  try {
    const value = await window.electron.ipcRenderer.invoke('mt::ai::delete-connection-key', form.id)
    apiKey.value = ''
    applySettings(value)
    statusOk.value = true
    status.value = chinese.value ? '密钥已删除。' : 'Key deleted.'
  } catch (err) {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
  }
}

const deleteConnection = async (): Promise<void> => {
  if (!form.id) return
  if (!window.confirm(chinese.value ? '确定要删除这个 AI 连接吗？' : 'Delete this AI connection?')) { return }
  try {
    const value = await window.electron.ipcRenderer.invoke('mt::ai::delete-connection', form.id)
    applySettings(value)
    statusOk.value = true
    status.value = chinese.value ? '连接已删除。' : 'Connection deleted.'
  } catch (err) {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
  }
}

const load = async (): Promise<void> => {
  const value = await window.electron.ipcRenderer.invoke('mt::ai::get-settings')
  applySettings(value)
}

onMounted(() => {
  load().catch((err) => {
    statusOk.value = false
    status.value = err instanceof Error ? err.message : String(err)
  })
})
</script>

<style scoped>
.pref-ai {
  max-width: 980px;
}
.pref-ai .notes {
  max-width: 760px;
  line-height: 1.5;
}
.connection-toolbar {
  display: flex;
  justify-content: flex-end;
  margin: 18px 0;
}
.connection-layout {
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.connection-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.connection-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--floatBorderColor);
  border-radius: 5px;
  color: var(--editorColor);
  background: var(--editorBgColor);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.connection-card.active {
  border-color: var(--highlightThemeColor);
  box-shadow: 0 0 0 1px var(--highlightThemeColor);
}
.connection-card span,
.connection-card small {
  color: var(--editorColor60);
  font-size: 12px;
}
.connection-editor {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--floatBorderColor);
  border-radius: 6px;
}
.editor-heading,
.group-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.editor-heading h5 {
  margin: 0;
  color: var(--editorColor);
  font-size: 16px;
}
.ai-setting-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 20px 0;
  color: var(--editorColor);
}
.ai-setting-group label {
  font-size: 14px;
  font-weight: 600;
}
.ai-setting-group input,
.ai-setting-group select {
  box-sizing: border-box;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid var(--floatBorderColor);
  border-radius: 4px;
  background: var(--editorBgColor);
  color: var(--editorColor);
  font: inherit;
}
.ai-setting-group small {
  color: var(--editorColor60);
  font-size: 12px;
}
.model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 28px;
  gap: 6px;
  align-items: center;
}
.model-row + .model-row {
  margin-top: 7px;
}
.model-editor + .model-editor {
  margin-top: 10px;
}
.model-row input {
  min-width: 0;
}
.model-row button {
  height: 30px;
}
.responses-model-options {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 8px;
  padding: 7px 9px;
  border: 1px solid var(--floatBorderColor);
  border-radius: 4px;
}
.responses-model-options > label:first-child {
  color: var(--editorColor60);
  font-size: 12px;
}
.responses-model-options select {
  margin-top: 0;
}
.responses-model-options small {
  color: var(--editorColor50);
  font-size: 11px;
}
.model-advanced {
  margin-top: 6px;
  padding: 7px 9px;
  border: 1px solid var(--floatBorderColor);
  border-radius: 4px;
  color: var(--editorColor);
}
.model-advanced summary {
  cursor: pointer;
  font-size: 12px;
}
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 9px 0 6px;
  font-size: 12px;
}
.checkbox-row input {
  width: auto;
}
.request-preset-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 28px;
  gap: 6px;
  margin-top: 9px;
}
.request-preset-editor textarea {
  grid-column: 1 / -1;
  width: 100%;
  min-height: 84px;
  resize: vertical;
  font-family: var(--font-family-monospace);
  font-size: 12px;
}
.request-preset-error {
  grid-column: 1 / -1;
  color: var(--redColor);
}
.request-preset-editor input {
  min-width: 0;
}
.model-advanced select {
  margin-top: 8px;
}
.discovered-models {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin: 12px 0;
  color: var(--editorColor);
  font-size: 12px;
}
.discovered-model {
  padding: 5px 8px;
  border: 1px solid var(--floatBorderColor);
  border-radius: 4px;
  color: var(--editorColor);
  background: var(--editorBgColor);
  cursor: pointer;
  font: inherit;
}
.discovered-model:disabled {
  cursor: default;
  opacity: 0.55;
}
.ai-setting-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 28px;
}
.primary-button,
.secondary-button,
.danger-button,
.icon-danger {
  padding: 8px 14px;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.compact-button {
  padding: 5px 8px;
}
.primary-button {
  color: #fff;
  background: var(--highlightThemeColor);
}
.secondary-button {
  color: var(--editorColor);
  background: var(--floatHoverColor);
}
.danger-button {
  color: #b63131;
  background: transparent;
  border: 1px solid currentColor;
}
.icon-danger {
  padding: 3px 7px;
  color: #b63131;
  background: transparent;
  border: 1px solid currentColor;
}
button:disabled {
  cursor: default;
  opacity: 0.45;
}
.empty-state {
  padding: 18px;
  border: 1px dashed var(--floatBorderColor);
  color: var(--editorColor60);
}
.status {
  margin-top: 14px;
  color: var(--highlightThemeColor);
}
.status.failure {
  color: #c33;
}
@media (max-width: 760px) {
  .connection-layout {
    grid-template-columns: 1fr;
  }
  .connection-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
}
</style>
