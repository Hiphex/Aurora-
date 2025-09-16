import { type ChangeEvent, type CSSProperties, type FormEvent, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Check, Clock, Copy, KeyRound, Mic, PauseCircle, UploadCloud, Settings as Gear, X } from 'lucide-react'
import clsx from 'clsx'
import './App.css'

type CSSVarStyle = CSSProperties & Record<'--record-bg' | '--record-bg-active' | '--record-color', string>

const MODEL_OPTIONS = [
  {
    value: 'gpt-4o-mini-transcribe',
    label: 'GPT-4o mini transcribe',
    description: 'Low-latency and budget friendly. Great for quick notes and meetings.',
    speedRank: 'Ultra fast',
  },
  {
    value: 'gpt-4o-transcribe',
    label: 'GPT-4o transcribe',
    description: 'Flagship accuracy for production ready transcripts with perfect punctuation.',
    speedRank: 'Studio grade',
  },
]

const isSupabaseConfigured = false

type HistoryEntry = {
  id: string
  createdAt: number
  model: string
  text: string
  durationMs?: number
  source: 'microphone' | 'upload'
  summary?: string
}

const STORAGE_KEYS = {
  apiKey: 'aurora-transcribe:apiKey',
  rememberKey: 'aurora-transcribe:rememberKey',
  history: 'aurora-transcribe:history',
  autoSave: 'aurora-transcribe:autoSave',
  autoCopy: 'aurora-transcribe:autoCopy',
  showWaveform: 'aurora-transcribe:showWaveform',
  ambientGlow: 'aurora-transcribe:ambientGlow',
  preferredModel: 'aurora-transcribe:preferredModel',
}

const formatDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const formatTimestamp = (timestamp: number) => {
  const date = new Date(timestamp)
  return date.toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    month: 'short',
    day: 'numeric',
  })
}

const readStorage = (key: string) => {
  try {
    return window.localStorage.getItem(key)
  } catch (error) {
    console.warn('Unable to read from localStorage', error)
    return null
  }
}

const writeStorage = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value)
  } catch (error) {
    console.warn('Unable to write to localStorage', error)
  }
}

const removeStorage = (key: string) => {
  try {
    window.localStorage.removeItem(key)
  } catch (error) {
    console.warn('Unable to remove from localStorage', error)
  }
}

const sanitizeFileName = (fileName: string) => fileName.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const createEntryId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  // RFC4122 v4 fallback
  let uuid = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += '-'
    } else if (i === 14) {
      uuid += '4'
    } else {
      const r = Math.random() * 16 | 0
      uuid += (i === 19 ? (r & 0x3) | 0x8 : r).toString(16)
    }
  }
  return uuid
}

type TranscriptSegment = { start?: number; end?: number; text: string }

const joinSegmentTexts = (segments: unknown): string | null => {
  if (!Array.isArray(segments)) return null
  const parts: string[] = []
  for (const segment of segments) {
    if (isRecord(segment) && typeof segment.text === 'string') parts.push(segment.text)
  }
  const combined = parts.map((part) => part.trim()).filter(Boolean).join(' ')
  return combined.length > 0 ? combined : null
}

const parseTime = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const num = Number(value)
    if (Number.isFinite(num)) return num
  }
  return undefined
}

const coerceSegment = (value: unknown): TranscriptSegment | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const textCandidate =
    typeof record.text === 'string'
      ? record.text
      : typeof record.transcript === 'string'
        ? record.transcript
        : typeof record.word === 'string'
          ? record.word
          : null
  if (!textCandidate || !textCandidate.trim()) return null
  const start = parseTime(record.start ?? record.begin ?? record.offset)
  const endCandidate = parseTime(record.end ?? record.finish ?? record.offset_end ?? record.stop)
  const duration = parseTime(record.duration)
  const end = endCandidate ?? (start !== undefined && duration !== undefined ? start + duration : undefined)
  return { text: textCandidate, start, end }
}

const tryCollectSegments = (value: unknown): TranscriptSegment[] | null => {
  if (!Array.isArray(value)) return null
  const segments: TranscriptSegment[] = []
  for (const item of value) {
    const segment = coerceSegment(item)
    if (segment) segments.push(segment)
  }
  return segments.length ? segments : null
}

const extractSegments = (payload: unknown, visited = new Set<unknown>()): TranscriptSegment[] | null => {
  if (!payload || typeof payload !== 'object') return null
  if (visited.has(payload)) return null
  visited.add(payload)

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractSegments(item, visited)
      if (nested && nested.length) return nested
    }
    return null
  }

  const record = payload as Record<string, unknown>

  const directKeys = ['segments', 'words', 'paragraphs', 'items']
  for (const key of directKeys) {
    const maybe = tryCollectSegments(record[key])
    if (maybe && maybe.length) return maybe
  }

  const nestedKeys = ['result', 'results', 'data', 'output', 'content', 'alternatives', 'message', 'messages']
  for (const key of nestedKeys) {
    const nested = extractSegments(record[key], visited)
    if (nested && nested.length) return nested
  }

  for (const value of Object.values(record)) {
    const nested = extractSegments(value, visited)
    if (nested && nested.length) return nested
  }

  return null
}

const extractTranscriptionText = (payload: unknown, visited = new Set<unknown>()): string | null => {
  if (typeof payload === 'string') return payload
  if (payload === null || typeof payload !== 'object') return null
  if (visited.has(payload)) return null
  visited.add(payload)

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const text = extractTranscriptionText(item, visited)
      if (text) return text
    }
    return null
  }

  const record = payload as Record<string, unknown>

  if (typeof record.text === 'string') return record.text

  if ('segments' in record) {
    const fromSegments = joinSegmentTexts(record.segments)
    if (fromSegments) return fromSegments
  }

  if ('alternatives' in record && Array.isArray(record.alternatives)) {
    for (const alt of record.alternatives) {
      const text = extractTranscriptionText(alt, visited)
      if (text) return text
    }
  }

  const nestedCandidates = [
    record.transcription,
    record.result,
    record.results,
    record.data,
    record.output,
    record.content,
    record.choices,
    record.message,
    record.messages,
    record.paragraphs,
  ]

  for (const candidate of nestedCandidates) {
    const text = extractTranscriptionText(candidate, visited)
    if (text) return text
  }

  for (const value of Object.values(record)) {
    const text = extractTranscriptionText(value, visited)
    if (text) return text
  }

  return null
}

const parseTranscriptionResponse = async (response: Response): Promise<{ text: string; segments?: TranscriptSegment[] }> => {
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    try {
      const data = await response.clone().json()
      const extracted = extractTranscriptionText(data)
      const segments = extractSegments(data) ?? undefined
      if (extracted && extracted.trim()) return { text: extracted.trim(), segments }
    } catch (error) {
      console.warn('Unable to parse JSON transcription payload', error)
    }
  }

  const rawBody = await response.text()
  const trimmedBody = rawBody.trim()
  if (!trimmedBody) throw new Error('Transcription returned an empty response.')

  if (!contentType.includes('application/json') && (trimmedBody.startsWith('{') || trimmedBody.startsWith('['))) {
    try {
      const data = JSON.parse(trimmedBody) as unknown
      const extracted = extractTranscriptionText(data)
      const segments = extractSegments(data) ?? undefined
      if (extracted && extracted.trim()) return { text: extracted.trim(), segments }
    } catch (error) {
      console.warn('Unable to parse JSON transcription string body', error)
    }
  }

  return { text: trimmedBody }
}

function App() {
  const [apiKey, setApiKey] = useState('')
  const [rememberKey, setRememberKey] = useState(false)
  const [selectedModel, setSelectedModel] = useState(MODEL_OPTIONS[0].value)
  const [transcript, setTranscript] = useState('')
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [autoSaveHistory, setAutoSaveHistory] = useState(true)
  const [autoCopyTranscript, setAutoCopyTranscript] = useState(false)
  const [showWaveform, setShowWaveform] = useState(true)
  const [ambientGlow, setAmbientGlow] = useState(false)
  const [recordColor, setRecordColor] = useState<string>('#22c55e')
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')
  const [languageHint, setLanguageHint] = useState('')
  const [temperature, setTemperature] = useState(0.2)
  const [injectPrompt, setInjectPrompt] = useState('')
  const [shouldTranslate, setShouldTranslate] = useState(false)
  const [formattedView, setFormattedView] = useState(true)
  const [showTimestamps, setShowTimestamps] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [summaryEnabled, setSummaryEnabled] = useState(true)
  const [summary, setSummary] = useState('')
  const [isSummarizing, setIsSummarizing] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordStartRef = useRef<number | null>(null)
  const timerIntervalRef = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const dataArrayRef = useRef<Uint8Array | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [settingsTab, setSettingsTab] = useState<'general' | 'transcription' | 'appearance' | 'history'>('general')
  const [showLanding, setShowLanding] = useState(() => readStorage('aurora-transcribe:onboarded') !== 'true')
  const [historyLoading] = useState(false)
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null)

  const hasTranscript = transcript.trim().length > 0
  const activeModel = useMemo(
    () => MODEL_OPTIONS.find((option) => option.value === selectedModel) ?? MODEL_OPTIONS[0],
    [selectedModel],
  )

  useEffect(() => {
    const storedAutoSave = readStorage(STORAGE_KEYS.autoSave)
    if (storedAutoSave) setAutoSaveHistory(storedAutoSave === 'true')
    const storedAutoCopy = readStorage(STORAGE_KEYS.autoCopy)
    if (storedAutoCopy) setAutoCopyTranscript(storedAutoCopy === 'true')
    const storedWaveform = readStorage(STORAGE_KEYS.showWaveform)
    if (storedWaveform) setShowWaveform(storedWaveform === 'true')
    const storedAmbient = readStorage(STORAGE_KEYS.ambientGlow)
    if (storedAmbient) setAmbientGlow(storedAmbient === 'true')
    const storedColor = readStorage('aurora-transcribe:recordColor')
    if (storedColor) setRecordColor(storedColor)
    const storedSummary = readStorage('aurora-transcribe:summaryEnabled')
    if (storedSummary) setSummaryEnabled(storedSummary === 'true')
    const storedRememberKey = readStorage(STORAGE_KEYS.rememberKey)
    if (storedRememberKey === 'true') {
      setRememberKey(true)
      const key = readStorage(STORAGE_KEYS.apiKey)
      if (key) setApiKey(key)
    }
    const storedModel = readStorage(STORAGE_KEYS.preferredModel)
    if (storedModel) setSelectedModel(storedModel)
    const storedHistory = readStorage(STORAGE_KEYS.history)
    if (storedHistory) {
      try {
        setHistory(JSON.parse(storedHistory) as HistoryEntry[])
      } catch (error) {
        console.warn('Failed to parse stored transcription history', error)
      }
    }
  }, [])

  useEffect(() => {
    if (rememberKey) writeStorage(STORAGE_KEYS.apiKey, apiKey)
    else removeStorage(STORAGE_KEYS.apiKey)
  }, [apiKey, rememberKey])

  useEffect(() => {
    writeStorage(STORAGE_KEYS.rememberKey, rememberKey ? 'true' : 'false')
  }, [rememberKey])

  useEffect(() => {
    writeStorage(STORAGE_KEYS.autoSave, autoSaveHistory ? 'true' : 'false')
  }, [autoSaveHistory])

  useEffect(() => {
    writeStorage(STORAGE_KEYS.autoCopy, autoCopyTranscript ? 'true' : 'false')
  }, [autoCopyTranscript])

  useEffect(() => {
    writeStorage(STORAGE_KEYS.showWaveform, showWaveform ? 'true' : 'false')
  }, [showWaveform])

  useEffect(() => {
    writeStorage(STORAGE_KEYS.ambientGlow, ambientGlow ? 'true' : 'false')
  }, [ambientGlow])

  useEffect(() => {
    writeStorage('aurora-transcribe:recordColor', recordColor)
  }, [recordColor])

  useEffect(() => {
    writeStorage('aurora-transcribe:summaryEnabled', summaryEnabled ? 'true' : 'false')
  }, [summaryEnabled, setSummary, setCurrentEntryId])

  useEffect(() => {
    writeStorage(STORAGE_KEYS.preferredModel, selectedModel)
  }, [selectedModel])

  useEffect(() => {
    if (user) return
    if (autoSaveHistory) writeStorage(STORAGE_KEYS.history, JSON.stringify(history))
    else removeStorage(STORAGE_KEYS.history)
  }, [history, autoSaveHistory, user])

  useEffect(() => {
    writeStorage('aurora-transcribe:onboarded', showLanding ? 'false' : 'true')
  }, [showLanding])

  useEffect(() => {
    if (!summaryEnabled) {
      setSummary('')
      setCurrentEntryId(null)
    }
  }, [summaryEnabled, setSummary, setCurrentEntryId])

  useEffect(() => {
    if (!isRecording) {
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
      }
      return
    }

    timerIntervalRef.current = window.setInterval(() => {
      if (recordStartRef.current) setElapsedMs(Date.now() - recordStartRef.current)
    }, 200)

    return () => {
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
      }
    }
  }, [isRecording])

  useEffect(() => {
    if (!showWaveform) {
      stopVisualizer()
      return
    }
    if (isRecording) startVisualizer()
    else stopVisualizer()
  }, [isRecording, showWaveform])

  const shadeHex = (hex: string, percent: number) => {
    const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)
    if (!match) return hex
    const to = (i: number) => Math.min(255, Math.max(0, Math.round(i)))
    const r = parseInt(match[1], 16)
    const g = parseInt(match[2], 16)
    const b = parseInt(match[3], 16)
    const p = percent / 100
    const rr = to(r + (percent > 0 ? (255 - r) * p : r * p))
    const gg = to(g + (percent > 0 ? (255 - g) * p : g * p))
    const bb = to(b + (percent > 0 ? (255 - b) * p : b * p))
    const h = (n: number) => n.toString(16).padStart(2, '0')
    return `#${h(rr)}${h(gg)}${h(bb)}`
  }

  const recordGradients = useMemo(() => {
    const base = recordColor
    const light = shadeHex(base, 28)
    const mid = shadeHex(base, 0)
    const dark = shadeHex(base, -22)
    const idle = `radial-gradient(circle at 30% 30%, ${light}, ${mid} 55%, ${dark} 100%)`
    const active = `radial-gradient(circle at 30% 30%, ${shadeHex(base, 40)}, ${shadeHex(base, 10)} 55%, ${shadeHex(base, -10)} 100%)`
    return { idle, active }
  }, [recordColor])

  const recordStyle = useMemo<CSSVarStyle>(() => ({
    '--record-bg': recordGradients.idle,
    '--record-bg-active': recordGradients.active,
    '--record-color': recordColor,
  }), [recordGradients, recordColor])

  const startVisualizer = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const stream = mediaRecorderRef.current?.stream
    if (!stream) return

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext()
    }
    const audioContext = audioContextRef.current
    const existingSource = audioContext.createMediaStreamSource(stream)
    analyserRef.current = audioContext.createAnalyser()
    analyserRef.current.fftSize = 2048
    analyserRef.current.smoothingTimeConstant = 0.85
    const bufferLength = analyserRef.current.frequencyBinCount
    dataArrayRef.current = new Uint8Array(bufferLength)
    existingSource.connect(analyserRef.current)

    const draw = () => {
      // HiDPI crisp rendering
      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1))
      if (canvas.width !== canvas.clientWidth * dpr || canvas.height !== canvas.clientHeight * dpr) {
        canvas.width = canvas.clientWidth * dpr
        canvas.height = canvas.clientHeight * dpr
      }

      const ctx = canvas.getContext('2d')
      const analyser = analyserRef.current
      const dataArray = dataArrayRef.current
      if (!ctx || !analyser || !dataArray) return

      analyser.getByteTimeDomainData(dataArray)

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const w = canvas.width
      const h = canvas.height

      // Background subtle gradient
      const bg = ctx.createLinearGradient(0, 0, 0, h)
      bg.addColorStop(0, '#0b0b0b')
      bg.addColorStop(1, '#0f0f0f')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, w, h)

      // Stroke gradient across x
      const strokeGrad = ctx.createLinearGradient(0, 0, w, 0)
      strokeGrad.addColorStop(0, '#8a9bff')
      strokeGrad.addColorStop(0.5, '#ff6daf')
      strokeGrad.addColorStop(1, '#6ad6ff')
      ctx.lineWidth = 2 * dpr
      ctx.strokeStyle = strokeGrad

      // Fill under the curve
      const fillGrad = ctx.createLinearGradient(0, 0, 0, h)
      fillGrad.addColorStop(0, 'rgba(138, 155, 255, 0.16)')
      fillGrad.addColorStop(1, 'rgba(106, 214, 255, 0.06)')

      ctx.beginPath()
      const sliceWidth = w / dataArray.length
      let x = 0
      const mid = h / 2
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 128.0
        const y = v * mid
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
        x += sliceWidth
      }
      ctx.lineTo(w, mid)
      ctx.stroke()

      // Fill effect
      ctx.lineTo(0, mid)
      ctx.closePath()
      ctx.fillStyle = fillGrad
      ctx.fill()

      animationFrameRef.current = requestAnimationFrame(draw)
    }

    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
    draw()
  }

  const stopVisualizer = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined)
      audioContextRef.current = null
    }
    analyserRef.current = null
    dataArrayRef.current = null
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    ctx?.clearRect(0, 0, canvas!.width, canvas!.height)
  }

  /* displayTranscript declared after helpers */

  const formatTimecode = useCallback((seconds?: number) => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return ''
    const total = Math.max(0, Math.floor(seconds))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }, [])

  const formatSegmentsToText = useCallback((segs: TranscriptSegment[], withTimestamps: boolean) => {
    if (!segs.length) return ''
    const lines: string[] = []
    let current: string[] = []
    let paragraphStart: number | undefined
    const flushParagraph = () => {
      if (!current.length) return
      const prefix = withTimestamps && paragraphStart !== undefined ? `[${formatTimecode(paragraphStart)}] ` : ''
      lines.push(prefix + current.join(' ').replace(/\s+/g, ' ').trim())
      current = []
      paragraphStart = undefined
    }
    const GAP = 0.8 // seconds threshold between paragraphs

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      const prev = segs[i - 1]
      const gap = prev && typeof s.start === 'number' && typeof prev.end === 'number' ? s.start - prev.end : 0
      const text = s.text.trim()
      if (!text) continue

      if (current.length && gap > GAP) {
        flushParagraph()
      }
      if (!current.length) {
        paragraphStart = s.start
      }
      current.push(text)
      if (/[.!?]$/.test(text)) {
        flushParagraph()
      }
    }
    flushParagraph()
    return lines.join('\n\n')
  }, [formatTimecode])
  const displayTranscript = useMemo(() => {
    if (formattedView && segments && segments.length > 0) {
      return formatSegmentsToText(segments, showTimestamps)
    }
    return transcript
  }, [formattedView, segments, showTimestamps, transcript, formatSegmentsToText])
  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Live recording is not supported in this browser.')
      return
    }
    setError(null)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4'
      const mediaRecorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data)
      }

      mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType })
        const duration = recordStartRef.current ? Date.now() - recordStartRef.current : elapsedMs
        await handleTranscription(blob, 'microphone', Date.now(), duration)
        stream.getTracks().forEach((track) => track.stop())
        recordStartRef.current = null
        setElapsedMs(0)
      }

      // small timeslice to ensure timely chunking and avoid missed edges
      mediaRecorder.start(500)
      recordStartRef.current = Date.now()
      setIsRecording(true)
      setElapsedMs(0)
    } catch (err) {
      console.error(err)
      setError('Microphone access denied. Please enable it and try again.')
    }
  }

  const stopRecording = () => {
    if (!isRecording) return
    try {
      // Flush final buffer to avoid truncation
      mediaRecorderRef.current?.requestData()
      // Slight delay to ensure the last dataavailable fires before stopping
      const mr = mediaRecorderRef.current
      window.setTimeout(() => {
        try { mr?.stop() } catch (e) { console.warn('Failed to stop media recorder', e) }
      }, 50)
    } catch (err) {
      console.error('Failed to stop recorder', err)
      setError('Unable to finalize the recording. Refresh and try again.')
    }
    setIsRecording(false)
    if (timerIntervalRef.current) {
      window.clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }
    stopVisualizer()
  }

  const handleToggleRecording = () => {
    if (isRecording) stopRecording()
    else startRecording()
  }

  const handleApiKeyChange = (event: ChangeEvent<HTMLInputElement>) => {
    setApiKey(event.target.value.trim())
  }

  const handleModelSelect = (value: string) => {
    setSelectedModel(value)
  }

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError(null)
    setIsUploading(true)
    try {
      await handleTranscription(file, 'upload', Date.now())
    } catch (err) {
      console.error(err)
    } finally {
      setIsUploading(false)
      event.target.value = ''
    }
  }

  const handleTranscription = async (
    file: Blob | File,
    source: 'microphone' | 'upload',
    createdAt: number,
    durationMs?: number,
  ) => {
    if (!apiKey) {
      setError('Add your OpenAI API key to begin transcribing.')
      return
    }
    setIsProcessing(true)
    setError(null)

    try {
      const formData = new FormData()
      const rawFileName = source === 'microphone' ? `capture-${new Date().toISOString()}.webm` : (file as File).name || 'audio.webm'
      const fileName = sanitizeFileName(rawFileName) || 'audio.webm'
      formData.append('file', file, fileName)
      formData.append('model', selectedModel)
      // Use JSON when formatting or timestamps are enabled to capture structure; request granularities when supported
      if (formattedView || showTimestamps) {
        formData.append('response_format', 'json')
        // Some models support granularities via array params
        try {
          formData.append('timestamp_granularities[]', 'word')
          formData.append('timestamp_granularities[]', 'segment')
        } catch (e) {
          console.warn('timestamp granularities not supported by this model', e)
        }
      } else {
        formData.append('response_format', 'text')
      }
      if (languageHint.trim()) formData.append('language', languageHint.trim())
      if (shouldTranslate) formData.append('translate', 'true')
      formData.append('temperature', String(temperature))
      if (injectPrompt.trim()) formData.append('prompt', injectPrompt.trim())

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      })

      if (!response.ok) {
        const message = await response.json().catch(() => response.statusText)
        throw new Error(typeof message === 'string' ? message : message?.error?.message ?? 'Transcription failed')
      }

      const parsed = await parseTranscriptionResponse(response)
      setTranscript(parsed.text)
      setSegments(parsed.segments ?? null)
      setSummary('')
      const entryId = createEntryId()
      setCurrentEntryId(entryId)
      if (summaryEnabled) {
        void generateSummary(parsed.text, entryId)
      }
      if (autoCopyTranscript && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(formattedView && parsed.segments ? formatSegmentsToText(parsed.segments, showTimestamps) : parsed.text)
          setCopyState('copied')
          window.setTimeout(() => setCopyState('idle'), 2000)
        } catch (err) {
          console.warn('Unable to copy to clipboard automatically', err)
        }
      }

      const entry: HistoryEntry = {
        id: entryId,
        createdAt,
        durationMs,
        model: selectedModel,
        text: parsed.text,
        source,
        summary: summaryEnabled ? '' : undefined,
      }
      setHistory((prev) => [entry, ...prev].slice(0, 24))
      if (user && supabase) {
        await supabase
          .from('transcripts')
          .upsert(
            {
              id: entryId,
              user_id: user.id,
              created_at: new Date(createdAt).toISOString(),
              duration_ms: durationMs ?? null,
              model: selectedModel,
              text: parsed.text,
              source,
              summary: summaryEnabled ? '' : null,
            },
            { onConflict: 'id' },
          )
      }
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Unable to transcribe your audio. Try again.')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleCopyTranscript = async () => {
    if (!transcript) return
    try {
      const text = formattedView && segments ? formatSegmentsToText(segments, showTimestamps) : transcript
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 2000)
    } catch (err) {
      console.warn('Unable to copy transcript', err)
      setError('Clipboard permissions blocked. Copy manually instead.')
    }
  }

  const handleCopySummary = async () => {
    if (!summary) return
    try {
      await navigator.clipboard.writeText(summary)
    } catch (err) {
      console.warn('Unable to copy summary', err)
      setError('Clipboard permissions blocked. Copy manually instead.')
    }
  }

  const generateSummary = async (text: string, entryId?: string) => {
    if (!apiKey || !text.trim()) return
    setIsSummarizing(true)
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                'You summarize transcripts. Return a short title and 5-8 bullet points. Prefer facts; do not invent timestamps. If timestamps like [mm:ss] exist, keep them.',
            },
            { role: 'user', content: `Transcript:\n\n${text}` },
          ],
        }),
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => res.statusText)
        throw new Error(typeof msg === 'string' ? msg : msg?.error?.message ?? 'Summary failed')
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
      }
      const content = data?.choices?.[0]?.message?.content
      let finalSummary = ''
      if (typeof content === 'string') finalSummary = content.trim()
      else if (Array.isArray(content)) {
        finalSummary = content
          .map((c) => (typeof c?.text === 'string' ? c.text : ''))
          .join('\n')
          .trim()
      }
      if (!finalSummary) return
      const targetId = entryId ?? currentEntryId
      setSummary(finalSummary)
      if (targetId) {
        setHistory((prev) =>
          prev.map((entry) => (entry.id === targetId ? { ...entry, summary: finalSummary } : entry)),
        )
      }
      if (user && targetId && supabase) {
        const { error } = await supabase
          .from('transcripts')
          .update({ summary: finalSummary })
          .eq('id', targetId)
          .eq('user_id', user.id)
        if (error) console.error(error)
      }
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : 'Unable to generate summary')
    } finally {
      setIsSummarizing(false)
    }
  }

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) {
      setAuthError('Supabase is not configured. Provide VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable accounts.')
      return
    }
    setAuthError(null)
    setIsAuthLoading(true)
    try {
      if (authMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword })
        if (error) throw error
      } else {
        const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword })
        if (error) throw error
        setAuthMode('signin')
      }
      setAuthEmail('')
      setAuthPassword('')
    } catch (err) {
      console.error(err)
      setAuthError(err instanceof Error ? err.message : 'Unable to authenticate')
    } finally {
      setIsAuthLoading(false)
    }
  }

  const handleSignOut = async () => {
    if (supabase) await supabase.auth.signOut()
    setUser(null)
    setHistory([])
    setSummary('')
    setCurrentEntryId(null)
    setShowLanding(true)
  }

  const handleDownloadTranscript = () => {
    if (!transcript) return
    const text = formattedView && segments ? formatSegmentsToText(segments, showTimestamps) : transcript
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `aurora-transcript-${new Date().toISOString()}.txt`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const handleResetSession = () => {
    setTranscript('')
    setSegments(null)
    setError(null)
    setElapsedMs(0)
    recordStartRef.current = null
    setSummary('')
    setCurrentEntryId(null)
  }

  const handleSelectHistory = (entry: HistoryEntry) => {
    setTranscript(entry.text)
    setSelectedModel(entry.model)
    setSummary(entry.summary ?? '')
    setCurrentEntryId(entry.id)
  }

  const handleClearHistory = async () => {
    setHistory([])
    setSummary('')
    setCurrentEntryId(null)
    if (user && supabase) {
      const { error } = await supabase.from('transcripts').delete().eq('user_id', user.id)
      if (error) {
        console.error(error)
        setError(error.message)
      }
    }
  }

  return (
    <div className="app">
      {showLanding && (
        <>
          <div className="topbar">
            <div className="brand">Aurora</div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button className="ghost" onClick={() => setShowLanding(false)}>Skip</button>
              <button className="ghost" onClick={() => setShowSettings(true)}>
                <Gear size={16} /> Settings
              </button>
            </div>
          </div>
          <div className="center" style={{ textAlign: 'center', gap: 16 }}>
            <div className="panel">
              <h2 style={{ marginTop: 0 }}>Aurora Transcribe</h2>
              <p className="muted">Fast, polished browser-based transcription. Bring your API key and go.</p>
              {isSupabaseConfigured ? (
                <form className="row" style={{ gap: 12 }} onSubmit={handleAuthSubmit}>
                  <input className="input" type="email" placeholder="you@email.com" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} required />
                  <input className="input" type="password" placeholder="Password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required minLength={6} />
                  {authError && <div className="error">{authError}</div>}
                  <div className="actions" style={{ justifyContent: 'center' }}>
                    <button className="btn" type="submit" disabled={isAuthLoading}>
                      {isAuthLoading ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => setAuthMode((mode) => (mode === 'signin' ? 'signup' : 'signin'))}
                    >
                      {authMode === 'signin' ? 'Need an account?' : 'Have an account? Sign in'}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="actions" style={{ justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setShowLanding(false)}>Enter studio</button>
                </div>
              )}
              <p className="mini" style={{ marginTop: 4 }}>
                {isSupabaseConfigured
                  ? 'Signing in keeps your transcript history synced. Skipping uses local-only storage.'
                  : 'Cloud sync requires Supabase configuration. Until then, everything stays local.'}
              </p>
            </div>
          </div>
        </>
      )}
      {!showLanding && (
        <>
        <div className="topbar">
          <div className="brand">Aurora</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {user && <span className="muted small">{user.email}</span>}
            <button className="ghost" onClick={() => setShowSettings(true)}>
              <Gear size={16} /> Settings
            </button>
            {user && (
              <button className="ghost" onClick={handleSignOut}>Sign out</button>
            )}
          </div>
        </div>

        <div className="center">
          <div className="mini">
            <Clock size={14} /> {isRecording ? 'Recording…' : isProcessing ? 'Transcribing…' : 'Idle'} · {formatDuration(elapsedMs)} · {activeModel.label}
          </div>
        <button
          className={clsx('record', { recording: isRecording })}
          style={recordStyle}
          onClick={handleToggleRecording}
          disabled={isProcessing || (!isRecording && !apiKey)}
        >
          {isRecording ? <PauseCircle size={36} /> : <Mic size={36} />}
        </button>
        <div className="mini">{isRecording ? 'Tap to stop' : 'Tap to record or upload'}</div>
        <input ref={fileInputRef} type="file" accept="audio/*,video/*" onChange={handleFileUpload} style={{ display: 'none' }} disabled={isProcessing || isUploading} />
        <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={!apiKey || isProcessing || isUploading}>
          <UploadCloud size={16} /> {isUploading ? 'Uploading…' : 'Upload audio'}
        </button>
        {showWaveform && isRecording && <canvas ref={canvasRef} className="wave" width={320} height={64} />}
      </div>

      <div className="panel">
        <h3>Transcript</h3>
        <div className="transcript">
          {isProcessing && <p className="mini">Polishing transcript with OpenAI…</p>}
          {!isProcessing && !hasTranscript && <p className="mini">Your transcript will appear here.</p>}
          {!isProcessing && hasTranscript && <p>{displayTranscript}</p>}
        </div>
        <div className="actions">
          <button className="btn" onClick={handleCopyTranscript} disabled={!hasTranscript}>
            {copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}
            {copyState === 'copied' ? 'Copied' : 'Copy'}
          </button>
          <button className="btn" onClick={handleDownloadTranscript} disabled={!hasTranscript}>Download .txt</button>
        </div>
        {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      <div className="panel">
        <h3>Summary</h3>
        <div className="transcript">
          {isSummarizing && <p className="mini">Summarizing with GPT‑4.1 mini…</p>}
          {!isSummarizing && !summary && <p className="mini">Enable summaries in Settings → Transcription, or transcribe to generate one.</p>}
          {!isSummarizing && !!summary && <p>{summary}</p>}
        </div>
        <div className="actions">
          <button className="btn" onClick={handleCopySummary} disabled={!summary}>Copy</button>
        </div>
      </div>

      {showSettings && (
        <div className="overlay" onClick={() => setShowSettings(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <h2>Settings</h2>
              <button className="ghost" onClick={() => setShowSettings(false)}>
                <X size={16} /> Close
              </button>
            </div>

            <div className="segmented" style={{ marginBottom: 12 }}>
              {[
                { v: 'general', label: 'General' },
                { v: 'transcription', label: 'Transcription' },
                { v: 'appearance', label: 'Appearance' },
                { v: 'history', label: 'History' },
              ].map((t) => (
                <button key={t.v} className={clsx('segment', { active: settingsTab === (t.v as typeof settingsTab) })} onClick={() => setSettingsTab(t.v as typeof settingsTab)}>
                  {t.label}
                </button>
              ))}
            </div>

            {settingsTab === 'general' && (
              <>
                <div className="row">
                  <div className="muted small">API Key</div>
                  <div className="row-inline" style={{ gap: 8 }}>
                    <KeyRound size={16} />
                    <input className="input" type="password" value={apiKey} placeholder="sk-..." onChange={handleApiKeyChange} autoComplete="off" />
                  </div>
                  <label className="small">
                    <input type="checkbox" checked={rememberKey} onChange={() => setRememberKey((p) => !p)} /> Remember locally
                  </label>
                </div>

                <div className="row">
                  <div className="muted small">Model</div>
                  <div className="actions" style={{ gap: 8 }}>
                    <button
                      className="btn"
                      onClick={() => handleModelSelect('gpt-4o-mini-transcribe')}
                      aria-pressed={selectedModel === 'gpt-4o-mini-transcribe'}
                    >
                      GPT-4o mini transcribe
                    </button>
                    <button
                      className="btn"
                      onClick={() => handleModelSelect('gpt-4o-transcribe')}
                      aria-pressed={selectedModel === 'gpt-4o-transcribe'}
                    >
                      GPT-4o transcribe
                    </button>
                  </div>
                  <div className="muted small">{activeModel.description}</div>
                </div>

                <div className="row">
                  <label className="row-inline">
                    <span>Auto-save transcripts</span>
                    <input type="checkbox" checked={autoSaveHistory} onChange={() => setAutoSaveHistory((p) => !p)} />
                  </label>
                  <label className="row-inline">
                    <span>Auto copy to clipboard</span>
                    <input type="checkbox" checked={autoCopyTranscript} onChange={() => setAutoCopyTranscript((p) => !p)} />
                  </label>
                </div>
              </>
            )}

            {settingsTab === 'transcription' && (
              <>
                <div className="row">
                  <label className="row-inline">
                    <span>Translate to English</span>
                    <input type="checkbox" checked={shouldTranslate} onChange={() => setShouldTranslate((p) => !p)} />
                  </label>
                </div>
                <div className="row">
                  <label className="row-inline">
                    <span>Formatted paragraphs</span>
                    <input type="checkbox" checked={formattedView} onChange={() => setFormattedView((p) => !p)} />
                  </label>
                  <label className="row-inline">
                    <span>Include timestamps</span>
                    <input type="checkbox" checked={showTimestamps} onChange={() => setShowTimestamps((p) => !p)} />
                  </label>
                </div>
                <div className="row">
                  <label className="row-inline">
                    <span>Generate AI summary (GPT‑4.1 mini)</span>
                    <input type="checkbox" checked={summaryEnabled} onChange={() => setSummaryEnabled((p) => !p)} />
                  </label>
                </div>
                <div className="row">
                  <div className="muted small">Language hint</div>
                  <input className="input" placeholder="e.g. en, es" value={languageHint} onChange={(e) => setLanguageHint(e.target.value)} />
                </div>
                <div className="row">
                  <div className="muted small">Custom prompt</div>
                  <input className="input" placeholder="Context or domain vocabulary to boost accuracy" value={injectPrompt} onChange={(e) => setInjectPrompt(e.target.value)} />
                </div>
                <div className="row">
                  <div className="muted small">Temperature ({temperature.toFixed(2)})</div>
                  <input type="range" min={0} max={1} step={0.05} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} />
                </div>
              </>
            )}

            {settingsTab === 'appearance' && (
              <>
                <div className="row">
                  <label className="row-inline">
                    <span>Waveform visualiser</span>
                    <input type="checkbox" checked={showWaveform} onChange={() => setShowWaveform((p) => !p)} />
                  </label>
                  <label className="row-inline">
                    <span>Ambient background</span>
                    <input type="checkbox" checked={ambientGlow} onChange={() => setAmbientGlow((p) => !p)} />
                  </label>
                </div>
                <div className="row">
                  <div className="muted small">Record button color</div>
                  <div className="swatches">
                    {['#22c55e', '#10b981', '#06b6d4', '#6366f1', '#a78bfa', '#f59e0b', '#ef4444', '#e11d48'].map((c) => (
                      <button key={c} type="button" className={clsx('swatch', { active: recordColor === c })} style={{ background: c }} onClick={() => setRecordColor(c)} />
                    ))}
                  </div>
                  <div className="row-inline" style={{ gap: 8 }}>
                    <input type="color" value={recordColor} onChange={(e) => setRecordColor(e.target.value)} />
                    <span className="small muted">Pick a custom color</span>
                  </div>
                </div>
              </>
            )}

            {settingsTab === 'history' && (
              <>
                <div className="row">
                  <div className="muted small">History</div>
                  {historyLoading && <div className="muted small">Loading…</div>}
                  {history.length === 0 && <div className="muted small">No transcripts yet.</div>}
                  {history.length > 0 && (
                    <div className="history">
                      {history.map((entry) => (
                        <button key={entry.id} type="button" className="history-item" onClick={() => handleSelectHistory(entry)}>
                          <div className="history-header">
                            <span>{formatTimestamp(entry.createdAt)}</span>
                            <span>
                              {entry.durationMs ? formatDuration(entry.durationMs) : entry.source === 'upload' ? 'Uploaded' : 'Live'} ·{' '}
                              {MODEL_OPTIONS.find((m) => m.value === entry.model)?.label ?? entry.model}
                            </span>
                          </div>
                          <div className="history-preview">{entry.text}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="actions">
                    <button className="btn" onClick={handleResetSession}>Clear current</button>
                    <button className="btn" onClick={handleClearHistory}>Clear history</button>
                  </div>
                </div>
              </>
            )}

            {error && <div className="error">{error}</div>}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  )
}

export default App
