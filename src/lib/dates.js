let temporalLoadPromise = null

export async function ensureTemporal() {
  if (typeof globalThis.Temporal !== 'undefined') {
    return globalThis.Temporal
  }

  if (!temporalLoadPromise) {
    temporalLoadPromise = import('temporal-polyfill').then(mod => {
      globalThis.Temporal = mod.Temporal
      if (mod.toTemporalInstant && !Date.prototype.toTemporalInstant) {
        Date.prototype.toTemporalInstant = mod.toTemporalInstant
      }
      return globalThis.Temporal
    })
  }

  return temporalLoadPromise
}

export function getTodayPlainDate() {
  return Temporal.Now.plainDateISO()
}

export function getTodayIso() {
  return getTodayPlainDate().toString()
}

export function getTomorrowIso() {
  return getTodayPlainDate().add({ days: 1 }).toString()
}

export function getNextWeekIso() {
  return getTodayPlainDate().add({ weeks: 1 }).toString()
}

export function parsePlainDate(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return null
  try {
    return Temporal.PlainDate.from(isoDate.slice(0, 10))
  } catch {
    return null
  }
}

export function isDueToday(dueDateIso) {
  const date = parsePlainDate(dueDateIso)
  if (!date) return false
  return date.equals(getTodayPlainDate())
}

export function isOverdue(dueDateIso, isCompleted = false) {
  if (isCompleted) return false
  const date = parsePlainDate(dueDateIso)
  if (!date) return false
  return Temporal.PlainDate.compare(date, getTodayPlainDate()) < 0
}

export function formatMyDayHeading() {
  return getTodayPlainDate().toLocaleString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
}

export function formatDueDate(dueDateIso) {
  const date = parsePlainDate(dueDateIso)
  if (!date) return ''

  const today = getTodayPlainDate()
  if (date.equals(today)) return 'Today'
  if (date.equals(today.add({ days: 1 }))) return 'Tomorrow'
  if (date.equals(today.subtract({ days: 1 }))) return 'Yesterday'

  const options = {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  }
  if (date.year !== today.year) {
    options.year = 'numeric'
  }

  return date.toLocaleString(undefined, options)
}

function durationForRepeat(pattern) {
  switch (pattern) {
    case 'daily':
      return { days: 1 }
    case 'weekly':
      return { weeks: 1 }
    case 'monthly':
      return { months: 1 }
    case 'yearly':
      return { years: 1 }
    default:
      return null
  }
}

export function advanceDueDate(dueDateIso, repeatPattern) {
  const duration = durationForRepeat(repeatPattern)
  if (!duration) return dueDateIso || null
  const baseDate = parsePlainDate(dueDateIso) ?? getTodayPlainDate()
  return baseDate.add(duration, { overflow: 'constrain' }).toString()
}

export function advanceReminderAt(reminderIso, repeatPattern) {
  const duration = durationForRepeat(repeatPattern)
  if (!reminderIso || !duration) return null
  try {
    const tz = Temporal.Now.timeZoneId()
    const zoned = Temporal.Instant.from(reminderIso).toZonedDateTimeISO(tz)
    return zoned.add(duration, { overflow: 'constrain' }).toInstant().toString()
  } catch {
    return null
  }
}

export function toDateTimeLocalValue(isoString) {
  if (!isoString) return ''
  try {
    const tz = Temporal.Now.timeZoneId()
    const pdt = Temporal.Instant.from(isoString).toZonedDateTimeISO(tz).toPlainDateTime()
    const yyyy = String(pdt.year).padStart(4, '0')
    const mm = String(pdt.month).padStart(2, '0')
    const dd = String(pdt.day).padStart(2, '0')
    const hh = String(pdt.hour).padStart(2, '0')
    const min = String(pdt.minute).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`
  } catch {
    return ''
  }
}

export function fromDateTimeLocalValue(localValue) {
  if (!localValue || typeof localValue !== 'string') return null
  try {
    const tz = Temporal.Now.timeZoneId()
    const pdt = Temporal.PlainDateTime.from(localValue)
    return pdt.toZonedDateTime(tz).toInstant().toString()
  } catch {
    return null
  }
}

export function getReminderPresetIso(preset) {
  const tz = Temporal.Now.timeZoneId()
  const now = Temporal.Now.zonedDateTimeISO(tz)

  if (preset === 'later-today') {
    const next = now.add({ hours: 3 }).with({ minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
    return next.toInstant().toString()
  }

  if (preset === 'tomorrow-morning') {
    const tomorrow = now.toPlainDate().add({ days: 1 })
    const morning = tomorrow.toPlainDateTime(Temporal.PlainTime.from('09:00'))
    return morning.toZonedDateTime(tz).toInstant().toString()
  }

  if (preset === 'next-week') {
    const nextWeek = now.toPlainDate().add({ weeks: 1 })
    const morning = nextWeek.toPlainDateTime(Temporal.PlainTime.from('09:00'))
    return morning.toZonedDateTime(tz).toInstant().toString()
  }

  return null
}

export function formatReminder(reminderIso) {
  if (!reminderIso) return ''
  try {
    const tz = Temporal.Now.timeZoneId()
    const zoned = Temporal.Instant.from(reminderIso).toZonedDateTimeISO(tz)
    const today = getTodayPlainDate()
    const datePart = zoned.toPlainDate()
    const timeText = zoned.toPlainTime().toLocaleString(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    })

    if (datePart.equals(today)) return `Today, ${timeText}`
    if (datePart.equals(today.add({ days: 1 }))) return `Tomorrow, ${timeText}`
    if (datePart.equals(today.subtract({ days: 1 }))) return `Yesterday, ${timeText}`

    const dateText = datePart.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(datePart.year !== today.year ? { year: 'numeric' } : {})
    })
    return `${dateText}, ${timeText}`
  } catch {
    return ''
  }
}

export function isReminderPast(reminderIso, isCompleted = false) {
  if (isCompleted || !reminderIso) return false
  try {
    return Temporal.Instant.compare(Temporal.Instant.from(reminderIso), Temporal.Now.instant()) < 0
  } catch {
    return false
  }
}

export function formatRepeatLabel(pattern) {
  switch (pattern) {
    case 'daily':
      return 'Daily'
    case 'weekly':
      return 'Weekly'
    case 'monthly':
      return 'Monthly'
    case 'yearly':
      return 'Yearly'
    default:
      return ''
  }
}

export function formatCreatedStamp(isoString) {
  if (!isoString) return ''
  try {
    const tz = Temporal.Now.timeZoneId()
    const zoned = Temporal.Instant.from(isoString).toZonedDateTimeISO(tz)
    const datePart = zoned.toPlainDate()
    const today = getTodayPlainDate()
    if (datePart.equals(today)) {
      return `Created today at ${zoned.toPlainTime().toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    }
    return `Created ${datePart.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(datePart.year !== today.year ? { year: 'numeric' } : {})
    })}`
  } catch {
    return ''
  }
}
