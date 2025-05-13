<template>
  <div class="gcode-viewer" ref="containerRef">
    <canvas ref="canvasRef"></canvas>
    <div v-if="isProcessing" class="processing-overlay">
      <n-spin size="large" />
      <div class="processing-text">正在处理路径...</div>
    </div>
    <div v-if="!isProcessing && hasPath" class="animation-controls">
      <n-space vertical>
        <n-space>
          <n-button @click="togglePlay" :type="isPlaying ? 'warning' : 'primary'">
            {{ isPlaying ? '暂停' : '播放' }}
          </n-button>
          <n-button @click="resetAnimation" :disabled="isPlaying">
            重置
          </n-button>
          <n-button @click="toggleLayerView" :type="showLayers ? 'primary' : 'default'">
            {{ showLayers ? '隐藏层' : '显示层' }}
          </n-button>
        </n-space>
        <n-space>
          <n-text>速度：</n-text>
          <n-slider
            v-model:value="playbackSpeed"
            :min="MIN_SPEED"
            :max="MAX_SPEED"
            :step="100"
            style="width: 200px"
            @update:value="handleSpeedChange"
          />
          <n-text>{{ playbackSpeed }} mm/min</n-text>
        </n-space>
        <n-space>
          <n-text>当前坐标：</n-text>
          <n-text>X: {{ currentPosition.x.toFixed(2) }}</n-text>
          <n-text>Y: {{ currentPosition.y.toFixed(2) }}</n-text>
          <n-text>Z: {{ currentPosition.z.toFixed(2) }}</n-text>
        </n-space>
        <n-space>
          <n-text>当前速度：</n-text>
          <n-text>{{ currentSpeed.toFixed(0) }} mm/min</n-text>
        </n-space>
        <n-space>
          <n-text>当前层高：</n-text>
          <n-text>{{ currentLayer.toFixed(2) }} mm</n-text>
        </n-space>
        <n-space v-if="showLayers">
          <n-text>层高：</n-text>
          <n-slider
            v-model:value="layerHeight"
            :min="0.1"
            :max="1"
            :step="0.1"
            style="width: 100px"
            @update:value="updateLayerVisibility"
          />
          <n-text>mm</n-text>
        </n-space>
      </n-space>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick, computed } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { useGCodeStore } from '../stores/gcode'
import { GCodePathGenerator } from '../utils/gcodePathGenerator'
import type { PathSegment } from '../utils/gcodePathGenerator'
import { NSpin, NSpace, NButton, NSlider, NText } from 'naive-ui'

const store = useGCodeStore()
const containerRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const isProcessing = ref(false)
const isPlaying = ref(false)
const animationProgress = ref(0)
const playbackSpeed = ref(10000)
const hasPath = ref(false)

// 动画相关变量
let animationStartTime = 0
let currentSegmentIndex = 0
let currentPointIndex = 0
let parsedSegments: PathSegment[] = []
let animationFrameId: number | null = null
let lastUpdateTime = 0
const MIN_UPDATE_INTERVAL = 32 // 约30fps
const TARGET_ANIMATION_DURATION = 30 // 目标动画时长（秒）
const MIN_SPEED = 50 // 最小速度（mm/min）
const MAX_SPEED = ref(100000) // 设置一个非常大的最大速度，实际上不会用到
const DEFAULT_SPEED = 10000 // 默认速度（mm/min）

// Three.js 相关变量
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let renderer: THREE.WebGLRenderer | null = null
let controls: OrbitControls | null = null
let pathLines: THREE.Group | null = null
let toolHead: THREE.Mesh | null = null
let modelGroup: THREE.Group | null = null
let isInitialized = false

// 性能优化相关
const BATCH_SIZE = 100
const FRAME_RATE = 60 // 每秒60帧
const FRAME_TIME = 1000 / FRAME_RATE // 每帧时间（毫秒）
let lastFrameTime = 0
let pendingSegments: PathSegment[] = []
let currentBatchIndex = 0

// 动画状态变量
const currentPosition = ref({ x: 0, y: 0, z: 0 })
const currentSpeed = ref(0)
const currentLayer = ref(0)
const showLayers = ref(false)
const layerHeight = ref(0.2)
const layerGroups = new Map<number, THREE.Group>()

// 模型构建相关变量
let currentLine: THREE.Line | null = null
let currentLinePoints: THREE.Vector3[] = []
let extrudedSegments: THREE.Mesh[] = []
const lineWidth = 0.4 // 线宽（毫米）

// 添加新的状态变量
const pendingArcs = new Map<string, THREE.Mesh>() // 存储预加载的弧线
const visibleArcs = new Set<string>() // 存储已显示的弧线
let arcGenerationQueue: { segmentIndex: number, pointIndex: number }[] = []

// 修改状态变量
let currentArcProgress = 0
let currentArcCurve: THREE.CubicBezierCurve3 | null = null
let currentArcLength = 0
let isMoving = false

// 添加新的状态变量
let lastMoveTime = 0
let stuckCount = 0
const STUCK_THRESHOLD = 10 // 连续10次检测到卡住就强制移动
const MIN_MOVE_DISTANCE = 0.1 // 最小移动距离阈值

// 移除帧点相关的状态变量
const framePoints: THREE.Points | null = null
const framePointsMaterial = new THREE.PointsMaterial({
  color: 0x0000ff,
  size: 1,
  sizeAttenuation: true
})

// 添加动画帧的类型定义
interface AnimationFrame {
  position: THREE.Vector3
  segmentIndex: number
  pointIndex: number
  time: number
}

// 修改PathPoint接口
interface PathPoint {
  position: THREE.Vector3
  params: {
    I?: number
    J?: number
    K?: number
    F?: number
  }
}

// 只保留一组响应式状态声明，并确保它们只声明一次
const state = {
  animationFrames: ref<AnimationFrame[]>([]),
  currentFrameIndex: ref(0),
  animationStartTime: ref(0),
  currentSegmentIndex: ref(0),
  currentPointIndex: ref(0),
  parsedSegments: ref<PathSegment[]>([])
}

// 添加调试日志函数
const logMovement = (message: string, data?: any) => {
  console.log(`[Movement] ${message}`, data || '')
}

// 修改计算动画帧的函数
const calculateAnimationFrames = (segments: PathSegment[]): AnimationFrame[] => {
  if (!segments.length) {
    console.warn('没有路径段数据')
    return []
  }

  const frames: AnimationFrame[] = []
  const speedInMmPerSecond = playbackSpeed.value / 60
  let currentTime = 0
  let lastPosition: THREE.Vector3 | null = null

  console.log('开始计算动画帧，总段数:', segments.length)

  segments.forEach((segment, segmentIndex) => {
    // 添加更详细的日志
    console.log('处理路径段:', {
      segmentIndex,
      type: segment.type,
      pointsCount: segment.points?.length,
      isExtruding: segment.isExtruding,
      lastPosition: lastPosition ? { x: lastPosition.x, y: lastPosition.y, z: lastPosition.z } : null
    })

    // 验证路径段
    if (!segment.points || !Array.isArray(segment.points)) {
      console.warn('无效的路径段数据:', { 
        segmentIndex, 
        segmentType: segment.type,
        hasPoints: !!segment.points,
        isArray: Array.isArray(segment.points)
      })
      return
    }

    // 处理不同类型的移动命令
    if (segment.type === 'G0' || segment.type === 'G1' || segment.type === 'G2' || segment.type === 'G3') {
      // 对于单点段，使用上一个位置作为起点
      if (segment.points.length === 1) {
        if (!lastPosition) {
          // 如果是第一个点，保存位置并继续
          lastPosition = segment.points[0].position.clone()
          frames.push({
            position: lastPosition.clone(),
            segmentIndex,
            pointIndex: 0,
            time: currentTime
          })
          console.log('保存第一个点:', {
            segmentIndex,
            position: { x: lastPosition.x, y: lastPosition.y, z: lastPosition.z }
          })
          return
        }

        // 使用上一个位置作为起点，当前点作为终点
        const p1 = { position: lastPosition.clone() }
        const p2 = segment.points[0]

        try {
          let segmentLength = 0

          if (segment.type === 'G2' || segment.type === 'G3') {
            // 弧线
            const isClockwise = segment.type === 'G2'
            const i = p2.params?.I ?? 0
            const j = p2.params?.J ?? 0
            const center = new THREE.Vector3(
              p1.position.x + i,
              p1.position.y + j,
              p1.position.z
            )

            // 计算圆弧参数
            const radius = p1.position.distanceTo(center)
            const startAngle = Math.atan2(
              p1.position.y - center.y,
              p1.position.x - center.x
            )
            const endAngle = Math.atan2(
              p2.position.y - center.y,
              p2.position.x - center.x
            )

            // 确定旋转方向
            let angleDiff = endAngle - startAngle
            if (isClockwise) { // G2 顺时针
              if (angleDiff >= 0) angleDiff -= Math.PI * 2
            } else { // G3 逆时针
              if (angleDiff <= 0) angleDiff += Math.PI * 2
            }

            // 创建圆弧曲线
            const arcCurve = new THREE.EllipseCurve(
              center.x, center.y,
              radius, radius,
              startAngle, startAngle + angleDiff,
              isClockwise,
              0
            )

            // 计算弧长
            const numPoints = Math.max(50, Math.ceil(Math.abs(angleDiff) * radius * 2))
            const points = arcCurve.getPoints(numPoints)
            segmentLength = 0
            for (let i = 1; i < points.length; i++) {
              segmentLength += points[i].distanceTo(points[i - 1])
            }

            // 创建帧
            const numFrames = Math.max(50, Math.ceil(segmentLength * 2))
            const frameTime = segmentLength / speedInMmPerSecond / numFrames

            for (let i = 0; i <= numFrames; i++) {
              const t = i / numFrames
              const point = arcCurve.getPoint(t)
              const z = p1.position.z + (p2.position.z - p1.position.z) * t

              frames.push({
                position: new THREE.Vector3(point.x, point.y, z),
                segmentIndex,
                pointIndex: 0,
                time: currentTime + frameTime * i
              })
            }

            currentTime += segmentLength / speedInMmPerSecond
            lastPosition = new THREE.Vector3(p2.position.x, p2.position.y, p2.position.z)

            console.log('生成单点弧线帧:', {
              segmentIndex,
              type: segment.type,
              numFrames,
              segmentLength,
              startAngle: startAngle * 180 / Math.PI,
              endAngle: (startAngle + angleDiff) * 180 / Math.PI,
              radius,
              center: { x: center.x, y: center.y, z: center.z }
            })
          } else {
            // 直线
            segmentLength = p1.position.distanceTo(p2.position)
            const numFrames = Math.max(10, Math.ceil(segmentLength * 2))
            const frameTime = segmentLength / speedInMmPerSecond / numFrames

            for (let i = 0; i <= numFrames; i++) {
              const t = i / numFrames
              frames.push({
                position: new THREE.Vector3(
                  p1.position.x + (p2.position.x - p1.position.x) * t,
                  p1.position.y + (p2.position.y - p1.position.y) * t,
                  p1.position.z + (p2.position.z - p1.position.z) * t
                ),
                segmentIndex,
                pointIndex: 0,
                time: currentTime + frameTime * i
              })
            }

            currentTime += segmentLength / speedInMmPerSecond
            lastPosition = new THREE.Vector3(p2.position.x, p2.position.y, p2.position.z)

            console.log('生成单点直线帧:', {
              segmentIndex,
              type: segment.type,
              numFrames,
              segmentLength,
              start: { x: p1.position.x, y: p1.position.y, z: p1.position.z },
              end: { x: p2.position.x, y: p2.position.y, z: p2.position.z }
            })
          }
        } catch (error) {
          console.error('处理单点移动命令时出错:', {
            error,
            segmentIndex,
            segmentType: segment.type,
            p1: p1.position,
            p2: p2.position
          })
        }
        return
      }

      // 处理多点段
      for (let pointIndex = 0; pointIndex < segment.points.length - 1; pointIndex++) {
        const p1 = segment.points[pointIndex]
        const p2 = segment.points[pointIndex + 1]

        try {
          let segmentLength = 0

          if (segment.type === 'G2' || segment.type === 'G3') {
            // 弧线
            const isClockwise = segment.type === 'G2'
            const i = p1.params?.I ?? 0
            const j = p1.params?.J ?? 0
            const center = new THREE.Vector3(
              p1.position.x + i,
              p1.position.y + j,
              p1.position.z
            )

            // 计算圆弧参数
            const radius = p1.position.distanceTo(center)
            const startAngle = Math.atan2(
              p1.position.y - center.y,
              p1.position.x - center.x
            )
            const endAngle = Math.atan2(
              p2.position.y - center.y,
              p2.position.x - center.x
            )

            // 确定旋转方向
            let angleDiff = endAngle - startAngle
            if (isClockwise) { // G2 顺时针
              if (angleDiff >= 0) angleDiff -= Math.PI * 2
            } else { // G3 逆时针
              if (angleDiff <= 0) angleDiff += Math.PI * 2
            }

            // 创建圆弧曲线
            const arcCurve = new THREE.EllipseCurve(
              center.x, center.y,
              radius, radius,
              startAngle, startAngle + angleDiff,
              isClockwise,
              0
            )

            // 计算弧长
            const numPoints = Math.max(50, Math.ceil(Math.abs(angleDiff) * radius * 2))
            const points = arcCurve.getPoints(numPoints)
            segmentLength = 0
            for (let i = 1; i < points.length; i++) {
              segmentLength += points[i].distanceTo(points[i - 1])
            }

            // 创建帧
            const numFrames = Math.max(50, Math.ceil(segmentLength * 2))
            const frameTime = segmentLength / speedInMmPerSecond / numFrames

            for (let i = 0; i <= numFrames; i++) {
              const t = i / numFrames
              const point = arcCurve.getPoint(t)
              const z = p1.position.z + (p2.position.z - p1.position.z) * t

              frames.push({
                position: new THREE.Vector3(point.x, point.y, z),
                segmentIndex,
                pointIndex,
                time: currentTime + frameTime * i
              })
            }

            currentTime += segmentLength / speedInMmPerSecond
            lastPosition = new THREE.Vector3(p2.position.x, p2.position.y, p2.position.z)

            console.log('生成弧线帧:', {
              segmentIndex,
              type: segment.type,
              numFrames,
              segmentLength,
              startAngle: startAngle * 180 / Math.PI,
              endAngle: (startAngle + angleDiff) * 180 / Math.PI,
              radius,
              center: { x: center.x, y: center.y, z: center.z }
            })
          } else {
            // 直线
            segmentLength = p1.position.distanceTo(p2.position)
            const numFrames = Math.max(10, Math.ceil(segmentLength * 2))
            const frameTime = segmentLength / speedInMmPerSecond / numFrames

            for (let i = 0; i <= numFrames; i++) {
              const t = i / numFrames
              frames.push({
                position: new THREE.Vector3(
                  p1.position.x + (p2.position.x - p1.position.x) * t,
                  p1.position.y + (p2.position.y - p1.position.y) * t,
                  p1.position.z + (p2.position.z - p1.position.z) * t
                ),
                segmentIndex,
                pointIndex,
                time: currentTime + frameTime * i
              })
            }

            currentTime += segmentLength / speedInMmPerSecond
            lastPosition = new THREE.Vector3(p2.position.x, p2.position.y, p2.position.z)
          }
        } catch (error) {
          console.error('处理路径段时出错:', {
            error,
            segmentIndex,
            pointIndex,
            type: segment.type,
            p1: p1.position,
            p2: p2.position
          })
        }
      }
    }
  })

  // 按时间排序帧
  frames.sort((a, b) => a.time - b.time)

  console.log('动画帧计算完成:', {
    totalFrames: frames.length,
    frameTypes: frames.reduce((acc, frame) => {
      const segment = segments[frame.segmentIndex]
      const type = segment?.type || 'unknown'
      acc[type] = (acc[type] || 0) + 1
      return acc
    }, {} as Record<string, number>)
  })

  return frames
}

// 修改更新动画函数
const updateAnimation = (time: number) => {
  if (!isPlaying.value || !toolHead || !scene || !state.parsedSegments.value.length) {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    return
  }

  // 如果是第一次运行，初始化动画帧
  if (state.animationFrames.value.length === 0) {
    const frames = calculateAnimationFrames(state.parsedSegments.value)
    if (frames.length === 0) {
      console.error('无法生成有效的动画帧')
      isPlaying.value = false
      return
    }
    state.animationFrames.value = frames
    state.animationStartTime.value = time
    state.currentFrameIndex.value = 0
    logMovement('初始化动画帧', { 
      totalFrames: frames.length,
      segments: state.parsedSegments.value.length,
      firstFrame: frames[0],
      lastFrame: frames[frames.length - 1]
    })
  }

  // 计算当前应该显示的帧
  const elapsedTime = time - state.animationStartTime.value
  const targetFrameIndex = Math.min(
    Math.floor(elapsedTime / FRAME_TIME),
    state.animationFrames.value.length - 1
  )

  // 如果已经播放完所有帧
  if (targetFrameIndex >= state.animationFrames.value.length - 1) {
    // 确保显示最后一帧
    const lastFrame = state.animationFrames.value[state.animationFrames.value.length - 1]
    if (lastFrame && lastFrame.position) {
      toolHead.position.copy(lastFrame.position)
      currentPosition.value = {
        x: lastFrame.position.x,
        y: lastFrame.position.y,
        z: lastFrame.position.z
      }
      
      // 确保显示最后一段路径
      const segment = state.parsedSegments.value[lastFrame.segmentIndex]
      if (segment) {
        if (segment.type === 'G2' || segment.type === 'G3') {
          showArc(segment, lastFrame.pointIndex, lastFrame.segmentIndex)
        } else {
          const segmentIndex = extrudedSegments.findIndex(mesh => 
            mesh.name === `segment_${lastFrame.segmentIndex}_${lastFrame.pointIndex + 1}`
          )
          if (segmentIndex !== -1) {
            extrudedSegments[segmentIndex].visible = true
          }
        }
      }
    }
    isPlaying.value = false
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    return
  }

  // 更新到目标帧
  while (state.currentFrameIndex.value < targetFrameIndex && 
         state.currentFrameIndex.value < state.animationFrames.value.length - 1) {
    const currentFrame = state.animationFrames.value[state.currentFrameIndex.value]
    const nextFrame = state.animationFrames.value[state.currentFrameIndex.value + 1]
    
    if (!currentFrame?.position || !nextFrame?.position) {
      console.warn('跳过无效的帧:', { 
        currentFrame, 
        nextFrame, 
        currentFrameIndex: state.currentFrameIndex.value 
      })
      state.currentFrameIndex.value++
      continue
    }

    // 更新打印头位置
    toolHead.position.copy(currentFrame.position)
    currentPosition.value = {
      x: currentFrame.position.x,
      y: currentFrame.position.y,
      z: currentFrame.position.z
    }

    // 显示当前路径
    const segment = state.parsedSegments.value[currentFrame.segmentIndex]
    if (segment) {
      if (segment.type === 'G2' || segment.type === 'G3') {
        // 对于弧线，我们需要找到包含 I、J、K 参数的起点
        // 每个弧线段由两个点组成，起点包含 I、J、K 参数
        const startPointIndex = currentFrame.pointIndex
        if (startPointIndex < segment.points.length - 1) {
          const startPoint = segment.points[startPointIndex]
          const endPoint = segment.points[startPointIndex + 1]
          
          // 检查起点和终点是否有效
          if (!startPoint || !endPoint || !startPoint.position || !endPoint.position) {
            console.warn('弧线点数据无效:', {
              segmentIndex: currentFrame.segmentIndex,
              startPointIndex,
              startPoint,
              endPoint
            })
            state.currentFrameIndex.value++
            continue
          }

          // 检查起点是否包含必要的参数
          if (startPoint.params && 
              startPoint.params.I !== undefined && 
              startPoint.params.J !== undefined) {
            try {
              showArc(segment, startPointIndex, currentFrame.segmentIndex)
            } catch (error) {
              console.error('显示弧线时出错:', {
                error,
                segmentIndex: currentFrame.segmentIndex,
                startPointIndex,
                segmentType: segment.type,
                params: startPoint.params,
                startPoint: startPoint.position,
                endPoint: endPoint.position
              })
            }
          } else {
            console.warn('弧线起点缺少必要参数:', {
              segmentIndex: currentFrame.segmentIndex,
              startPointIndex,
              params: startPoint.params,
              segmentType: segment.type,
              currentPointIndex: currentFrame.pointIndex,
              startPoint: startPoint.position,
              endPoint: endPoint.position
            })
          }
        }
      } else {
        const segmentIndex = extrudedSegments.findIndex(mesh => 
          mesh.name === `segment_${currentFrame.segmentIndex}_${currentFrame.pointIndex + 1}`
        )
        if (segmentIndex !== -1) {
          extrudedSegments[segmentIndex].visible = true
        }
      }
    }

    state.currentFrameIndex.value++
  }

  // 继续动画循环
  animationFrameId = requestAnimationFrame(updateAnimation)
}

// 修改重置弧线状态的辅助函数
const resetArcState = () => {
  currentArcProgress = 0
  currentArcCurve = null
  currentArcLength = 0
}

// 修改重置动画函数
const resetAnimation = () => {
  if (!toolHead || !state.parsedSegments.value.length || !modelGroup) return
  
  isPlaying.value = false
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
  
  // 重置动画状态
  state.animationFrames.value = []
  state.currentFrameIndex.value = 0
  state.animationStartTime.value = 0
  
  // 隐藏所有模型和弧线
  extrudedSegments.forEach(segment => {
    segment.visible = false
  })
  
  // 清理预加载的弧线
  pendingArcs.forEach(arc => {
    if (modelGroup) {
      modelGroup.remove(arc)
      arc.geometry.dispose()
      ;(arc.material as THREE.Material).dispose()
    }
  })
  pendingArcs.clear()
  visibleArcs.clear()
  arcGenerationQueue = []
  
  // 重置打印头位置
  if (state.parsedSegments.value[0] && state.parsedSegments.value[0].points[0]) {
    const startPoint = state.parsedSegments.value[0].points[0].position
    toolHead.position.copy(startPoint)
    currentPosition.value = {
      x: startPoint.x,
      y: startPoint.y,
      z: startPoint.z
    }
  }
  currentSpeed.value = 0
  currentLayer.value = 0

  // 重置弧线运动状态
  resetArcState()

  // 确保场景在更新后立即渲染
  if (renderer && scene && camera) {
    renderer.render(scene, camera)
  }
}

// 处理速度变化
const handleSpeedChange = (newSpeed: number) => {
  playbackSpeed.value = newSpeed
}

// 更新路径
const updatePath = (segments: PathSegment[]) => {
  if (!scene || !camera || !renderer || !controls || !toolHead || !modelGroup) {
    console.error('场景组件未完全初始化')
    return
  }

  isProcessing.value = true

  try {
    // 清理现有模型
    while (modelGroup.children.length > 0) {
      const child = modelGroup.children[0]
      modelGroup.remove(child)
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose()
        if (child.material instanceof THREE.Material) {
          child.material.dispose()
        }
      }
    }
    extrudedSegments = []

    // 验证路径段数据
    if (!segments || !Array.isArray(segments)) {
      throw new Error('无效的路径段数据')
    }

    // 过滤和验证路径段
    const validSegments: PathSegment[] = []
    let lastPosition: THREE.Vector3 | null = null

    segments.forEach((segment, index) => {
      if (!segment || !segment.points || !Array.isArray(segment.points)) {
        console.warn('跳过无效的路径段:', segment)
        return
      }

      // 验证每个点
      const validPoints = segment.points.every(point => {
        if (!point || !point.position || !(point.position instanceof THREE.Vector3)) {
          console.warn('跳过无效的点:', point)
          return false
        }
        return true
      })

      if (!validPoints) {
        console.warn('路径段包含无效的点:', segment)
        return
      }

      // 处理单点段
      if (segment.points.length === 1) {
        const point = segment.points[0]
        
        // 如果是第一个点，保存位置并继续
        if (!lastPosition) {
          lastPosition = point.position.clone()
          validSegments.push({
            ...segment,
            points: [{
              ...point,
              position: point.position.clone()
            }]
          })
          return
        }

        // 使用上一个位置作为起点，当前点作为终点
        const startPoint = {
          ...point,
          position: lastPosition.clone(),
          type: segment.type
        }
        const endPoint = {
          ...point,
          position: point.position.clone(),
          type: segment.type
        }

        validSegments.push({
          ...segment,
          points: [startPoint, endPoint]
        })

        lastPosition = point.position.clone()
        return
      }

      // 处理多点段
      if (segment.points.length >= 2) {
        validSegments.push({
          ...segment,
          points: segment.points.map(point => ({
            ...point,
            position: point.position.clone()
          }))
        })
        lastPosition = segment.points[segment.points.length - 1].position.clone()
      }
    })

    if (validSegments.length === 0) {
      throw new Error('没有有效的路径段')
    }

    state.parsedSegments.value = validSegments
    console.log('处理后的有效路径段数量:', validSegments.length)

    // 预先创建所有模型，但设置为不可见
    validSegments.forEach((segment, index) => {
      // 处理路径段
      for (let i = 1; i < segment.points.length; i++) {
        const p1 = segment.points[i - 1]
        const p2 = segment.points[i]
        
        if (!p1 || !p2 || !p1.position || !p2.position) {
          console.warn('跳过无效的点对:', { p1, p2, segmentIndex: index, pointIndex: i })
          continue
        }

        // 创建线段模型
        const geometry = new THREE.CylinderGeometry(0.3, 0.3, p1.position.distanceTo(p2.position), 8)
        const material = new THREE.MeshPhongMaterial({
          color: segment.isExtruding ? 0x00ff00 : 0xff0000,
          transparent: true,
          opacity: 0.8,
          side: THREE.DoubleSide
        })

        // 计算线段方向和位置
        const direction = new THREE.Vector3().subVectors(p2.position, p1.position)
        const quaternion = new THREE.Quaternion()
        quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
        geometry.applyQuaternion(quaternion)

        // 移动到中点
        const midPoint = new THREE.Vector3().addVectors(p1.position, p2.position).multiplyScalar(0.5)
        geometry.translate(midPoint.x, midPoint.y, midPoint.z)

        const lineMesh = new THREE.Mesh(geometry, material)
        lineMesh.name = `segment_${index}_${i}`
        lineMesh.castShadow = true
        lineMesh.receiveShadow = true
        lineMesh.visible = false // 初始设置为不可见
        if (modelGroup) {
          modelGroup.add(lineMesh)
        }
        extrudedSegments.push(lineMesh)
      }
    })

    // 调整相机视角
    if (extrudedSegments.length > 0) {
      const box = new THREE.Box3()
      extrudedSegments.forEach(segment => {
        box.expandByObject(segment)
      })
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      
      const maxDim = Math.max(size.x, size.y, size.z)
      const fov = camera.fov * (Math.PI / 180)
      let cameraDistance = Math.abs(maxDim / Math.sin(fov / 2)) * 1.5
      
      const newPosition = new THREE.Vector3(
        center.x + cameraDistance,
        center.y + cameraDistance,
        center.z + cameraDistance
      )
      
      camera.position.copy(newPosition)
      camera.lookAt(center)
      controls.target.copy(center)
      controls.update()
    }

    // 计算打印头实际移动距离
    const distanceInfo = calculateToolHeadDistance(state.parsedSegments.value)

    // 计算合适的速度
    const appropriateSpeed = calculateAppropriateSpeed(distanceInfo)

    // 更新最大速度和当前速度
    MAX_SPEED.value = Math.ceil(appropriateSpeed * 1.5 / 100) * 100
    playbackSpeed.value = appropriateSpeed

    hasPath.value = true

    // 重置动画状态
    state.currentSegmentIndex.value = 0
    state.currentPointIndex.value = 0
    animationProgress.value = 0

    // 显示打印头
    if (state.parsedSegments.value[0] && state.parsedSegments.value[0].points[0]) {
      const startPoint = state.parsedSegments.value[0].points[0].position
      toolHead.position.copy(startPoint)
      toolHead.visible = true
    }

    // 重置状态
    isProcessing.value = false

    // 确保场景在更新后立即渲染
    if (renderer && scene && camera) {
      renderer.render(scene, camera)
    }
  } catch (error) {
    console.error('路径更新错误:', error)
    isProcessing.value = false
    return
  }
}

// 监听解析结果变化
watch(() => store.parseResult, (newResult) => {
  if (newResult) {
    nextTick(async () => {
      if (!isInitialized) {
        initScene()
        // 等待场景初始化完成
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      
      // 确保场景已经初始化
      if (!scene || !camera || !renderer || !controls) {
        console.error('场景未正确初始化')
        return
      }

      try {
        const generator = new GCodePathGenerator()
        const segments = generator.generatePath(newResult.commands)
        console.log('生成的路径段数量:', segments.length)
        updatePath(segments)
      } catch (error) {
        console.error('路径生成错误:', error)
      }
    })
  }
}, { deep: true })

// 初始化场景
const initScene = () => {
  if (!containerRef.value || !canvasRef.value || isInitialized) return

  console.log('初始化场景...')

  // 创建场景
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xf0f0f0)

  // 创建相机
  const { width, height } = containerRef.value.getBoundingClientRect()
  camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 2000)
  camera.position.set(200, 200, 200)
  camera.lookAt(0, 0, 0)

  // 创建渲染器
  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  })
  renderer.setSize(width, height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  // 添加轨道控制器
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.1 // 增加阻尼系数，使旋转更平滑
  controls.rotateSpeed = 0.7 // 降低旋转速度，使控制更精确
  controls.screenSpacePanning = true
  controls.maxDistance = 2000
  controls.minDistance = 10
  controls.enabled = true // 确保控制器初始状态为启用

  // 添加环境光和方向光
  const ambientLight = new THREE.AmbientLight(0x404040, 1.5)
  scene.add(ambientLight)
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0)
  directionalLight.position.set(1, 1, 1)
  directionalLight.castShadow = true
  directionalLight.shadow.mapSize.width = 2048
  directionalLight.shadow.mapSize.height = 2048
  scene.add(directionalLight)

  // 创建坐标轴
  const axesHelper = new THREE.AxesHelper(100)
  scene.add(axesHelper)

  // 创建网格辅助
  const gridHelper = new THREE.GridHelper(400, 40, 0x888888, 0xcccccc)
  scene.add(gridHelper)

  // 创建模型组和路径组
  if (modelGroup) {
    scene.remove(modelGroup)
    modelGroup.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose()
        if (child.material instanceof THREE.Material) {
          child.material.dispose()
        }
      }
    })
  }
  modelGroup = new THREE.Group()
  modelGroup.name = 'modelGroup'
  scene.add(modelGroup)

  if (pathLines) {
    scene.remove(pathLines)
    pathLines.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose()
        if (child.material instanceof THREE.Material) {
          child.material.dispose()
        }
      }
    })
  }
  pathLines = new THREE.Group()
  pathLines.name = 'pathLines'
  scene.add(pathLines)

  // 创建打印头模型（球体）
  const toolHeadGeometry = new THREE.SphereGeometry(2, 16, 16)
  const toolHeadMaterial = new THREE.MeshPhongMaterial({ 
    color: 0xff0000,
    emissive: 0x440000,
    shininess: 100
  })
  toolHead = new THREE.Mesh(toolHeadGeometry, toolHeadMaterial)
  toolHead.castShadow = true
  toolHead.visible = false
  scene.add(toolHead)

  isInitialized = true
  console.log('场景初始化完成')
  startAnimation()
}

// 开始动画循环
const startAnimation = () => {
  if (!scene || !camera || !renderer || !controls) return

  const animate = (time: number) => {
    if (!scene || !camera || !renderer || !controls) return
    
    animationFrameId = requestAnimationFrame(animate)

    // 处理待处理的路径段
    if (pendingSegments.length > 0) {
      const deltaTime = time - lastFrameTime
      if (deltaTime >= FRAME_TIME) {
        processNextBatch()
        lastFrameTime = time
      }
    }

    // 更新控制器
    controls.update()

    // 只在需要时渲染场景
    if (isPlaying.value || controls.enabled) {
      renderer.render(scene, camera)
    }
  }

  lastFrameTime = performance.now()
  animate(lastFrameTime)
}

// 处理下一批路径段
const processNextBatch = () => {
  if (!scene || !pathLines || pendingSegments.length === 0) return

  const pathLinesGroup = pathLines
  const startIndex = currentBatchIndex
  const endIndex = Math.min(startIndex + BATCH_SIZE, pendingSegments.length)
  const batch = pendingSegments.slice(startIndex, endIndex)

  batch.forEach(segment => {
    if (segment.points.length < 2) return

    const points = segment.points.map(point => point.position)
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    
    // 根据 Z 轴高度调整颜色
    const avgZ = points.reduce((sum, p) => sum + p.z, 0) / points.length
    const color = segment.isExtruding 
      ? (segment.type === 'G1' 
          ? new THREE.Color(0x00ff00).lerp(new THREE.Color(0x0000ff), avgZ / 100) // 根据 Z 轴高度渐变
          : 0x0000ff)
      : 0xff0000
    
    const material = new THREE.LineBasicMaterial({ 
      color,
      linewidth: 1
    })

    const line = new THREE.Line(geometry, material)
    pathLinesGroup.add(line)
  })

  currentBatchIndex = endIndex

  // 更新进度
  if (currentBatchIndex >= pendingSegments.length) {
    finishPathUpdate()
  }
}

// 完成路径更新
const finishPathUpdate = () => {
  if (!scene || !camera || !renderer || !controls || !pathLines || !toolHead) return

  // 保存解析后的路径段
  state.parsedSegments.value = [...pendingSegments]
  const totalDuration = calculateTotalDistance(state.parsedSegments.value)
  hasPath.value = true

  // 调整相机视角
  const box = new THREE.Box3().setFromObject(pathLines)
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  
  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = camera.fov * (Math.PI / 180)
  let cameraDistance = Math.abs(maxDim / Math.sin(fov / 2)) * 1.5
  
  const newPosition = new THREE.Vector3(
    center.x + cameraDistance,
    center.y + cameraDistance,
    center.z + cameraDistance
  )
  
  camera.position.lerp(newPosition, 0.5)
  camera.lookAt(center)
  controls.target.copy(center)
  controls.update()

  // 显示打印头
  if (state.parsedSegments.value.length > 0 && state.parsedSegments.value[0].points.length > 0) {
    const startPoint = state.parsedSegments.value[0].points[0].position
    toolHead.position.copy(startPoint)
    toolHead.visible = true
  }

  // 重置状态
  pendingSegments = []
  currentBatchIndex = 0
  isProcessing.value = false
  animationProgress.value = 0

  // 确保场景在更新后立即渲染
  if (renderer && scene && camera) {
    renderer.render(scene, camera)
  }
}

// 监听窗口大小变化
const handleResize = () => {
  if (!containerRef.value || !camera || !renderer) return
  
  const { width, height } = containerRef.value.getBoundingClientRect()
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setSize(width, height)
  renderer.render(scene!, camera)
}

// 组件挂载和卸载
onMounted(async () => {
  await nextTick()
  initScene()
  window.addEventListener('resize', handleResize)
  
  // 确保初始场景渲染
  if (renderer && scene && camera) {
    renderer.render(scene, camera)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
  
  // 清理模型
  if (modelGroup) {
    extrudedSegments.forEach(segment => {
      modelGroup.remove(segment)
      segment.geometry.dispose()
      ;(segment.material as THREE.Material).dispose()
    })
  }
  extrudedSegments = []
  
  // 清理场景
  if (scene) {
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        if (Array.isArray(object.material)) {
          object.material.forEach(material => material.dispose())
        } else {
          object.material.dispose()
        }
      }
    })
  }
  
  if (renderer) {
    renderer.dispose()
    renderer = null
  }
  
  scene = null
  camera = null
  controls = null
  pathLines = null
  toolHead = null
  isInitialized = false
})

// 播放/暂停动画
const togglePlay = () => {
  if (!isPlaying.value) {
    // 开始播放
    if (!state.parsedSegments.value.length || !state.parsedSegments.value[0].points.length) {
      console.warn('没有有效的路径数据，无法开始播放')
      return
    }

    // 如果是第一次播放，计算动画帧
    if (state.animationFrames.value.length === 0) {
      const frames = calculateAnimationFrames(state.parsedSegments.value)
      if (frames.length === 0) {
        console.error('无法生成有效的动画帧')
        return
      }
      state.animationFrames.value = frames
      
      // 重置动画状态
      state.currentFrameIndex.value = 0
      state.animationStartTime.value = performance.now()
      
      // 隐藏所有模型
      extrudedSegments.forEach(segment => {
        segment.visible = false
      })

      // 设置打印头初始位置
      if (state.parsedSegments.value[0].points[0]) {
        const startPoint = state.parsedSegments.value[0].points[0].position
        if (toolHead) {
          toolHead.position.copy(startPoint)
          currentPosition.value = {
            x: startPoint.x,
            y: startPoint.y,
            z: startPoint.z
          }
        }
      }

      // 禁用控制器
      if (controls) {
        controls.enabled = false
      }

      console.log('开始播放动画:', {
        totalFrames: state.animationFrames.value.length,
        speed: playbackSpeed.value,
        segments: state.parsedSegments.value.length,
        startPoint: state.parsedSegments.value[0].points[0]?.position
      })

      isPlaying.value = true
      animationFrameId = requestAnimationFrame(updateAnimation)
    }
  } else {
    // 暂停
    isPlaying.value = false
    if (controls) {
      controls.enabled = true
    }
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    if (renderer && scene && camera) {
      renderer.render(scene, camera)
    }
  }
}

// 更新层显示
const updateLayerVisibility = () => {
  if (!pathLines || !modelGroup) return
  
  // 清除现有的层组
  layerGroups.forEach(group => {
    if (pathLines) {
      pathLines.remove(group)
    }
    group.traverse(child => {
      if (child instanceof THREE.Line) {
        child.geometry.dispose()
        ;(child.material as THREE.Material).dispose()
      }
    })
  })
  layerGroups.clear()

  if (!showLayers.value || !pathLines || !modelGroup) return

  // 按层高分组路径
  state.parsedSegments.value.forEach(segment => {
    segment.points.forEach(point => {
      const layer = Math.round(point.position.z / layerHeight.value) * layerHeight.value
      if (!layerGroups.has(layer)) {
        const group = new THREE.Group()
        layerGroups.set(layer, group)
        pathLines.add(group)
      }
    })
  })

  // 为每层创建路径
  layerGroups.forEach((group, layer) => {
    const segments = state.parsedSegments.value.filter(segment => 
      segment.points.some(point => 
        Math.round(point.position.z / layerHeight.value) * layerHeight.value === layer
      )
    )

    segments.forEach(segment => {
      const points = segment.points
        .filter(point => Math.round(point.position.z / layerHeight.value) * layerHeight.value === layer)
        .map(point => point.position)

      if (points.length < 2) return

      const geometry = new THREE.BufferGeometry().setFromPoints(points)
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color().setHSL(layer / 10, 1, 0.5),
        linewidth: 2
      })

      const line = new THREE.Line(geometry, material)
      group.add(line)
    })
  })
}

// 切换层显示
const toggleLayerView = () => {
  showLayers.value = !showLayers.value
  updateLayerVisibility()
}

// 更新动画进度日志
const updateAnimationProgress = (time: number) => {
  const elapsedTime = (time - animationStartTime.value) / 1000
  const distanceInfo = calculateToolHeadDistance(parsedSegments.value)
  const remainingDistanceInfo = calculateToolHeadDistance(parsedSegments.value.slice(currentSegmentIndex.value))
  const estimatedRemainingTime = (remainingDistanceInfo.totalDistance / playbackSpeed.value) * 60
}

// 预加载弧线
const preloadArc = (segment: PathSegment, segmentIndex: number, pointIndex: number) => {
  if (!modelGroup || segment.type !== 'G2' && segment.type !== 'G3') return

  const arcKey = `arc_${segmentIndex}_${pointIndex}`
  if (pendingArcs.has(arcKey) || visibleArcs.has(arcKey)) return

  // 获取弧线的起点和终点
  const startPoint = segment.points[pointIndex].position
  const endPoint = segment.points[pointIndex + 1].position

  // 创建弧线几何体
  const points = segment.points.slice(pointIndex, pointIndex + 2)
  const curve = new THREE.CatmullRomCurve3(points.map(p => p.position))
  const geometry = new THREE.TubeGeometry(curve, 20, 0.3, 8, false)
  
  // 创建材质
  const material = new THREE.MeshPhongMaterial({
    color: segment.isExtruding ? 0x00ff00 : 0xff0000,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide
  })

  // 创建弧线网格
  const arcMesh = new THREE.Mesh(geometry, material)
  arcMesh.name = arcKey
  arcMesh.visible = false
  if (modelGroup) {
    modelGroup.add(arcMesh)
  }
  pendingArcs.set(arcKey, arcMesh)
}

// 修改 showArc 函数
const showArc = (segment: PathSegment, pointIndex: number, segmentIndex: number) => {
  try {
    if (!modelGroup) {
      console.warn('modelGroup 未初始化')
      return
    }

    // 验证段类型
    if (segment.type !== 'G2' && segment.type !== 'G3') {
      console.warn('非弧线段:', segment.type)
      return
    }

    // 验证点数据
    if (!segment.points || segment.points.length < 2) {
      console.warn('段点数不足:', segment.points?.length)
      return
    }

    // 获取起点和终点
    const p1 = segment.points[pointIndex]
    const p2 = segment.points[pointIndex + 1]

    if (!p1 || !p2 || !p1.position || !p2.position) {
      console.warn('无效的点数据:', { p1, p2 })
      return
    }

    // 确保坐标是数字类型
    const startPoint = new THREE.Vector3(
      Number(p1.position.x),
      Number(p1.position.y),
      Number(p1.position.z)
    )
    const endPoint = new THREE.Vector3(
      Number(p2.position.x),
      Number(p2.position.y),
      Number(p2.position.z)
    )

    // 验证 I、J、K 参数
    if (!p1.params || p1.params.I === undefined || p1.params.J === undefined) {
      console.warn('缺少弧线参数 I、J:', p1.params)
      return
    }

    // 计算中心点（I、J 是相对于起点的偏移量）
    const center = new THREE.Vector3(
      startPoint.x + Number(p1.params.I),
      startPoint.y + Number(p1.params.J),
      startPoint.z + (p1.params.K ? Number(p1.params.K) : 0)
    )

    // 计算半径
    const radius = center.distanceTo(startPoint)
    if (radius < 0.001) {
      console.error('弧线半径过小:', {
        radius,
        center,
        startPoint,
        params: p1.params
      })
      return
    }

    // 计算角度
    const startAngle = Math.atan2(startPoint.y - center.y, startPoint.x - center.x)
    const endAngle = Math.atan2(endPoint.y - center.y, endPoint.x - center.x)
    
    // 根据 G2/G3 调整角度
    let angleDiff = endAngle - startAngle
    if (segment.type === 'G2') {
      if (angleDiff >= 0) angleDiff -= Math.PI * 2
    } else {
      if (angleDiff <= 0) angleDiff += Math.PI * 2
    }

    // 验证角度差
    if (Math.abs(angleDiff) < 0.001) {
      console.warn('弧线角度差过小:', angleDiff)
      return
    }

    // 创建弧线
    const arcKey = `arc_${segment.type}_${segmentIndex}_${pointIndex}`
    const curve = new THREE.EllipseCurve(
      center.x, center.y,
      radius, radius,
      startAngle, endAngle,
      segment.type === 'G2', // 顺时针
      0 // 旋转角度
    )

    // 生成弧线上的点
    const points = curve.getPoints(50)
    const curve3D = new THREE.CatmullRomCurve3(
      points.map(p => new THREE.Vector3(p.x, p.y, startPoint.z))
    )

    // 创建管道几何体
    const tubeGeometry = new THREE.TubeGeometry(curve3D, 64, 0.5, 8, false)
    const material = new THREE.MeshBasicMaterial({
      color: segment.isExtruding ? 0xff0000 : 0x00ff00,
      transparent: true,
      opacity: 0.8
    })

    // 创建或更新弧线网格
    let arcMesh = pendingArcs.get(arcKey)
    if (arcMesh) {
      arcMesh.geometry.dispose()
      arcMesh.geometry = tubeGeometry
      arcMesh.material = material
    } else {
      arcMesh = new THREE.Mesh(tubeGeometry, material)
      pendingArcs.set(arcKey, arcMesh)
      if (modelGroup) {
        modelGroup.add(arcMesh)
      }
    }

    // 输出调试信息
    console.log('创建/更新弧线:', {
      arcKey,
      segmentType: segment.type,
      startPoint: {
        x: startPoint.x.toFixed(2),
        y: startPoint.y.toFixed(2),
        z: startPoint.z.toFixed(2)
      },
      endPoint: {
        x: endPoint.x.toFixed(2),
        y: endPoint.y.toFixed(2),
        z: endPoint.z.toFixed(2)
      },
      center: {
        x: center.x.toFixed(2),
        y: center.y.toFixed(2),
        z: center.z.toFixed(2)
      },
      radius: radius.toFixed(2),
      startAngle: (startAngle * 180 / Math.PI).toFixed(2),
      endAngle: (endAngle * 180 / Math.PI).toFixed(2),
      angleDiff: (angleDiff * 180 / Math.PI).toFixed(2)
    })

  } catch (error) {
    console.error('创建/更新弧线失败:', {
      error,
      segmentIndex,
      pointIndex,
      startPoint: segment.points[pointIndex]?.position,
      endPoint: segment.points[pointIndex + 1]?.position,
      params: segment.points[pointIndex]?.params
    })
  }
}

// 预加载下一批弧线
const preloadNextArcs = () => {
  if (!isPlaying.value || arcGenerationQueue.length === 0) return

  const batchSize = 5 // 每批预加载的弧线数量
  const batch = arcGenerationQueue.splice(0, batchSize)

  batch.forEach(({ segmentIndex, pointIndex }) => {
    const segment = parsedSegments.value[segmentIndex]
    if (segment) {
      preloadArc(segment, segmentIndex, pointIndex)
    }
  })
}

// 计算打印头实际移动距离和弧线信息
const calculateToolHeadDistance = (segments: PathSegment[]) => {
  let totalDistance = 0
  let lastPosition: THREE.Vector3 | null = null
  let moveCount = 0
  let xDistance = 0
  let yDistance = 0
  let zDistance = 0
  let arcCount = 0
  let totalArcLength = 0

  segments.forEach((segment, segmentIndex) => {
    if (!segment.points || !Array.isArray(segment.points)) {
      console.warn('无效的路径段:', segment)
      return
    }

    // 检查是否是弧线运动（G2/G3命令）
    const isArc = segment.type === 'G2' || segment.type === 'G3'
    let arcLength = 0

    // 对于弧线运动，只计算起点和终点的距离
    if (isArc && segment.points.length >= 2) {
      const startPoint = segment.points[0].position
      const endPoint = segment.points[segment.points.length - 1].position
      const dx = Math.abs(endPoint.x - startPoint.x)
      const dy = Math.abs(endPoint.y - startPoint.y)
      const dz = Math.abs(endPoint.z - startPoint.z)
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      
      if (distance > 0.01) {
        totalDistance += distance
        xDistance += dx
        yDistance += dy
        zDistance += dz
        moveCount++
        arcCount++
        arcLength = distance
        totalArcLength += distance
      }
    } else {
      // 对于直线运动，计算每个点的距离
      segment.points.forEach((point, pointIndex) => {
        if (!point || !point.position) {
          console.warn('无效的点:', point)
          return
        }

        if (!lastPosition) {
          lastPosition = point.position.clone()
          return
        }

        const dx = Math.abs(point.position.x - lastPosition.x)
        const dy = Math.abs(point.position.y - lastPosition.y)
        const dz = Math.abs(point.position.z - lastPosition.z)
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        
        if (distance > 0.01) {
          totalDistance += distance
          xDistance += dx
          yDistance += dy
          zDistance += dz
          moveCount++
        }

        lastPosition = point.position.clone()
      })
    }
  })

  return {
    totalDistance,
    xDistance,
    yDistance,
    zDistance,
    moveCount,
    arcCount,
    totalArcLength,
    arcRatio: totalArcLength / totalDistance
  }
}

// 计算合适的速度
const calculateAppropriateSpeed = (distanceInfo: { 
  totalDistance: number, 
  xDistance: number,
  yDistance: number,
  zDistance: number,
  moveCount: number,
  arcCount: number,
  totalArcLength: number,
  arcRatio: number
}): number => {
  const { totalDistance, xDistance, yDistance, zDistance, moveCount, arcCount, arcRatio } = distanceInfo
  
  // 计算平均每段移动距离
  const averageMoveDistance = totalDistance / moveCount
  
  // 根据移动类型调整速度系数
  let speedMultiplier = 1.0
  
  // 如果Z轴移动比例较大，降低速度
  const zRatio = zDistance / totalDistance
  if (zRatio > 0.3) {
    speedMultiplier *= 0.8 // 减小Z轴移动的速度
  }
  
  // 根据平均移动距离调整速度
  if (averageMoveDistance < 1) {
    speedMultiplier *= 1.2 // 减小短距离移动的速度提升
  } else if (averageMoveDistance < 5) {
    speedMultiplier *= 1.1 // 减小中等距离的速度提升
  }

  // 计算基础速度：距离/时间 * 60（转换为mm/min）
  const baseSpeed = (totalDistance / (TARGET_ANIMATION_DURATION / 60))
  
  // 应用速度系数并确保在合理范围内
  const requiredSpeed = baseSpeed * speedMultiplier
  
  // 确保速度不小于最小速度，并向上取整到最接近的100
  const finalSpeed = Math.max(Math.ceil(requiredSpeed / 100) * 100, MIN_SPEED)
  
  // 限制最大速度
  return Math.min(finalSpeed, MAX_SPEED.value)
}

// 添加createArcCurve函数定义
const createArcCurve = (
  startPoint: THREE.Vector3,
  endPoint: THREE.Vector3,
  center: THREE.Vector3,
  isClockwise: boolean
): { curve: THREE.CubicBezierCurve3, length: number } => {
  // 计算起点和终点相对于圆心的向量
  const startVector = new THREE.Vector3().subVectors(startPoint, center)
  const endVector = new THREE.Vector3().subVectors(endPoint, center)
  
  // 计算半径
  const radius = startVector.length()
  
  // 验证半径
  if (Math.abs(radius - endVector.length()) > 0.1) {
    console.warn('弧线半径不一致:', {
      startRadius: radius,
      endRadius: endVector.length(),
      start: startPoint,
      end: endPoint,
      center
    })
  }
  
  // 计算角度
  const startAngle = Math.atan2(startVector.y, startVector.x)
  let endAngle = Math.atan2(endVector.y, endVector.x)
  
  // 根据方向调整结束角度
  if (isClockwise) {
    if (endAngle >= startAngle) {
      endAngle -= Math.PI * 2
    }
  } else {
    if (endAngle <= startAngle) {
      endAngle += Math.PI * 2
    }
  }
  
  // 计算控制点
  const angleDiff = endAngle - startAngle
  const controlPointDistance = radius * 0.551915024494 * Math.abs(angleDiff) / (Math.PI / 2)
  
  // 计算第一个控制点
  const controlPoint1Angle = startAngle + (isClockwise ? -1 : 1) * Math.PI / 2
  const controlPoint1 = new THREE.Vector3(
    center.x + radius * Math.cos(controlPoint1Angle),
    center.y + radius * Math.sin(controlPoint1Angle),
    startPoint.z
  )
  
  // 计算第二个控制点
  const controlPoint2Angle = endAngle + (isClockwise ? 1 : -1) * Math.PI / 2
  const controlPoint2 = new THREE.Vector3(
    center.x + radius * Math.cos(controlPoint2Angle),
    center.y + radius * Math.sin(controlPoint2Angle),
    endPoint.z
  )
  
  // 创建贝塞尔曲线
  const curve = new THREE.CubicBezierCurve3(
    startPoint,
    controlPoint1,
    controlPoint2,
    endPoint
  )
  
  // 计算弧长
  const length = radius * Math.abs(angleDiff)
  
  return { curve, length }
}
</script>

<style scoped>
.gcode-viewer {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: #f0f0f0;
}

.gcode-viewer canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.processing-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.8);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.processing-text {
  margin-top: 16px;
  font-size: 16px;
  color: #666;
}

.animation-controls {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(255, 255, 255, 0.95);
  padding: 16px;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  min-width: 300px;
  backdrop-filter: blur(8px);
}

.animation-controls .n-space {
  margin-bottom: 8px;
}

.animation-controls .n-text {
  font-size: 14px;
  color: #666;
}
</style> 