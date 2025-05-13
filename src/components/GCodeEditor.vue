<template>
  <n-card title="G-code 编辑器" class="gcode-editor">
    <template #header-extra>
      <n-space>
        <n-button
          type="primary"
          size="small"
          @click="handleParse"
          :loading="isParsing"
          :disabled="!editorContent"
        >
          解析并预览
        </n-button>
        <n-button
          size="small"
          @click="handleClear"
          :disabled="!editorContent"
        >
          清空
        </n-button>
      </n-space>
    </template>

    <n-input
      v-model:value="editorContent"
      type="textarea"
      :autosize="{ minRows: 10, maxRows: 20 }"
      placeholder="在此输入 G-code 内容..."
      :style="{ fontFamily: 'monospace' }"
      @update:value="handleContentChange"
    />

    <template #footer>
      <n-space vertical>
        <n-space justify="space-between">
          <n-text depth="3">
            支持直接输入或粘贴 G-code 内容
          </n-text>
          <n-text depth="3">
            行数: {{ lineCount }}
          </n-text>
        </n-space>

        <n-collapse-transition>
          <div v-if="validationErrors.length > 0" class="error-list">
            <n-alert type="error" title="解析错误">
              <n-list size="small">
                <n-list-item v-for="error in validationErrors" :key="error">
                  {{ error }}
                </n-list-item>
              </n-list>
            </n-alert>
          </div>
        </n-collapse-transition>

        <n-collapse-transition>
          <div v-if="parseResult" class="parse-stats">
            <n-descriptions label-placement="left" size="small" bordered>
              <n-descriptions-item label="总行数">
                {{ stats.totalLines }}
              </n-descriptions-item>
              <n-descriptions-item label="有效指令">
                {{ stats.validCommands }}
              </n-descriptions-item>
              <n-descriptions-item label="X 范围">
                {{ stats.minX.toFixed(2) }} - {{ stats.maxX.toFixed(2) }}
              </n-descriptions-item>
              <n-descriptions-item label="Y 范围">
                {{ stats.minY.toFixed(2) }} - {{ stats.maxY.toFixed(2) }}
              </n-descriptions-item>
              <n-descriptions-item label="Z 范围">
                {{ stats.minZ.toFixed(2) }} - {{ stats.maxZ.toFixed(2) }}
              </n-descriptions-item>
            </n-descriptions>
          </div>
        </n-collapse-transition>
      </n-space>
    </template>
  </n-card>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  NCard,
  NInput,
  NButton,
  NSpace,
  NText,
  NAlert,
  NList,
  NListItem,
  NDescriptions,
  NDescriptionsItem,
  NCollapseTransition
} from 'naive-ui'
import { useGCodeStore } from '../stores/gcode'

const store = useGCodeStore()
const editorContent = ref('')

// 计算行数
const lineCount = computed(() => {
  if (!editorContent.value) return 0
  return editorContent.value.split('\n').length
})

// 从 store 获取状态
const isParsing = computed(() => store.isParsing)
const validationErrors = computed(() => store.validationErrors)
const parseResult = computed(() => store.parseResult)
const stats = computed(() => store.stats)

// 处理内容变化
const handleContentChange = (value: string) => {
  store.setContent(value)
}

// 解析 G-code
const handleParse = async () => {
  if (!editorContent.value) return
  await store.parseContent()
}

// 清空编辑器
const handleClear = () => {
  editorContent.value = ''
  store.clearContent()
}

// 监听 store 的内容变化
watch(() => store.rawContent, (newContent) => {
  if (newContent !== editorContent.value) {
    editorContent.value = newContent
  }
})

// 暴露方法给父组件
defineExpose({
  setContent: (content: string) => {
    editorContent.value = content
    store.setContent(content)
  },
  getContent: () => editorContent.value
})
</script>

<style scoped>
.gcode-editor {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.gcode-editor :deep(.n-card-header) {
  padding: 12px 16px;
}

.gcode-editor :deep(.n-card__content) {
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.gcode-editor :deep(.n-input) {
  flex: 1;
}

.gcode-editor :deep(.n-card__footer) {
  padding: 8px 16px;
}

.error-list {
  margin-top: 8px;
}

.parse-stats {
  margin-top: 8px;
}

.parse-stats :deep(.n-descriptions) {
  --n-table-border-color: #eee;
}
</style> 