import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

import parkingMap from './assets/overflow-parking.jpg'
import wingsLogo from './assets/wings-logo.png'
import './App.css'

const API_URL =
  'https://script.google.com/macros/s/AKfycbwrQ6sw4zTUetLdtfrmRDwUlpob74SQ04mlZXp-XLI51MsurDeTm6aAUSRq052oE8BP/exec'

const SCHEDULES = [
  {
    key: 'b',
    label: 'Mite B',
    sheetName: 'Mite B Schedule',
  },
  {
    key: 'c',
    label: 'Mite C',
    sheetName: 'Mite C Schedule',
  },
]

// Apps Script usually answers in 2–4s, but some requests stall for
// much longer. A request still pending after HEDGE_DELAY_MS gets a
// duplicate started alongside it instead of being abandoned (it may
// be about to finish), and the first good answer wins. Failed
// requests are retried; each one gives up after REQUEST_TIMEOUT_MS.
const HEDGE_DELAY_MS = 6 * 1000
const RETRY_DELAY_MS = 1000
const REQUEST_TIMEOUT_MS = 30 * 1000
const MAX_REQUESTS = 3

// One request, abandoned if it outlives REQUEST_TIMEOUT_MS or
// `signal` aborts.
async function fetchSchedule(sheetName, signal) {
  const controller = new AbortController()
  const abort = () => controller.abort()

  const timer = setTimeout(
    abort,
    REQUEST_TIMEOUT_MS,
  )

  signal?.addEventListener('abort', abort)

  try {
    const url =
      `${API_URL}` +
      `?sheet=${encodeURIComponent(sheetName)}` +
      `&t=${Date.now()}`

    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(
        `Schedule API returned ${response.status}.`,
      )
    }

    let data

    try {
      data = await response.json()
    } catch {
      throw new Error(
        'The schedule API did not return valid JSON.',
      )
    }

    if (!data.success) {
      throw new Error(
        data.error ||
          'Unable to load the schedule.',
      )
    }

    return {
      headers: Array.isArray(data.headers)
        ? data.headers
        : [],
      rows: Array.isArray(data.rows)
        ? data.rows
        : [],
      updatedAt: Date.now(),
    }
  } catch (err) {
    if (
      controller.signal.aborted &&
      !signal?.aborted
    ) {
      throw new Error(
        'The schedule API took too long to respond.',
        { cause: err },
      )
    }

    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

// Up to MAX_REQUESTS requests, per the policy above.
function loadSchedule(sheetName, signal) {
  return new Promise((resolve, reject) => {
    // Aborted once settled, cancelling requests still in flight.
    const controller =
      new AbortController()

    let started = 0
    let failed = 0
    let settled = false
    let timer

    const settle = (callback, value) => {
      if (settled) return

      settled = true

      clearTimeout(timer)
      controller.abort()
      signal?.removeEventListener('abort', cancel)

      callback(value)
    }

    const cancel = () =>
      settle(
        reject,
        new DOMException('Aborted', 'AbortError'),
      )

    const start = () => {
      started += 1

      if (started < MAX_REQUESTS) {
        timer = setTimeout(
          start,
          HEDGE_DELAY_MS,
        )
      }

      fetchSchedule(
        sheetName,
        controller.signal,
      ).then(
        (schedule) => settle(resolve, schedule),
        (err) => {
          if (settled) return

          failed += 1

          if (failed === MAX_REQUESTS) {
            settle(reject, err)
          } else if (failed === started) {
            // Nothing left in flight, so retry now rather
            // than waiting out the hedge delay.
            clearTimeout(timer)

            timer = setTimeout(
              start,
              RETRY_DELAY_MS,
            )
          }
        },
      )
    }

    if (signal?.aborted) {
      cancel()
      return
    }

    signal?.addEventListener('abort', cancel)

    start()
  })
}

// The last good copy of each schedule is kept on this device. It's
// shown (silently) if the API fails or takes longer than
// SAVED_FALLBACK_MS; a fresh copy that arrives later replaces it.
const SAVED_FALLBACK_MS = 8 * 1000

const SAVED_SCHEDULE_PREFIX =
  'mites-schedule:v1:'

function readSavedSchedule(sheetName) {
  try {
    const saved = JSON.parse(
      localStorage.getItem(
        SAVED_SCHEDULE_PREFIX + sheetName,
      ),
    )

    return Array.isArray(saved?.headers) &&
      Array.isArray(saved?.rows) &&
      Number.isFinite(saved?.updatedAt)
      ? saved
      : null
  } catch {
    return null
  }
}

function saveSchedule(sheetName, schedule) {
  try {
    localStorage.setItem(
      SAVED_SCHEDULE_PREFIX + sheetName,
      JSON.stringify(schedule),
    )
  } catch {
    // Storage can be full or blocked (e.g. in a third-party
    // iframe); the saved copy is only a convenience.
  }
}

// State updater that merges `changes` into one division.
function patchDivision(key, changes) {
  return (current) => ({
    ...current,
    [key]: {
      ...current[key],
      ...changes,
    },
  })
}

function findHeader(headers, candidates) {
  return headers.find((header) =>
    candidates.some(
      (candidate) =>
        String(header)
          .trim()
          .toLowerCase() === candidate,
    ),
  )
}

function parseDate(value) {
  const text = String(value).trim()

  const isoDate = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  )

  if (isoDate) {
    return new Date(
      Number(isoDate[1]),
      Number(isoDate[2]) - 1,
      Number(isoDate[3]),
    )
  }

  const usDate = text.match(
    /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/,
  )

  if (usDate) {
    const year = usDate[3]
      ? Number(usDate[3].padStart(4, '20'))
      : new Date().getFullYear()

    return new Date(
      year,
      Number(usDate[1]) - 1,
      Number(usDate[2]),
    )
  }

  // "Sat, Oct 10, 2026" — parsed explicitly since browsers disagree on
  // free-form dates.
  const longDate = text.match(
    /^(?:[a-z]+,?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i,
  )

  if (longDate) {
    const month = MONTHS.indexOf(
      longDate[1].toLowerCase(),
    )

    if (month !== -1) {
      return new Date(
        Number(longDate[3]),
        month,
        Number(longDate[2]),
      )
    }
  }

  const parsed = new Date(text)

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed
}

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]

const DAY_MS = 24 * 60 * 60 * 1000

// Sunday games belong to the weekend that starts the day before;
// every other day stands alone.
function weekendStart(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() -
      (date.getDay() === 0 ? 1 : 0),
  )
}

// Consecutive rows grouped by month, then by day.
function groupByMonthAndDay(rows, dateHeader) {
  const months = []

  rows.forEach((row) => {
    const raw = String(
      row[dateHeader] ?? '',
    ).trim()

    const date = raw ? parseDate(raw) : null

    const monthLabel = date
      ? date.toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric',
        })
      : 'Date TBD'

    let month = months[months.length - 1]

    if (!month || month.label !== monthLabel) {
      month = { label: monthLabel, days: [] }
      months.push(month)
    }

    let day = month.days[month.days.length - 1]

    if (!day || day.raw !== raw) {
      day = { raw, date, rows: [] }
      month.days.push(day)
    }

    day.rows.push(row)
  })

  return months
}

const HIDE_AFTER_MS = 12 * 60 * 60 * 1000

function parseTime(value) {
  const text = String(value ?? '').trim()

  if (!text) return null

  // Full timestamps (e.g. Sheets time cells serialized as dates)
  if (/T\d{2}:\d{2}/.test(text)) {
    const parsed = new Date(text)

    return Number.isNaN(parsed.getTime())
      ? null
      : {
          hours: parsed.getHours(),
          minutes: parsed.getMinutes(),
        }
  }

  const twelveHour = text.match(
    /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?\s*m?\.?$/i,
  )

  if (twelveHour) {
    const hours =
      (Number(twelveHour[1]) % 12) +
      (twelveHour[3].toLowerCase() === 'p' ? 12 : 0)

    return {
      hours,
      minutes: Number(twelveHour[2] || 0),
    }
  }

  const twentyFourHour = text.match(
    /^(\d{1,2}):(\d{2})(?::\d{2})?$/,
  )

  if (twentyFourHour) {
    return {
      hours: Number(twentyFourHour[1]),
      minutes: Number(twentyFourHour[2]),
    }
  }

  return null
}

// Every division is shown with Mite B's columns, in Mite B's order.
// Sheet headers are matched case-insensitively; unknown columns go last.
const STANDARD_COLUMNS = [
  'DATE',
  'RINK',
  'START TIME',
  'END TIME',
  'Level',
  'Rink Location',
  'Format',
  'HOME TEAM',
  'AWAY TEAM',
]

const DEFAULT_RINK = 'Wings Arena'

// Team names stay left-aligned so they scan easily; everything else
// is centered.
const CENTERED_COLUMNS = [
  'DATE',
  'RINK',
  'START TIME',
  'Level',
  'Rink Location',
  'Format',
]

// Sized to their content, leaving the spare width to the team names.
const NARROW_COLUMNS = [
  'RINK',
  'START TIME',
  'Level',
  'Format',
]

// "7:00:00" -> "7:00 AM". Values that can't be read are left as-is.
function formatTime(value) {
  const time = parseTime(value)

  if (!time) return value

  const minutes = String(time.minutes).padStart(2, '0')
  const period = time.hours < 12 ? 'AM' : 'PM'

  return `${time.hours % 12 || 12}:${minutes} ${period}`
}

function standardizeSchedule({ headers, rows }) {
  const standardName = (header) =>
    STANDARD_COLUMNS.find(
      (column) =>
        column.toLowerCase() ===
        String(header).trim().toLowerCase(),
    ) ?? header

  const renamed = headers.map(standardName)

  const standardHeaders = [
    ...STANDARD_COLUMNS.filter(
      (column) =>
        renamed.includes(column) ||
        column === 'RINK',
    ),
    ...renamed.filter(
      (header) =>
        !STANDARD_COLUMNS.includes(header),
    ),
  ]

  const standardRows = rows.map((row) => {
    const standardRow = {}

    headers.forEach((header, index) => {
      standardRow[renamed[index]] = row[header]
    })

    // The sheets say "WINGS"; show the full name.
    if (
      !standardRow.RINK ||
      String(standardRow.RINK).trim().toLowerCase() ===
        'wings'
    ) {
      standardRow.RINK = DEFAULT_RINK
    }

    ;['START TIME', 'END TIME'].forEach(
      (column) => {
        if (standardRow[column]) {
          standardRow[column] = formatTime(
            standardRow[column],
          )
        }
      },
    )

    return standardRow
  })

  return {
    headers: standardHeaders,
    rows: standardRows,
  }
}

// When the game is over: end time if known, else start time, else end of day.
function getGameEnd(row, primaryHeaders) {
  const date = primaryHeaders.date
    ? parseDate(row[primaryHeaders.date] ?? '')
    : null

  if (!date) return null

  const time =
    parseTime(row[primaryHeaders.end]) ||
    parseTime(row[primaryHeaders.start]) ||
    { hours: 23, minutes: 59 }

  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    time.hours,
    time.minutes,
  )
}

// Every sheet's date shown as "Saturday | 10/10/26" ("SAT" when narrow); unreadable values are left as-is.
function formatDateWithWeekday(value) {
  if (!value) return value

  const date = parseDate(String(value).trim())

  if (!date) return value

  return (
    <>
      {/* Full weekday, swapped for the short one on narrower screens (CSS). */}
      <span className="weekday-long">
        {date.toLocaleDateString('en-US', {
          weekday: 'long',
        })}
      </span>

      <span className="weekday-short">
        {date
          .toLocaleDateString('en-US', {
            weekday: 'short',
          })
          .toUpperCase()}
      </span>

      <span
        className="date-divider"
        aria-hidden="true"
      />

      {date.toLocaleDateString('en-US', {
        month: 'numeric',
        day: 'numeric',
        year: '2-digit',
      })}
    </>
  )
}

function ScheduleTable({ schedule }) {
  const { headers, rows: allRows } = useMemo(
    () => standardizeSchedule(schedule),
    [schedule],
  )

  // Finished games are hidden based on the time the page loaded.
  const [now] = useState(() => Date.now())

  const primaryHeaders = useMemo(() => {
    const date = findHeader(headers, [
      'date',
    ])

    const start = findHeader(headers, [
      'start time',
      'start',
    ])

    const end = findHeader(headers, [
      'end time',
      'end',
    ])

    const home = findHeader(headers, [
      'home team',
      'home',
    ])

    const away = findHeader(headers, [
      'away team',
      'away',
    ])

    return {
      date,
      start,
      end,
      home,
      away,
    }
  }, [headers])

  // Hide games 12 hours after they finish; rows without a readable date stay visible.
  const rows = useMemo(
    () =>
      allRows.filter((row) => {
        const gameEnd = getGameEnd(
          row,
          primaryHeaders,
        )

        return (
          !gameEnd ||
          now < gameEnd.getTime() + HIDE_AFTER_MS
        )
      }),
    [allRows, primaryHeaders, now],
  )

  // Drop End Time and place Home/Away Team right after Start Time.
  const displayHeaders = useMemo(() => {
    const { start, end, home, away } =
      primaryHeaders

    const teams = [home, away].filter(Boolean)

    const remaining = headers.filter(
      (header) =>
        header !== end &&
        !teams.includes(header),
    )

    const startIndex = remaining.indexOf(start)

    if (startIndex === -1) {
      return [...remaining, ...teams]
    }

    return [
      ...remaining.slice(0, startIndex + 1),
      ...teams,
      ...remaining.slice(startIndex + 1),
    ]
  }, [headers, primaryHeaders])

  // The next weekend with games is pulled out so it stands apart from later games.
  const featured = useMemo(() => {
    const dates = rows.map((row) =>
      primaryHeaders.date
        ? parseDate(row[primaryHeaders.date] ?? '')
        : null,
    )

    const weekends = dates.map((date) =>
      date ? weekendStart(date).getTime() : null,
    )

    const next = Math.min(
      ...weekends.filter((time) => time !== null),
    )

    if (!Number.isFinite(next)) {
      return { rows: [], laterRows: rows }
    }

    const today = new Date(now)

    const daysAway =
      (next -
        new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate(),
        ).getTime()) /
      DAY_MS

    const days = [
      ...new Set(
        dates
          .filter((_, index) => weekends[index] === next)
          .map((date) =>
            date.toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            }),
          ),
      ),
    ]

    return {
      rows: rows.filter(
        (_, index) => weekends[index] === next,
      ),
      laterRows: rows.filter(
        (_, index) => weekends[index] !== next,
      ),
      label:
        new Date(next).getDay() === 6 && daysAway < 7
          ? 'This Weekend'
          : 'Next Games',
      days: days.join(' & '),
    }
  }, [rows, primaryHeaders, now])

  // Mobile agenda: later games grouped by month, then by day (like Google Calendar's schedule view).
  const agenda = useMemo(
    () =>
      groupByMonthAndDay(
        featured.laterRows,
        primaryHeaders.date,
      ),
    [featured, primaryHeaders],
  )

  const featuredDays = useMemo(
    () =>
      groupByMonthAndDay(
        featured.rows,
        primaryHeaders.date,
      ).flatMap((month) => month.days),
    [featured, primaryHeaders],
  )

  // Alignment and width classes, shared by each header and its cells.
  const columnClass = (header) =>
    [
      (header === primaryHeaders.home ||
        header === primaryHeaders.away) &&
        'team-cell',
      CENTERED_COLUMNS.includes(header) &&
        'cell-center',
      NARROW_COLUMNS.includes(header) &&
        'col-narrow',
    ]
      .filter(Boolean)
      .join(' ') || undefined

  const renderRow = (row, rowIndex, group) => (
    <tr
      key={
        `${group}-${rowIndex}-` +
        `${row[primaryHeaders.date] || ''}-` +
        `${row[primaryHeaders.start] || ''}`
      }
    >
      {displayHeaders.map((header) => (
        <td
          key={`${rowIndex}-${header}`}
          data-label={header}
          className={columnClass(header)}
        >
          {(header === primaryHeaders.date
            ? formatDateWithWeekday(
                row[header],
              )
            : row[header]) || (
            <span className="dash">
              —
            </span>
          )}
        </td>
      ))}
    </tr>
  )

  const renderDay = (day, dayIndex) => {
    const isToday =
      day.date &&
      day.date.toDateString() ===
        new Date().toDateString()

    return (
      <div
        className="agenda-day"
        key={`${day.raw}-${dayIndex}`}
      >
        <div
          className={
            `agenda-date` +
            `${isToday ? ' today' : ''}`
          }
        >
          {day.date ? (
            <>
              <span className="agenda-weekday">
                {day.date.toLocaleDateString(
                  'en-US',
                  { weekday: 'short' },
                )}
              </span>

              <span className="agenda-daynum">
                {day.date.getDate()}
              </span>
            </>
          ) : (
            <span className="agenda-weekday">
              {day.raw || 'TBD'}
            </span>
          )}
        </div>

        <ul className="agenda-events">
          {day.rows.map((row, rowIndex) => {
            const details = displayHeaders.filter(
              (header) =>
                row[header] &&
                ![
                  primaryHeaders.date,
                  primaryHeaders.start,
                  primaryHeaders.home,
                  primaryHeaders.away,
                ].includes(header),
            )

            return (
              <li
                className="agenda-event"
                key={rowIndex}
              >
                <span className="agenda-event-title">
                  {row[primaryHeaders.home] ||
                    'TBD'}

                  <span className="vs">
                    vs
                  </span>

                  {row[primaryHeaders.away] ||
                    'TBD'}
                </span>

                <span className="agenda-event-time">
                  {row[primaryHeaders.start] ||
                    'Time TBD'}
                </span>

                {details.length > 0 && (
                  <span className="agenda-event-meta">
                    {details.map((header) => (
                      <span key={header}>
                        <span className="agenda-meta-label">
                          {header}
                        </span>

                        {row[header]}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  if (!rows.length) {
    return (
      <div className="empty-state">
        {allRows.length
          ? 'No upcoming games for this division.'
          : 'No schedule rows were found for this division.'}
      </div>
    )
  }

  return (
    <>
      {/* DESKTOP / TABLET */}

      <div className="desktop-schedule">
        {/* Tab on the table's top-right corner naming the highlighted rows. */}
        {featured.rows.length > 0 && (
          <div className="featured-tab">
            {featured.label}

            <span
              className="tab-divider"
              aria-hidden="true"
            />

            <span className="group-dates">
              {featured.days}
            </span>
          </div>
        )}

        <div
          className="desktop-table-wrap"
          aria-label="Mites game schedule"
        >
          <table className="schedule-table">
            <thead>
              <tr>
                {displayHeaders.map((header) => (
                  <th
                    key={header}
                    scope="col"
                    className={columnClass(header)}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>

            {featured.rows.length > 0 && (
              <tbody className="featured-games">
                {featured.rows.map((row, rowIndex) =>
                  renderRow(row, rowIndex, 'featured'),
                )}
              </tbody>
            )}

            {featured.laterRows.length > 0 && (
              <tbody className="later-games">
                {featured.laterRows.map((row, rowIndex) =>
                  renderRow(row, rowIndex, 'later'),
                )}
              </tbody>
            )}
          </table>
        </div>
      </div>

      {/* MOBILE */}

      <div
        className="mobile-schedule"
        aria-label="Mites game schedule"
      >
        {featuredDays.length > 0 && (
          <section className="agenda-featured">
            <h3 className="agenda-featured-label">
              {featured.label}

              <span className="group-dates">
                {featured.days}
              </span>
            </h3>

            {featuredDays.map(renderDay)}
          </section>
        )}

        {agenda.map((month, monthIndex) => (
          <section
            className="agenda-month"
            key={`${month.label}-${monthIndex}`}
          >
            <h3 className="agenda-month-label">
              {month.label}
            </h3>

            {month.days.map(renderDay)}
          </section>
        ))}
      </div>
    </>
  )
}

function App() {
  const [activeKey, setActiveKey] =
    useState('b')

  // Each division loads on its own.
  const [divisions, setDivisions] =
    useState(() =>
      Object.fromEntries(
        SCHEDULES.map((config) => [
          config.key,
          {
            schedule: null,
            status: 'loading',
            error: '',
          },
        ]),
      ),
    )

  const refreshDivision = useCallback(
    async (config, signal) => {
      const saved = readSavedSchedule(
        config.sheetName,
      )

      // Show the saved copy unless something is already showing.
      const showSaved = () => {
        if (!saved) return

        setDivisions((current) =>
          current[config.key].schedule
            ? current
            : patchDivision(config.key, {
                schedule: saved,
              })(current),
        )
      }

      const fallbackTimer = setTimeout(
        showSaved,
        SAVED_FALLBACK_MS,
      )

      try {
        const schedule = await loadSchedule(
          config.sheetName,
          signal,
        )

        saveSchedule(
          config.sheetName,
          schedule,
        )

        setDivisions(
          patchDivision(config.key, {
            schedule,
            status: 'ready',
            error: '',
          }),
        )
      } catch (err) {
        if (signal?.aborted) return

        console.error(
          'Schedule loading error:',
          err,
        )

        showSaved()

        setDivisions(
          patchDivision(config.key, {
            status: 'error',
            error:
              err?.message ||
              'Unable to load the schedule from the schedule API.',
          }),
        )
      } finally {
        clearTimeout(fallbackTimer)
      }
    },
    [],
  )

  useEffect(() => {
    const controller =
      new AbortController()

    SCHEDULES.forEach((config) =>
      refreshDivision(
        config,
        controller.signal,
      ),
    )

    return () => controller.abort()
  }, [refreshDivision])

  const activeConfig =
    SCHEDULES.find(
      (schedule) =>
        schedule.key === activeKey,
    )

  const {
    schedule: activeSchedule,
    status,
    error,
  } = divisions[activeKey]

  const retryActive = () => {
    setDivisions(
      patchDivision(activeKey, {
        status: 'loading',
        error: '',
      }),
    )

    refreshDivision(activeConfig)
  }

  return (
    <main className="app-shell">
      {/* HERO */}

      <section className="hero">
        <div className="hero-copy">

          <h1>
            Mites B/C Schedules
          </h1>

          <p>
            Game dates, times, matchups and parking info
          </p>
        </div>

        <img
          className="hero-logo"
          src={wingsLogo}
          alt="Wings Arena logo"
        />
      </section>

      {/* SCHEDULE */}

      <section
        className="schedule-section"
        id="schedule"
      >
        <div className="section-heading-row">
          <div>
            <p className="section-kicker">
              GAME SCHEDULE
            </p>

            <h2>
              {activeConfig?.label} Schedule
            </h2>
          </div>
        </div>

        <div
          className="division-tabs"
          role="tablist"
          aria-label="Mites divisions"
        >
          {SCHEDULES.map((schedule) => (
            <button
              key={schedule.key}
              type="button"
              role="tab"
              aria-selected={
                activeKey === schedule.key
              }
              className={
                `division-tab ` +
                `${
                  activeKey === schedule.key
                    ? 'active'
                    : ''
                }`
              }
              onClick={() =>
                setActiveKey(
                  schedule.key,
                )
              }
            >
              {schedule.label}
            </button>
          ))}
        </div>

        {!activeSchedule &&
          status === 'loading' && (
            <div className="loading-state">
              Loading schedule…
            </div>
          )}

        {!activeSchedule &&
          status === 'error' && (
            <div className="error-state">
              <strong>
                Schedule could not load.
              </strong>

              <span>
                {error}
              </span>

              <button
                type="button"
                className="retry-button"
                onClick={retryActive}
              >
                Try again
              </button>
            </div>
          )}

        {activeSchedule && (
          <ScheduleTable
            schedule={activeSchedule}
          />
        )}
      </section>

      {/* OVERFLOW PARKING */}

      <section
        className="parking-section"
        id="overflow-parking"
      >
        <div className="parking-copy">
          <p className="section-kicker red">
            PARKING INFORMATION
          </p>

          <h2>
            Overflow Parking at Wings Arena
          </h2>

          <p>
            We have a full schedule of games this
            weekend, so please share with your
            families the below information regarding{' '}
            <strong>
              “Overflow Parking.”
            </strong>
          </p>

          <p>
            Please use either:
          </p>

          <div className="parking-options">
            <div className="parking-option">
              <span className="parking-number">
                1
              </span>

              <div>
                <strong>
                  Street parking on Barry Place
                </strong>
              </div>
            </div>

            <div className="parking-option">
              <span className="parking-number">
                2
              </span>

              <div>
                <strong>
                  St. Clement’s Church parking lot
                </strong>

                <span>
                  We now have permission to use it.
                </span>
              </div>
            </div>
          </div>

          <p>
            See map attached for reference.
          </p>

          <div className="dropoff-note">
            If you need to use overflow parking,
            we encourage you to drop off your child
            and equipment at the main entrance first.
            We recognize that this is a long walk
            and apologize for the inconvenience.
          </div>
        </div>

        <figure className="parking-map-card">
          <img
            src={parkingMap}
            alt="Overflow parking map showing street parking on Barry Place, St. Clement's Church parking, and the walking route to Wings Arena."
          />

          <figcaption>
            Overflow parking locations and walking
            route to Wings Arena.
          </figcaption>
        </figure>
      </section>
    </main>
  )
}

export default App