// G-code 指令类型定义
interface GCodeCommand {
  type: 'G0' | 'G1' | 'G2' | 'G3' | 'G28' | 'G90' | 'G91' | 'G40' | 'G17' | 'G71' | 'G43' | 'M104' | 'M140' | 'M106' | 'M107' | 'M03' | 'M06' | 'T' | 'OTHER'
  lineNumber: number
  nNumber?: number  // 添加 N 行号支持
  params: {
    X?: number
    Y?: number
    Z?: number
    E?: number
    F?: number
    S?: number
    P?: number
    M?: number
    T?: number
    H?: number  // 添加 H 参数支持
    I?: number  // 添加圆弧插补参数
    J?: number
    K?: number
    R?: number  // 添加圆弧半径参数
    [key: string]: number | undefined
  }
  raw: string
}

// 解析结果类型定义
interface ParseResult {
  commands: GCodeCommand[]
  stats: {
    totalLines: number
    validCommands: number
    maxX: number
    maxY: number
    maxZ: number
    minX: number
    minY: number
    minZ: number
  }
}

// 解析单个 G-code 指令
function parseCommand(line: string, lineNumber: number): GCodeCommand | null {
  // 移除注释和空白
  const cleanLine = line.split(';')[0].trim()
  if (!cleanLine) return null

  // 分割指令和参数
  const parts = cleanLine.split(/\s+/)
  const params: GCodeCommand['params'] = {}
  let nNumber: number | undefined
  let commandType = 'OTHER'

  // 处理每个部分
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toUpperCase()
    
    // 处理 N 行号
    if (part.startsWith('N')) {
      nNumber = parseInt(part.slice(1))
      continue
    }

    // 处理指令和参数
    const param = part[0]
    const valueStr = part.slice(1)
    const value = valueStr.includes('.') ? parseFloat(valueStr) : parseInt(valueStr)
    
    if (!isNaN(value)) {
      if (param === 'G' || param === 'M' || param === 'T') {
        // 处理 G、M 和 T 指令
        const code = parseInt(part.slice(1))
        if (param === 'G') {
          if (code === 0) commandType = 'G0'
          else if (code === 1) commandType = 'G1'
          else if (code === 2) commandType = 'G2'  // 添加 G2 支持
          else if (code === 3) commandType = 'G3'  // 添加 G3 支持
          else if (code === 28) commandType = 'G28'
          else if (code === 90) commandType = 'G90'
          else if (code === 91) commandType = 'G91'
          else if (code === 40) commandType = 'G40'
          else if (code === 17) commandType = 'G17'
          else if (code === 71) commandType = 'G71'
          else if (code === 43) commandType = 'G43'
        } else if (param === 'M') {
          if (code === 3) commandType = 'M03'
          else if (code === 6) commandType = 'M06'
          else if (code === 104) commandType = 'M104'
          else if (code === 140) commandType = 'M140'
          else if (code === 106) commandType = 'M106'
          else if (code === 107) commandType = 'M107'
        } else if (param === 'T') {
          commandType = 'T'
        }
        params[param] = code
      } else if (['X', 'Y', 'Z', 'E', 'F', 'H', 'S', 'I', 'J', 'K', 'R'].includes(param)) {
        // 处理坐标、圆弧插补和其他参数
        params[param] = value
        // 如果是坐标参数且没有指定 G 指令，默认为 G1
        if (['X', 'Y', 'Z', 'E'].includes(param) && !params['G']) {
          commandType = 'G1'
          params['G'] = 1
        }
      }
    }
  }

  return {
    type: commandType as GCodeCommand['type'],
    lineNumber,
    nNumber,
    params,
    raw: line
  }
}

// 解析 G-code 内容
function parseGCode(content: string): ParseResult {
  const lines = content.split('\n')
  const commands: GCodeCommand[] = []
  let validCommands = 0
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let minX = Infinity, minY = Infinity, minZ = Infinity

  lines.forEach((line, index) => {
    const command = parseCommand(line, index + 1)
    if (command) {
      commands.push(command)
      validCommands++

      // 更新坐标范围
      const { X, Y, Z } = command.params
      if (X !== undefined) {
        maxX = Math.max(maxX, X)
        minX = Math.min(minX, X)
      }
      if (Y !== undefined) {
        maxY = Math.max(maxY, Y)
        minY = Math.min(minY, Y)
      }
      if (Z !== undefined) {
        maxZ = Math.max(maxZ, Z)
        minZ = Math.min(minZ, Z)
      }
    }
  })

  return {
    commands,
    stats: {
      totalLines: lines.length,
      validCommands,
      maxX: maxX === -Infinity ? 0 : maxX,
      maxY: maxY === -Infinity ? 0 : maxY,
      maxZ: maxZ === -Infinity ? 0 : maxZ,
      minX: minX === Infinity ? 0 : minX,
      minY: minY === Infinity ? 0 : minY,
      minZ: minZ === Infinity ? 0 : minZ
    }
  }
}

// 验证 G-code 内容
function validateGCode(content: string): { isValid: boolean; errors: string[] } {
  const errors: string[] = []
  const lines = content.split('\n')

  lines.forEach((line, index) => {
    const cleanLine = line.split(';')[0].trim()
    if (!cleanLine) return

    // 检查基本语法
    const linePattern = /^(N\d+\s+)?(.+)$/
    const match = cleanLine.match(linePattern)
    
    if (!match) {
      errors.push(`第 ${index + 1} 行: 语法错误 "${cleanLine}"`)
      return
    }

    // 获取指令部分（去除 N 行号后的内容）
    const instructionPart = match[2]
    
    // 检查指令部分是否只包含有效的参数
    const parts = instructionPart.split(/\s+/)
    let hasValidContent = false

    for (const part of parts) {
      // 检查每个部分是否符合 G-code 参数格式
      if (/^[GMT]\d+$/.test(part) || /^[XYZEFHSIJKR][-+]?\d*\.?\d*$/.test(part)) {
        hasValidContent = true
      } else {
        errors.push(`第 ${index + 1} 行: 无效的指令或参数 "${part}"`)
        return
      }
    }

    if (!hasValidContent) {
      errors.push(`第 ${index + 1} 行: 缺少有效的指令或参数 "${cleanLine}"`)
    }
  })

  return {
    isValid: errors.length === 0,
    errors
  }
}

// 导出所有需要的类型和函数
export type { GCodeCommand, ParseResult }
export { parseGCode, validateGCode } 