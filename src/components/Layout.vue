<template>
  <n-layout class="layout-container">
    <!-- 顶部栏 -->
    <n-layout-header bordered style="height: 64px; padding: 16px">
      <n-space justify="space-between" align="center">
        <n-h2>G-Code 3D 可视化动画器</n-h2>
        <n-space>
          <n-button
            type="primary"
            ghost
            @click="showEditor = !showEditor"
          >
            <template #icon>
              <n-icon><edit-outlined /></n-icon>
            </template>
            {{ showEditor ? '隐藏编辑器' : '显示编辑器' }}
          </n-button>
          <n-upload
            accept=".gcode"
            :show-file-list="false"
            @change="handleFileUpload"
          >
            <n-button type="primary">
              <template #icon>
                <n-icon><upload-outlined /></n-icon>
              </template>
              上传 G-Code 文件
            </n-button>
          </n-upload>
        </n-space>
      </n-space>
    </n-layout-header>

    <!-- 主内容区域 -->
    <n-layout-content class="content-container">
      <n-grid :cols="24" :x-gap="16" class="grid-container">
        <n-grid-item :span="showEditor ? 8 : 0" class="editor-item">
          <GCodeEditor
            v-if="showEditor"
            ref="editorRef"
            class="editor-container"
          />
        </n-grid-item>
        <n-grid-item :span="showEditor ? 16 : 24" class="viewer-item">
          <GCodeViewer class="viewer-container" />
        </n-grid-item>
      </n-grid>
    </n-layout-content>
  </n-layout>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import {
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NSpace,
  NButton,
  NUpload,
  NIcon,
  NH2,
  NGrid,
  NGridItem,
  type UploadFileInfo
} from 'naive-ui'
import { UploadOutlined, EditOutlined } from '@vicons/antd'
import GCodeEditor from './GCodeEditor.vue'
import GCodeViewer from './GCodeViewer.vue'

const showEditor = ref(false)
const editorRef = ref<InstanceType<typeof GCodeEditor> | null>(null)

// 处理文件上传
const handleFileUpload = async (options: { file: UploadFileInfo; fileList: UploadFileInfo[] }) => {
  const { file } = options
  try {
    const content = await file.file?.text()
    if (content && editorRef.value) {
      editorRef.value.setContent(content)
      showEditor.value = true
    }
  } catch (error) {
    console.error('读取文件失败:', error)
  }
}
</script>

<style scoped>
.layout-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.n-layout-header {
  background: #fff;
  flex-shrink: 0;
  z-index: 1;
}

.content-container {
  background: #fff;
  flex: 1;
  min-height: 0;
  padding: 16px;
  overflow: hidden;
}

.grid-container {
  height: 100%;
  overflow: hidden;
}

.editor-item,
.viewer-item {
  height: 100%;
  overflow: hidden;
}

.editor-container {
  height: 100%;
  overflow: hidden;
}

.viewer-container {
  height: 100%;
  background: #f5f5f5;
  border-radius: 4px;
  overflow: hidden;
}

.n-button {
  margin-left: 8px;
}
</style> 