// ============================================================================
// Log ra FILE — bản .exe đóng gói không có terminal, đây là kênh DUY NHẤT để
// biết máy ở venue hỏng chỗ nào. Luôn xin file này trước khi đoán bệnh.
// ============================================================================
import { appendFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const RING_MAX = 300
const ring: string[] = []
let logPath = ''

function ts(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function logFile(): string {
  if (!logPath) logPath = join(app.getPath('userData'), 'dimension.log')
  return logPath
}

export function log(tag: string, msg: string): void {
  const line = `${ts()} [${tag}] ${msg}`
  console.log(line)
  ring.push(line)
  if (ring.length > RING_MAX) ring.shift()
  try {
    appendFileSync(logFile(), line + '\n')
  } catch { /* không ghi được thì thôi, đã có console */ }
}

export function recentLog(n = 80): string[] {
  return ring.slice(-n)
}

export function logEnvironment(): void {
  log('env', `${process.platform} ${process.arch} · electron ${process.versions.electron} · chrome ${process.versions.chrome}`)
  log('env', `log file: ${logFile()}`)
}
