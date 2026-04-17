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
const PROFILE_STORAGE_KEY = 'weight-loss-user-profile-v1'

const defaultProfile = {
  age: '',
  heightCm: '',
  sex: '',
  targetWeight: '',
}

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
    const calories = Number(entry?.calories)

    if (!date || !Number.isFinite(weight) || weight <= 0) {
      return
    }

    const normalizedCalories =
      Number.isFinite(calories) && calories > 0 ? Math.round(calories) : null

    normalizedMap.set(date, {
      date,
      weight: Number(weight.toFixed(2)),
      calories: normalizedCalories,
    })
  })

  return Array.from(normalizedMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  )
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const toOptionalPositiveNumber = (value) => {
  if (value === '' || value === null || value === undefined) {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

const getMaintenanceCalories = (weightKg, profile) => {
  const age = toOptionalPositiveNumber(profile.age)
  const heightCm = toOptionalPositiveNumber(profile.heightCm)
  const sex = profile.sex

  if (!age || !heightCm || !sex) {
    return null
  }

  const sexAdjustment = sex === 'male' ? 5 : sex === 'female' ? -161 : 0
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + sexAdjustment
  const maintenance = bmr * 1.4

  return Number.isFinite(maintenance) && maintenance > 0 ? maintenance : null
}

const estimateDailyCalorieEffect = (entries, profile) => {
  if (entries.length === 0) {
    return 0
  }

  const latestWeight = entries[entries.length - 1].weight
  const maintenanceCalories = getMaintenanceCalories(latestWeight, profile)
  if (!maintenanceCalories) {
    return 0
  }

  const recentWithCalories = entries
    .slice(-14)
    .filter(
      (entry) =>
        Number.isFinite(entry.calories) && entry.calories >= 600 && entry.calories <= 6000,
    )

  if (recentWithCalories.length < 5) {
    return 0
  }

  const avgCalories =
    recentWithCalories.reduce((sum, entry) => sum + entry.calories, 0) /
    recentWithCalories.length
  const kcalDeltaPerDay = avgCalories - maintenanceCalories
  const kgEffectPerDay = kcalDeltaPerDay / 7700

  return clamp(kgEffectPerDay, -0.25, 0.25)
}

const buildHybridForecast = (entries, profile) => {
  if (entries.length < 4) {
    return {
      next7: [],
      next90: [],
      trendPerDay: null,
      calorieEffectPerDay: null,
      predicted30d: null,
      predicted30dLow95: null,
      predicted30dHigh95: null,
    }
  }

  const weights = entries.map((entry) => entry.weight)
  let level = weights[0]
  let trend = weights[1] - weights[0]

  const alpha = 0.35
  const beta = 0.12
  const residuals = []

  for (let i = 1; i < weights.length; i += 1) {
    const predicted = level + trend
    residuals.push(weights[i] - predicted)

    const prevLevel = level
    level = alpha * weights[i] + (1 - alpha) * (level + trend)
    trend = beta * (level - prevLevel) + (1 - beta) * trend
  }

  const mse =
    residuals.length > 0
      ? residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length
      : 0.06
  const sigma = Math.max(0.15, Math.sqrt(mse))
  const calorieEffectPerDay = estimateDailyCalorieEffect(entries, profile)
  const totalTrendPerDay = trend + calorieEffectPerDay

  const next90 = []
  for (let horizon = 1; horizon <= 90; horizon += 1) {
    const sourceDate = new Date(entries[entries.length - 1].date)
    sourceDate.setDate(sourceDate.getDate() + horizon)

    const predictedWeight = level + trend * horizon + calorieEffectPerDay * horizon
    const std = sigma * Math.sqrt(horizon)

    next90.push({
      date: toIsoDate(sourceDate),
      weight: Number(predictedWeight.toFixed(2)),
      low80: Number((predictedWeight - 1.28 * std).toFixed(2)),
      high80: Number((predictedWeight + 1.28 * std).toFixed(2)),
    })
  }

  const predicted30d = level + trend * 30 + calorieEffectPerDay * 30
  const std30 = sigma * Math.sqrt(30)

  return {
    next7: next90.slice(0, 7),
    next90,
    trendPerDay: totalTrendPerDay,
    calorieEffectPerDay,
    predicted30d: Number(predicted30d.toFixed(2)),
    predicted30dLow95: Number((predicted30d - 1.96 * std30).toFixed(2)),
    predicted30dHigh95: Number((predicted30d + 1.96 * std30).toFixed(2)),
  }
}

function App() {
  const [entries, setEntries] = useState([])
  const [form, setForm] = useState({
    date: todayIso,
    weight: '',
    calories: '',
  })
  const [profile, setProfile] = useState(defaultProfile)
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
    const savedProfile = localStorage.getItem(PROFILE_STORAGE_KEY)
    if (!savedProfile) {
      return
    }

    try {
      const parsed = JSON.parse(savedProfile)
      setProfile({
        age: parsed?.age ?? '',
        heightCm: parsed?.heightCm ?? '',
        sex: parsed?.sex ?? '',
        targetWeight: parsed?.targetWeight ?? '',
      })
    } catch {
      setProfile(defaultProfile)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  }, [entries])

  useEffect(() => {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile))
  }, [profile])

  const stats = useMemo(() => {
    if (entries.length === 0) {
      return {
        latest: null,
        delta7d: null,
        avg: null,
        avgCalories: null,
      }
    }

    const latest = entries[entries.length - 1]
    const avg = entries.reduce((sum, item) => sum + item.weight, 0) / entries.length
    const withCalories = entries.filter((item) => Number.isFinite(item.calories))
    const avgCalories =
      withCalories.length > 0
        ? withCalories.reduce((sum, item) => sum + item.calories, 0) / withCalories.length
        : null

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
      avgCalories,
    }
  }, [entries])

  const forecast = useMemo(() => {
    return buildHybridForecast(entries, profile)
  }, [entries, profile])

  const goalProjection = useMemo(() => {
    const targetWeight = toOptionalPositiveNumber(profile.targetWeight)
    const latestWeight = entries.length > 0 ? entries[entries.length - 1].weight : null
    const trendPerDay = forecast.trendPerDay

    if (!targetWeight || !latestWeight || trendPerDay === null) {
      return {
        targetWeight,
        status: 'missing',
        daysToGoal: null,
        etaDate: null,
      }
    }

    const delta = targetWeight - latestWeight
    if (Math.abs(delta) <= 0.05) {
      return {
        targetWeight,
        status: 'reached',
        daysToGoal: 0,
        etaDate: entries[entries.length - 1].date,
      }
    }

    if (Math.abs(trendPerDay) < 0.005) {
      return {
        targetWeight,
        status: 'flat',
        daysToGoal: null,
        etaDate: null,
      }
    }

    const rawDays = delta / trendPerDay
    if (rawDays <= 0) {
      return {
        targetWeight,
        status: 'opposite',
        daysToGoal: null,
        etaDate: null,
      }
    }

    const daysToGoal = Math.ceil(rawDays)
    const etaDate = new Date(entries[entries.length - 1].date)
    etaDate.setDate(etaDate.getDate() + daysToGoal)

    return {
      targetWeight,
      status: 'projected',
      daysToGoal,
      etaDate: toIsoDate(etaDate),
    }
  }, [entries, forecast.trendPerDay, profile.targetWeight])

  const projectionWindowDays = useMemo(() => {
    if (goalProjection.status === 'projected' && goalProjection.daysToGoal !== null) {
      return clamp(goalProjection.daysToGoal + 7, 30, 90)
    }

    return 30
  }, [goalProjection.daysToGoal, goalProjection.status])

  const chartData = useMemo(() => {
    const labels = [
      ...entries.map((entry) => formatDate(entry.date)),
      ...forecast.next90.slice(0, projectionWindowDays).map((entry) => formatDate(entry.date)),
    ]

    const actualPoints = [
      ...entries.map((entry) => entry.weight),
      ...Array.from({ length: projectionWindowDays }, () => null),
    ]

    const predictionPoints = [
      ...Array.from({ length: entries.length - 1 }, () => null),
      entries.length > 0 ? entries[entries.length - 1].weight : null,
      ...forecast.next90.slice(0, projectionWindowDays).map((item) => item.weight),
    ]

    const targetWeightLine =
      goalProjection.targetWeight !== null
        ? Array.from({ length: labels.length }, () => goalProjection.targetWeight)
        : []

    const etaPointSeries = Array.from({ length: labels.length }, () => null)
    if (
      goalProjection.status === 'projected' &&
      goalProjection.daysToGoal !== null &&
      goalProjection.daysToGoal <= projectionWindowDays
    ) {
      const etaIndex = entries.length - 1 + goalProjection.daysToGoal
      if (etaIndex >= 0 && etaIndex < etaPointSeries.length) {
        etaPointSeries[etaIndex] = goalProjection.targetWeight
      }
    }

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
          label: 'Forecast',
          data: predictionPoints,
          borderColor: '#f97316',
          backgroundColor: '#f97316',
          borderDash: [8, 6],
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
        ...(goalProjection.targetWeight !== null
          ? [
              {
                label: 'Target weight',
                data: targetWeightLine,
                borderColor: '#7c3aed',
                backgroundColor: '#7c3aed',
                borderDash: [4, 5],
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 0,
              },
            ]
          : []),
        ...(goalProjection.status === 'projected'
          ? [
              {
                label: 'Estimated target date',
                data: etaPointSeries,
                borderColor: '#7c3aed',
                backgroundColor: '#7c3aed',
                showLine: false,
                pointRadius: 5,
                pointHoverRadius: 7,
              },
            ]
          : []),
      ],
    }
  }, [entries, forecast, goalProjection, projectionWindowDays])

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
          label: (context) => {
            const value = context.parsed.y
            if (!Number.isFinite(value)) {
              return null
            }

            return `${context.dataset.label}: ${value.toFixed(1)} kg`
          },
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
    const calories = toOptionalPositiveNumber(form.calories)

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
          calories,
        },
      ])
    })

    setForm((previous) => ({
      ...previous,
      weight: '',
      calories: '',
    }))
  }

  const removeEntry = (date) => {
    setEntries((previous) => previous.filter((entry) => entry.date !== date))
  }

  const exportToJson = () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      profile,
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
    setBackupMessage('JSON backup exported successfully.')
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
      const importedProfile = parsed?.profile

      if (normalized.length === 0) {
        setBackupMessage('No valid entries found in this file.')
        return
      }

      setEntries(normalized)
      if (importedProfile && typeof importedProfile === 'object') {
        setProfile({
          age: importedProfile.age ?? '',
          heightCm: importedProfile.heightCm ?? '',
          sex: importedProfile.sex ?? '',
          targetWeight: importedProfile.targetWeight ?? '',
        })
      }
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

          <label>
            Calories (optional)
            <input
              type="number"
              step="1"
              min="0"
              placeholder="e.g. 1950"
              value={form.calories}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, calories: event.target.value }))
              }
            />
          </label>

          <button type="submit">Save Entry</button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="panel">
        <h2>Profile (Optional but Helpful)</h2>
        <div className="profile-grid">
          <label>
            Age
            <input
              type="number"
              min="1"
              max="120"
              placeholder="e.g. 30"
              value={profile.age}
              onChange={(event) =>
                setProfile((previous) => ({ ...previous, age: event.target.value }))
              }
            />
          </label>

          <label>
            Height (cm)
            <input
              type="number"
              min="50"
              max="250"
              placeholder="e.g. 170"
              value={profile.heightCm}
              onChange={(event) =>
                setProfile((previous) => ({ ...previous, heightCm: event.target.value }))
              }
            />
          </label>

          <label>
            Sex
            <select
              value={profile.sex}
              onChange={(event) =>
                setProfile((previous) => ({ ...previous, sex: event.target.value }))
              }
            >
              <option value="">Prefer not to say</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>

          <label>
            Target weight (kg)
            <input
              type="number"
              min="1"
              step="0.1"
              placeholder="e.g. 65"
              value={profile.targetWeight}
              onChange={(event) =>
                setProfile((previous) => ({ ...previous, targetWeight: event.target.value }))
              }
            />
          </label>
        </div>
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
          {forecast.predicted30dLow95 !== null && forecast.predicted30dHigh95 !== null ? (
            <small>
              95% range: {forecast.predicted30dLow95.toFixed(2)} to {forecast.predicted30dHigh95.toFixed(2)} kg
            </small>
          ) : null}
        </article>

        <article className="stat-card">
          <h3>Avg Logged Calories</h3>
          <p className="value">
            {stats.avgCalories === null ? '--' : `${Math.round(stats.avgCalories)} kcal`}
          </p>
          <small>
            {forecast.calorieEffectPerDay === null
              ? 'Add profile + calories to enable calorie effect'
              : `Calorie effect: ${forecast.calorieEffectPerDay > 0 ? '+' : ''}${forecast.calorieEffectPerDay.toFixed(3)} kg/day`}
          </small>
        </article>

        <article className="stat-card">
          <h3>Target ETA</h3>
          <p className="value">
            {goalProjection.targetWeight === null
              ? '--'
              : `${goalProjection.targetWeight.toFixed(1)} kg`}
          </p>
          <small>
            {goalProjection.status === 'missing' && 'Set target weight + enough entries to estimate ETA'}
            {goalProjection.status === 'reached' && 'You are already at your target'}
            {goalProjection.status === 'flat' && 'Trend is too flat now to estimate ETA'}
            {goalProjection.status === 'opposite' && 'Current trend is moving away from this target'}
            {goalProjection.status === 'projected' &&
              `Estimated in ${goalProjection.daysToGoal} days (${formatDate(goalProjection.etaDate)})`}
          </small>
        </article>
      </section>

      <section className="panel chart-panel">
        <h2>Trend & Forecast Chart</h2>
        <p className="chart-subtitle">
          Solid teal shows your actual logs. Dashed orange combines trend and optional calorie-based adjustment.
        </p>
        <div className="chart-wrap">
          <Line data={chartData} options={chartOptions} />
        </div>
      </section>

      <section className="panel backup-panel">
        <h2>Backup and Restore</h2>
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
                  <div className="entry-meta">
                    <span>{formatDate(entry.date)}</span>
                    <small>
                      {Number.isFinite(entry.calories)
                        ? `${Math.round(entry.calories)} kcal`
                        : 'Calories not logged'}
                    </small>
                  </div>
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
