import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import './App.css'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
)

const STORAGE_KEY = 'weight-loss-daily-entries-v1'

const toIsoDate = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return date.toISOString().slice(0, 10)
}

const formatDate = (isoDate) => {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) {
    return isoDate
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

const todayIso = toIsoDate(new Date())

const normalizeEntries = (rawEntries) => {
  if (!Array.isArray(rawEntries)) {
    return []
  }

  const normalizedMap = new Map()

  rawEntries.forEach((entry) => {
    const date = toIsoDate(entry?.date)
    const weight = Number(entry?.weight)

    if (!date || !Number.isFinite(weight) || weight <= 0) {
      return
    }

    normalizedMap.set(date, {
      date,
      weight: Number(weight.toFixed(2)),
    })
  })

  return Array.from(normalizedMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  )
}

const linearRegression = (values) => {
  const n = values.length
  if (n < 2) {
    return null
  }

  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0

  for (let i = 0; i < n; i += 1) {
    const x = i
    const y = values[i]
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  }

  const denominator = n * sumXX - sumX * sumX
  if (denominator === 0) {
    return null
  }

  const slope = (n * sumXY - sumX * sumY) / denominator
  const intercept = (sumY - slope * sumX) / n
  return { slope, intercept }
}

function App() {
  const [entries, setEntries] = useState([])
  const [form, setForm] = useState({
    date: todayIso,
    weight: '',
  })
  const [error, setError] = useState('')
  const [backupMessage, setBackupMessage] = useState('')
  const fileInputRef = useRef(null)

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) {
      return
    }

    try {
      const parsed = JSON.parse(saved)
      setEntries(normalizeEntries(parsed))
    } catch {
      setEntries([])
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  }, [entries])

  const stats = useMemo(() => {
    if (entries.length === 0) {
      return {
        latest: null,
        delta7d: null,
        avg: null,
      }
    }

    const latest = entries[entries.length - 1]
    const avg = entries.reduce((sum, item) => sum + item.weight, 0) / entries.length

    let delta7d = null
    if (entries.length >= 2) {
      const lastIndex = entries.length - 1
      const compareIndex = Math.max(0, lastIndex - 7)
      delta7d = latest.weight - entries[compareIndex].weight
    }

    return {
      latest,
      delta7d,
      avg,
    }
  }, [entries])

  const forecast = useMemo(() => {
    if (entries.length < 4) {
      return {
        next7: [],
        trendPerDay: null,
        predicted30d: null,
      }
    }

    const model = linearRegression(entries.map((entry) => entry.weight))
    if (!model) {
      return {
        next7: [],
        trendPerDay: null,
        predicted30d: null,
      }
    }

    const { slope, intercept } = model
    const next7 = []
    const baseLength = entries.length

    for (let i = 0; i < 7; i += 1) {
      const sourceDate = new Date(entries[entries.length - 1].date)
      sourceDate.setDate(sourceDate.getDate() + i + 1)
      const futureWeight = slope * (baseLength + i) + intercept

      next7.push({
        date: toIsoDate(sourceDate),
        weight: Number(futureWeight.toFixed(2)),
      })
    }

    const predicted30d = Number((slope * (baseLength + 29) + intercept).toFixed(2))

    return {
      next7,
      trendPerDay: slope,
      predicted30d,
    }
  }, [entries])

  const chartData = useMemo(() => {
    const labels = [
      ...entries.map((entry) => formatDate(entry.date)),
      ...forecast.next7.map((entry) => formatDate(entry.date)),
    ]

    const actualPoints = [
      ...entries.map((entry) => entry.weight),
      ...Array.from({ length: forecast.next7.length }, () => null),
    ]

    const predictionPoints = [
      ...Array.from({ length: entries.length - 1 }, () => null),
      entries.length > 0 ? entries[entries.length - 1].weight : null,
      ...forecast.next7.map((item) => item.weight),
    ]

    return {
      labels,
      datasets: [
        {
          label: 'Actual weight',
          data: actualPoints,
          borderColor: '#0ea5a0',
          backgroundColor: 'rgba(14, 165, 160, 0.18)',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: '#0b7f7b',
        },
        {
          label: 'Forecast (next 7 days)',
          data: predictionPoints,
          borderColor: '#f97316',
          backgroundColor: '#f97316',
          borderDash: [8, 6],
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
      ],
    }
  }, [entries, forecast])

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          usePointStyle: true,
          boxWidth: 8,
          boxHeight: 8,
          padding: 16,
        },
      },
      title: {
        display: true,
        text: 'Your Weight Journey',
        color: '#0f172a',
        font: {
          size: 18,
          weight: '700',
        },
        padding: {
          top: 4,
          bottom: 14,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        padding: 12,
        cornerRadius: 10,
        callbacks: {
          title: (context) => `Date: ${context[0]?.label ?? ''}`,
          label: (context) => `${context.dataset.label}: ${context.parsed.y?.toFixed(1)} kg`,
        },
      },
    },
    scales: {
      x: {
        grid: {
          display: false,
        },
        ticks: {
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8,
          color: '#64748b',
        },
      },
      y: {
        border: {
          display: false,
        },
        grid: {
          color: 'rgba(148, 163, 184, 0.22)',
          drawTicks: false,
        },
        ticks: {
          color: '#64748b',
          callback: (value) => `${value} kg`,
        },
        title: {
          display: true,
          text: 'Weight (kg)',
          color: '#475569',
          font: {
            weight: '600',
          },
        },
      },
    },
  }

  const submitEntry = (event) => {
    event.preventDefault()
    setError('')

    const date = toIsoDate(form.date)
    const weight = Number(form.weight)

    if (!date) {
      setError('Invalid date. Please choose a valid day.')
      return
    }

    if (!Number.isFinite(weight) || weight <= 0) {
      setError('Weight must be greater than 0.')
      return
    }

    setEntries((previous) => {
      const existing = previous.filter((item) => item.date !== date)
      return normalizeEntries([
        ...existing,
        {
          date,
          weight,
        },
      ])
    })

    setForm((previous) => ({
      ...previous,
      weight: '',
    }))
  }

  const removeEntry = (date) => {
    setEntries((previous) => previous.filter((entry) => entry.date !== date))
  }

  const exportToJson = () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `weight-backup-${toIsoDate(new Date())}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    setBackupMessage('Da export file JSON thanh cong.')
  }

  const importFromJson = async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const sourceEntries = Array.isArray(parsed) ? parsed : parsed?.entries
      const normalized = normalizeEntries(sourceEntries)

      if (normalized.length === 0) {
        setBackupMessage('No valid entries found in this file.')
        return
      }

      setEntries(normalized)
      setBackupMessage(`Imported ${normalized.length} entries from JSON.`)
    } catch {
      setBackupMessage('Could not read this JSON file. Please check the format.')
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <p className="eyebrow">Weight Forecast</p>
        <h1>Daily Weight Tracker</h1>
        <p className="subhead">
          Log your weight in seconds, follow your trend, and get a clear forecast for the next few weeks.
        </p>
      </header>

      <section className="panel">
        <h2>Add New Entry</h2>
        <form className="entry-form" onSubmit={submitEntry}>
          <label>
            Date
            <input
              type="date"
              value={form.date}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, date: event.target.value }))
              }
            />
          </label>

          <label>
            Weight (kg)
            <input
              type="number"
              step="0.1"
              min="1"
              placeholder="e.g. 72.4"
              value={form.weight}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, weight: event.target.value }))
              }
            />
          </label>

          <button type="submit">Save Entry</button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <h3>Latest Record</h3>
          <p className="value">
            {stats.latest ? `${stats.latest.weight.toFixed(1)} kg` : '--'}
          </p>
          <small>{stats.latest ? formatDate(stats.latest.date) : 'No data yet'}</small>
        </article>

        <article className="stat-card">
          <h3>~7-Day Change</h3>
          <p className="value">
            {stats.delta7d === null
              ? '--'
              : `${stats.delta7d > 0 ? '+' : ''}${stats.delta7d.toFixed(2)} kg`}
          </p>
          <small>{stats.delta7d === null ? 'Need at least 2 records' : 'Compared to an earlier point'}</small>
        </article>

        <article className="stat-card">
          <h3>Overall Average</h3>
          <p className="value">{stats.avg === null ? '--' : `${stats.avg.toFixed(2)} kg`}</p>
          <small>Based on your full entry history</small>
        </article>

        <article className="stat-card">
          <h3>30-Day Estimate</h3>
          <p className="value">
            {forecast.predicted30d === null ? '--' : `${forecast.predicted30d.toFixed(2)} kg`}
          </p>
          <small>
            {forecast.trendPerDay === null
              ? 'Need at least 4 records for forecasting'
              : `Trend: ${forecast.trendPerDay > 0 ? '+' : ''}${forecast.trendPerDay.toFixed(3)} kg/day`}
          </small>
        </article>
      </section>

      <section className="panel chart-panel">
        <h2>Trend & Forecast Chart</h2>
        <p className="chart-subtitle">
          Solid teal shows your actual logs. Dashed orange extends where your trend may go next.
        </p>
        <div className="chart-wrap">
          <Line data={chartData} options={chartOptions} />
        </div>
      </section>

      <section className="panel backup-panel">
        <h2>Backup & Restore</h2>
        <p className="backup-note">
          Export a JSON backup anytime, then import it later to restore your entries in this browser.
        </p>
        <div className="backup-actions">
          <button type="button" className="ghost-button" onClick={exportToJson}>
            Export JSON
          </button>

          <label className="ghost-button file-label">
            Import JSON
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={importFromJson}
            />
          </label>
        </div>
        {backupMessage ? <p className="backup-message">{backupMessage}</p> : null}
      </section>

      <section className="panel">
        <h2>Entry History</h2>
        {entries.length === 0 ? (
          <p className="empty">No entries yet. Add your first weight record above.</p>
        ) : (
          <ul className="entry-list">
            {entries
              .slice()
              .reverse()
              .map((entry) => (
                <li key={entry.date}>
                  <span>{formatDate(entry.date)}</span>
                  <strong>{entry.weight.toFixed(1)} kg</strong>
                  <button type="button" onClick={() => removeEntry(entry.date)}>
                    Delete
                  </button>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default App
