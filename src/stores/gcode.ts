import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { parseGCode, validateGCode, type GCodeCommand, type ParseResult } from '../utils/gcodeParser'
import { GCodePathGenerator } from '../utils/gcodePathGenerator'

export const useGCodeStore = defineStore('gcode', () => {
  // 状态
  const rawContent = ref('')
  const parseResult = ref<ParseResult | null>(null)
  const validationErrors = ref<string[]>([])
  const isParsing = ref(false)

  // 计算属性
  const isValid = computed(() => validationErrors.value.length === 0)
  const stats = computed(() => parseResult.value?.stats ?? {
    totalLines: 0,
    validCommands: 0,
    maxX: 0,
    maxY: 0,
    maxZ: 0,
    minX: 0,
    minY: 0,
    minZ: 0
  })

  // 动作
  function setContent(content: string) {
    rawContent.value = content
    validateContent()
  }

  function validateContent() {
    const result = validateGCode(rawContent.value)
    validationErrors.value = result.errors
    return result.isValid
  }

  async function parseContent() {
    if (!rawContent.value) return null
    
    isParsing.value = true
    try {
      // 使用 setTimeout 让 UI 有机会更新
      await new Promise(resolve => setTimeout(resolve, 0))
      
      if (!validateContent()) {
        return null
      }

      parseResult.value = parseGCode(rawContent.value)
      
      // 生成路径并输出到控制台
      if (parseResult.value) {
        const generator = new GCodePathGenerator()
        generator.generatePath(parseResult.value.commands)
      }

      return parseResult.value
    } finally {
      isParsing.value = false
    }
  }

  function clearContent() {
    rawContent.value = ''
    parseResult.value = null
    validationErrors.value = []
  }

  return {
    // 状态
    rawContent,
    parseResult,
    validationErrors,
    isParsing,
    
    // 计算属性
    isValid,
    stats,
    
    // 动作
    setContent,
    validateContent,
    parseContent,
    clearContent
  }
}) 