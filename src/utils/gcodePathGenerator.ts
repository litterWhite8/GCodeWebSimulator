import type { GCodeCommand } from './gcodeParser'
import * as THREE from 'three'

// 移动类型定义
type MoveType = 'G0' | 'G1' | 'G2' | 'G3'

// 轨迹点类型定义
export interface PathPoint {
  position: THREE.Vector3
  type: MoveType
  feedrate?: number
  extrusion?: number
  lineNumber: number
  params?: {
    I?: number
    J?: number
    K?: number
    F?: number
  }
}

// 路径段类型定义
export interface PathSegment {
  points: PathPoint[]
  type: MoveType
  isExtruding: boolean
}

// 路径生成器类
export class GCodePathGenerator {
  private currentPosition: THREE.Vector3
  private currentExtrusion: number
  private isAbsolutePositioning: boolean
  private isAbsoluteExtrusion: boolean
  private segments: PathSegment[]
  private currentSegment: PathSegment | null
  private currentFeedrate: number

  constructor() {
    this.currentPosition = new THREE.Vector3(0, 0, 0)
    this.currentExtrusion = 0
    this.isAbsolutePositioning = true
    this.isAbsoluteExtrusion = true
    this.segments = []
    this.currentSegment = null
    this.currentFeedrate = 0
  }

  // 输出轨迹点信息到控制台
  public debugPrintPath() {
    console.group('G-code 轨迹点信息')
    console.log(`总段数: ${this.segments.length}`)
    
    this.segments.forEach((segment, segmentIndex) => {
      console.group(`段 ${segmentIndex + 1} (${segment.type}, ${segment.isExtruding ? '挤出' : '空走'})`)
      console.log(`点数: ${segment.points.length}`)
      
      segment.points.forEach((point, pointIndex) => {
        console.log(
          `点 ${pointIndex + 1}: ` +
          `位置(${point.position.x.toFixed(2)}, ${point.position.y.toFixed(2)}, ${point.position.z.toFixed(2)}) ` +
          `类型:${point.type} ` +
          `速度:${point.feedrate?.toFixed(2) || 'N/A'} ` +
          `挤出:${point.extrusion?.toFixed(2) || 'N/A'} ` +
          `行号:${point.lineNumber}`
        )
      })
      
      console.groupEnd()
    })
    
    console.groupEnd()
  }

  // 生成路径
  public generatePath(commands: GCodeCommand[]): PathSegment[] {
    this.reset()
    
    for (const command of commands) {
      this.processCommand(command)
    }

    // 确保最后一个段被添加
    const lastSegment = this.currentSegment
    if (lastSegment && lastSegment.points.length > 0) {
      this.segments.push(lastSegment)
    }

    // 输出调试信息
    // this.debugPrintPath()

    return this.segments
  }

  // 重置状态
  private reset() {
    this.currentPosition.set(0, 0, 0)
    this.currentExtrusion = 0
    this.isAbsolutePositioning = true
    this.isAbsoluteExtrusion = true
    this.segments = []
    this.currentSegment = null
    this.currentFeedrate = 0
  }

  // 处理单个指令
  private processCommand(command: GCodeCommand) {
    switch (command.type) {
      case 'G0':
      case 'G1':
        this.processLinearMove(command)
        break
      case 'G2':
      case 'G3':
        this.processArcMove(command)
        break
      case 'G90':
        this.isAbsolutePositioning = true
        break
      case 'G91':
        this.isAbsolutePositioning = false
        break
      case 'G28':
        this.processHomeMove(command)
        break
    }

    // 更新进给速度
    if (command.params.F !== undefined) {
      this.currentFeedrate = command.params.F
    }
  }

  // 处理线性移动（G0/G1）
  private processLinearMove(command: GCodeCommand) {
    const newPosition = this.calculateNewPosition(command)
    const newExtrusion = this.calculateNewExtrusion(command)
    const isExtruding = newExtrusion > this.currentExtrusion

    // 创建新的路径点
    const point: PathPoint = {
      position: newPosition.clone(),
      type: command.type as MoveType,
      feedrate: this.currentFeedrate,
      extrusion: newExtrusion,
      lineNumber: command.lineNumber
    }

    // 检查是否需要创建新的段
    const currentSegment = this.currentSegment
    if (!currentSegment || 
        currentSegment.type !== command.type || 
        currentSegment.isExtruding !== isExtruding) {
      // 保存当前段
      if (currentSegment && currentSegment.points.length > 0) {
        this.segments.push(currentSegment)
      }
      // 创建新段
      this.currentSegment = {
        points: [],
        type: command.type as MoveType,
        isExtruding
      }
    }

    // 添加点到当前段
    if (this.currentSegment) {
      this.currentSegment.points.push(point)
    }

    // 更新当前位置和挤出量
    this.currentPosition.copy(newPosition)
    this.currentExtrusion = newExtrusion
  }

  // 处理圆弧移动（G2/G3）
  private processArcMove(command: GCodeCommand) {
    // 获取当前点作为起点
    const startPosition = this.currentPosition.clone()
    
    // 计算终点坐标，如果某个轴没有指定，则使用当前位置
    const endPosition = new THREE.Vector3(
      command.params.X !== undefined ? (this.isAbsolutePositioning ? command.params.X : startPosition.x + command.params.X) : startPosition.x,
      command.params.Y !== undefined ? (this.isAbsolutePositioning ? command.params.Y : startPosition.y + command.params.Y) : startPosition.y,
      command.params.Z !== undefined ? (this.isAbsolutePositioning ? command.params.Z : startPosition.z + command.params.Z) : startPosition.z
    )

    // 如果 X 和 Y 都没有变化，则跳过
    if (endPosition.x === startPosition.x && endPosition.y === startPosition.y) {
      console.warn('圆弧移动起点和终点相同，跳过', command)
      return
    }

    // 计算中心点（I、J、K 是相对于起点的偏移量）
    const center = new THREE.Vector3(
      startPosition.x + (command.params.I || 0),
      startPosition.y + (command.params.J || 0),
      startPosition.z + (command.params.K || 0)
    )

    // 验证中心点和半径
    const radius = center.distanceTo(startPosition)
    if (radius < 0.001) {
      console.error('无效的弧线参数：', {
        command,
        startPosition,
        endPosition,
        center,
        radius,
        params: command.params
      })
      return
    }

    const newExtrusion = this.calculateNewExtrusion(command)
    const isExtruding = newExtrusion > this.currentExtrusion

    // 创建弧线参数对象
    const arcParams = {
      I: command.params.I,
      J: command.params.J,
      K: command.params.K
    }

    // 检查是否需要创建新的段
    const currentSegment = this.currentSegment
    if (!currentSegment || 
        currentSegment.type !== command.type || 
        currentSegment.isExtruding !== isExtruding) {
      // 保存当前段
      if (currentSegment && currentSegment.points.length > 0) {
        this.segments.push(currentSegment)
      }
      // 创建新段
      this.currentSegment = {
        points: [],
        type: command.type as MoveType,
        isExtruding
      }
    }

    // 添加点到当前段
    if (this.currentSegment) {
      // 如果当前段为空，添加起点
      if (this.currentSegment.points.length === 0) {
        const startPoint: PathPoint = {
          position: startPosition.clone(),
          type: command.type as MoveType,
          feedrate: this.currentFeedrate,
          extrusion: this.currentExtrusion,
          lineNumber: command.lineNumber,
          params: arcParams
        }
        this.currentSegment.points.push(startPoint)
      } else {
        // 如果当前段不为空，更新最后一个点的参数
        const lastPoint = this.currentSegment.points[this.currentSegment.points.length - 1]
        if (lastPoint) {
          lastPoint.params = arcParams
        }
      }

      // 添加终点
      const endPoint: PathPoint = {
        position: endPosition.clone(),
        type: command.type as MoveType,
        feedrate: this.currentFeedrate,
        extrusion: newExtrusion,
        lineNumber: command.lineNumber,
        params: arcParams // 终点也包含相同的参数
      }
      this.currentSegment.points.push(endPoint)
      
      // 输出调试信息
      console.log('添加弧线点:', {
        segmentType: command.type,
        startPoint: {
          x: startPosition.x.toFixed(2),
          y: startPosition.y.toFixed(2),
          z: startPosition.z.toFixed(2),
          params: arcParams
        },
        endPoint: {
          x: endPosition.x.toFixed(2),
          y: endPosition.y.toFixed(2),
          z: endPosition.z.toFixed(2),
          params: arcParams
        },
        center: {
          x: center.x.toFixed(2),
          y: center.y.toFixed(2),
          z: center.z.toFixed(2)
        },
        radius: radius.toFixed(2),
        isExtruding,
        feedrate: this.currentFeedrate,
        segmentPoints: this.currentSegment.points.length,
        currentSegmentIndex: this.segments.length,
        lastPointParams: this.currentSegment.points[this.currentSegment.points.length - 1]?.params
      })
    }

    // 更新当前位置和挤出量
    this.currentPosition.copy(endPosition)
    this.currentExtrusion = newExtrusion
  }

  // 处理回零移动（G28）
  private processHomeMove(command: GCodeCommand) {
    const homePosition = new THREE.Vector3(0, 0, 0)
    
    // 如果指定了坐标，则只移动指定的轴
    if (command.params.X !== undefined) homePosition.x = 0
    if (command.params.Y !== undefined) homePosition.y = 0
    if (command.params.Z !== undefined) homePosition.z = 0

    const point: PathPoint = {
      position: homePosition,
      type: 'G0',
      feedrate: this.currentFeedrate,
      lineNumber: command.lineNumber
    }

    // 创建新的段
    const currentSegment = this.currentSegment
    if (currentSegment && currentSegment.points.length > 0) {
      this.segments.push(currentSegment)
    }

    this.currentSegment = {
      points: [point],
      type: 'G0',
      isExtruding: false
    }

    // 更新当前位置
    this.currentPosition.copy(homePosition)
  }

  // 计算新位置
  private calculateNewPosition(command: GCodeCommand): THREE.Vector3 {
    const newPosition = this.currentPosition.clone()
    
    if (this.isAbsolutePositioning) {
      if (command.params.X !== undefined) newPosition.x = command.params.X
      if (command.params.Y !== undefined) newPosition.y = command.params.Y
      if (command.params.Z !== undefined) newPosition.z = command.params.Z
    } else {
      if (command.params.X !== undefined) newPosition.x += command.params.X
      if (command.params.Y !== undefined) newPosition.y += command.params.Y
      if (command.params.Z !== undefined) newPosition.z += command.params.Z
    }

    return newPosition
  }

  // 计算新挤出量
  private calculateNewExtrusion(command: GCodeCommand): number {
    if (command.params.E === undefined) {
      return this.currentExtrusion
    }

    if (this.isAbsoluteExtrusion) {
      return command.params.E
    } else {
      return this.currentExtrusion + command.params.E
    }
  }
} 