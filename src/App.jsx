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
import { isSupabaseConfigured, missingSupabaseEnv, supabase } from './lib/supabase'

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
const BACKTEST_HORIZON_DAYS = 7
const BACKTEST_MIN_TRAIN_DAYS = 28

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
    const steps = Number(entry?.steps)

    if (!date || !Number.isFinite(weight) || weight <= 0) {
      return
    }

    const normalizedCalories =
      Number.isFinite(calories) && calories > 0 ? Math.round(calories) : null
    const normalizedSteps =
      Number.isFinite(steps) && steps >= 0 ? Math.round(steps) : null

    normalizedMap.set(date, {
      date,
      weight: Number(weight.toFixed(2)),
      calories: normalizedCalories,
      steps: normalizedSteps,
    })
  })

  return Array.from(normalizedMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  )
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const randomNormal = () => {
  const u = 1 - Math.random()
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const getMae = (values) => {
  if (values.length === 0) {
    return null
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

const calculateOlsModel = (values) => {
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

const calculateOlsTrend = (values) => {
  const model = calculateOlsModel(values)
  return model ? model.slope : null
}

const buildWeeklySeasonality = (entries) => {
  if (entries.length < 21) {
    return Array.from({ length: 7 }, () => 0)
  }

  const model = calculateOlsModel(entries.map((item) => item.weight))
  if (!model) {
    return Array.from({ length: 7 }, () => 0)
  }

  const buckets = Array.from({ length: 7 }, () => [])
  for (let i = 0; i < entries.length; i += 1) {
    const date = new Date(entries[i].date)
    const day = date.getDay()
    const baseline = model.slope * i + model.intercept
    const residual = entries[i].weight - baseline
    buckets[day].push(residual)
  }

  const raw = buckets.map((values) => {
    if (values.length === 0) {
      return 0
    }

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    return mean
  })

  const overall = raw.reduce((sum, value) => sum + value, 0) / raw.length
  return raw.map((value) => clamp(value - overall, -0.6, 0.6))
}

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

const toOptionalNonNegativeInteger = (value) => {
  if (value === '' || value === null || value === undefined) {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }

  return Math.round(parsed)
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
    .slice(-21)
    .filter(
      (entry) =>
        Number.isFinite(entry.calories) && entry.calories >= 600 && entry.calories <= 6000,
    )

  if (recentWithCalories.length < 10) {
    return 0
  }

  const avgCalories =
    recentWithCalories.reduce((sum, entry) => sum + entry.calories, 0) /
    recentWithCalories.length
  const caloriesVariance =
    recentWithCalories.reduce((sum, entry) => {
      const delta = entry.calories - avgCalories
      return sum + delta * delta
    }, 0) / recentWithCalories.length
  const caloriesStd = Math.sqrt(caloriesVariance)

  // If calorie logs are too noisy, skip calorie effect instead of pushing an unstable slope.
  if (!Number.isFinite(caloriesStd) || caloriesStd > 450) {
    return 0
  }

  const kcalDeltaPerDay = avgCalories - maintenanceCalories
  const kgEffectPerDay = kcalDeltaPerDay / 7700

  return clamp(kgEffectPerDay, -0.08, 0.08)
}

const estimateDailyStepEffect = (entries) => {
  const recentWithSteps = entries
    .slice(-21)
    .filter(
      (entry) =>
        Number.isFinite(entry.steps) && entry.steps >= 1000 && entry.steps <= 50000,
    )

  if (recentWithSteps.length < 10) {
    return 0
  }

  const avgSteps =
    recentWithSteps.reduce((sum, entry) => sum + entry.steps, 0) /
    recentWithSteps.length
  const stepsVariance =
    recentWithSteps.reduce((sum, entry) => {
      const delta = entry.steps - avgSteps
      return sum + delta * delta
    }, 0) / recentWithSteps.length
  const stepsStd = Math.sqrt(stepsVariance)

  // Skip step effect if logs are too unstable across recent days.
  if (!Number.isFinite(stepsStd) || stepsStd > 3500) {
    return 0
  }

  // Approximation: ~0.045 kcal per step for moderate walking.
  const kcalFromStepsPerDay = (avgSteps - 7000) * 0.045
  // More steps than baseline should reduce weight trend (negative kg/day).
  const kgEffectPerDay = -kcalFromStepsPerDay / 7700

  return clamp(kgEffectPerDay, -0.03, 0.03)
}

const buildHybridForecast = (entries, profile) => {
  if (entries.length < 4) {
    return {
      next7: [],
      next90: [],
      trendPerDay: null,
      calorieEffectPerDay: null,
      stepEffectPerDay: null,
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

  const olsSlope = calculateOlsTrend(weights)
  const blendedTrend =
    olsSlope === null ? trend : 0.7 * olsSlope + 0.3 * trend
  const boundedTrend = clamp(blendedTrend, -0.12, 0.12)

  const mse =
    residuals.length > 0
      ? residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length
      : 0.06
  const sigma = Math.max(0.15, Math.sqrt(mse))
  const calorieEffectPerDay = estimateDailyCalorieEffect(entries, profile)
  const stepEffectPerDay = estimateDailyStepEffect(entries)
  const totalTrendPerDay = clamp(
    boundedTrend + calorieEffectPerDay + stepEffectPerDay,
    -0.12,
    0.12,
  )
  const weeklySeasonality = buildWeeklySeasonality(entries)
  const trendDamping = 0.985

  const next90 = []
  for (let horizon = 1; horizon <= 90; horizon += 1) {
    const sourceDate = new Date(entries[entries.length - 1].date)
    sourceDate.setDate(sourceDate.getDate() + horizon)

    const dampedTrendContribution =
      totalTrendPerDay === 0
        ? 0
        : totalTrendPerDay * ((1 - trendDamping ** horizon) / (1 - trendDamping))
    const seasonalDecay = Math.exp(-horizon / 45)
    const seasonalTerm = weeklySeasonality[sourceDate.getDay()] * seasonalDecay
    const predictedWeight = level + dampedTrendContribution + seasonalTerm
    const std = sigma * Math.sqrt(horizon)

    next90.push({
      date: toIsoDate(sourceDate),
      weight: Number(predictedWeight.toFixed(2)),
      low80: Number((predictedWeight - 1.28 * std).toFixed(2)),
      high80: Number((predictedWeight + 1.28 * std).toFixed(2)),
    })
  }

  const predicted30d = level + totalTrendPerDay * 30
  const std30 = sigma * Math.sqrt(30)

  return {
    next7: next90.slice(0, 7),
    next90,
    trendPerDay: totalTrendPerDay,
    calorieEffectPerDay,
    stepEffectPerDay,
    predicted30d: Number(predicted30d.toFixed(2)),
    predicted30dLow95: Number((predicted30d - 1.96 * std30).toFixed(2)),
    predicted30dHigh95: Number((predicted30d + 1.96 * std30).toFixed(2)),
  }
}

const buildOlsForecast = (entries) => {
  if (entries.length < 4) {
    return {
      next90: [],
      trendPerDay: null,
      calorieEffectPerDay: null,
      stepEffectPerDay: null,
      predicted30d: null,
    }
  }

  const weights = entries.map((entry) => entry.weight)
  const slope = calculateOlsTrend(weights)
  if (slope === null) {
    return {
      next90: [],
      trendPerDay: null,
      calorieEffectPerDay: null,
      stepEffectPerDay: null,
      predicted30d: null,
    }
  }

  const boundedSlope = clamp(slope, -0.15, 0.15)
  const latestWeight = entries[entries.length - 1].weight
  const next90 = []

  for (let horizon = 1; horizon <= 90; horizon += 1) {
    const sourceDate = new Date(entries[entries.length - 1].date)
    sourceDate.setDate(sourceDate.getDate() + horizon)

    next90.push({
      date: toIsoDate(sourceDate),
      weight: Number((latestWeight + boundedSlope * horizon).toFixed(2)),
    })
  }

  return {
    next90,
    trendPerDay: boundedSlope,
    calorieEffectPerDay: null,
    stepEffectPerDay: null,
    predicted30d: Number((latestWeight + boundedSlope * 30).toFixed(2)),
  }
}

const buildMechanisticForecast = (entries, profile) => {
  if (entries.length < 7) {
    return {
      next90: [],
      trendPerDay: null,
      calorieEffectPerDay: null,
      stepEffectPerDay: null,
      predicted30d: null,
    }
  }

  const latestWeight = entries[entries.length - 1].weight
  const maintenanceBase = getMaintenanceCalories(latestWeight, profile) ?? latestWeight * 31
  const recentWithCalories = entries
    .slice(-28)
    .filter(
      (entry) =>
        Number.isFinite(entry.calories) && entry.calories >= 700 && entry.calories <= 6000,
    )

  let intakeEstimate = maintenanceBase
  if (recentWithCalories.length >= 8) {
    intakeEstimate =
      recentWithCalories.reduce((sum, entry) => sum + entry.calories, 0) /
      recentWithCalories.length
  } else {
    const recentTrendModel = calculateOlsModel(entries.slice(-21).map((entry) => entry.weight))
    const inferredTrend = recentTrendModel ? recentTrendModel.slope : 0
    intakeEstimate = maintenanceBase + inferredTrend * 7700
  }

  intakeEstimate = clamp(intakeEstimate, 900, 6000)
  const calorieEffectPerDay = clamp((intakeEstimate - maintenanceBase) / 7700, -0.08, 0.08)
  const stepEffectPerDay = estimateDailyStepEffect(entries)

  const next90 = []
  let simulatedWeight = latestWeight
  const adaptationPerKg = 12

  for (let horizon = 1; horizon <= 90; horizon += 1) {
    const sourceDate = new Date(entries[entries.length - 1].date)
    sourceDate.setDate(sourceDate.getDate() + horizon)

    const adherenceDrift = 1 - Math.exp(-horizon / 55)
    const effectiveIntake = intakeEstimate + (maintenanceBase - intakeEstimate) * adherenceDrift * 0.35

    const adaptation = Math.max(0, (latestWeight - simulatedWeight) * adaptationPerKg)
    const effectiveMaintenance = maintenanceBase - adaptation
    const kcalDelta = effectiveIntake - effectiveMaintenance
    const dayDeltaKg = clamp(kcalDelta / 7700 + stepEffectPerDay, -0.16, 0.16)

    simulatedWeight += dayDeltaKg

    next90.push({
      date: toIsoDate(sourceDate),
      weight: Number(simulatedWeight.toFixed(2)),
    })
  }

  const trendPerDay =
    next90.length >= 7
      ? (next90[6].weight - latestWeight) / 7
      : null

  return {
    next90,
    trendPerDay: trendPerDay === null ? null : Number(trendPerDay.toFixed(4)),
    calorieEffectPerDay,
    stepEffectPerDay,
    predicted30d: next90[29] ? next90[29].weight : null,
  }
}

const evaluateModelBacktest = (entries, profile) => {
  if (entries.length < BACKTEST_MIN_TRAIN_DAYS + BACKTEST_HORIZON_DAYS + 2) {
    return null
  }

  const maxWindows = 80
  const lastSplitExclusive = entries.length - BACKTEST_HORIZON_DAYS + 1
  const firstSplit = Math.max(
    BACKTEST_MIN_TRAIN_DAYS,
    lastSplitExclusive - maxWindows,
  )

  const hybridAbsErrors = []
  const mechanisticAbsErrors = []
  const olsAbsErrors = []
  let hybrid80Covered = 0
  let windows = 0

  for (let split = firstSplit; split < lastSplitExclusive; split += 1) {
    const train = entries.slice(0, split)
    const actual = entries[split + BACKTEST_HORIZON_DAYS - 1]?.weight
    if (!Number.isFinite(actual)) {
      continue
    }

    const hybrid = buildHybridForecast(train, profile)
    const mechanistic = buildMechanisticForecast(train, profile)
    const ols = buildOlsForecast(train)
    const hybridPred = hybrid.next90?.[BACKTEST_HORIZON_DAYS - 1]
    const mechanisticPred = mechanistic.next90?.[BACKTEST_HORIZON_DAYS - 1]
    const olsPred = ols.next90?.[BACKTEST_HORIZON_DAYS - 1]

    if (!hybridPred || !mechanisticPred || !olsPred) {
      continue
    }

    windows += 1
    hybridAbsErrors.push(Math.abs(actual - hybridPred.weight))
    mechanisticAbsErrors.push(Math.abs(actual - mechanisticPred.weight))
    olsAbsErrors.push(Math.abs(actual - olsPred.weight))

    if (actual >= hybridPred.low80 && actual <= hybridPred.high80) {
      hybrid80Covered += 1
    }
  }

  if (windows === 0) {
    return null
  }

  const hybridMae = getMae(hybridAbsErrors)
  const mechanisticMae = getMae(mechanisticAbsErrors)
  const olsMae = getMae(olsAbsErrors)
  const hybridCoverage80 = hybrid80Covered / windows

  const ranking = [
    { key: 'hybrid', mae: hybridMae },
    { key: 'mechanistic', mae: mechanisticMae },
    { key: 'ols', mae: olsMae },
  ]
    .filter((item) => item.mae !== null)
    .sort((a, b) => a.mae - b.mae)

  const recommendedModel = ranking[0]?.key ?? 'hybrid'
  const alternateModel = ranking[1]?.key ?? (recommendedModel === 'hybrid' ? 'ols' : 'hybrid')

  return {
    windows,
    hybridMae,
    mechanisticMae,
    olsMae,
    hybridCoverage80,
    recommendedModel,
    alternateModel,
  }
}

function App() {
  const [entries, setEntries] = useState([])
  const [form, setForm] = useState({
    date: todayIso,
    weight: '',
    calories: '',
    steps: '',
  })
  const [profile, setProfile] = useState(defaultProfile)
  const [showOlsComparison, setShowOlsComparison] = useState(false)
  const [cloudEmail, setCloudEmail] = useState('')
  const [cloudSession, setCloudSession] = useState(null)
  const [cloudStatus, setCloudStatus] = useState(
    isSupabaseConfigured ? 'Cloud disconnected' : 'Cloud not configured',
  )
  const [entriesLoaded, setEntriesLoaded] = useState(false)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [cloudHydrated, setCloudHydrated] = useState(false)
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [backupMessage, setBackupMessage] = useState('')
  const [editingDate, setEditingDate] = useState(null)
  const [recentlySavedDate, setRecentlySavedDate] = useState(null)
  const [editingRow, setEditingRow] = useState({
    weight: '',
    calories: '',
    steps: '',
  })
  const fileInputRef = useRef(null)
  const syncTimerRef = useRef(null)
  const saveHighlightTimerRef = useRef(null)

  useEffect(() => {
    return () => {
      if (saveHighlightTimerRef.current) {
        clearTimeout(saveHighlightTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) {
      setEntriesLoaded(true)
      return
    }

    try {
      const parsed = JSON.parse(saved)
      setEntries(normalizeEntries(parsed))
    } catch {
      setEntries([])
    }

    setEntriesLoaded(true)
  }, [])

  useEffect(() => {
    const savedProfile = localStorage.getItem(PROFILE_STORAGE_KEY)
    if (!savedProfile) {
      setProfileLoaded(true)
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

    setProfileLoaded(true)
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      return
    }

    let isMounted = true

    const bootSession = async () => {
      const { data } = await supabase.auth.getSession()
      if (!isMounted) {
        return
      }

      const nextSession = data?.session ?? null
      setCloudSession(nextSession)
      setCloudStatus(nextSession ? 'Connected to cloud' : 'Cloud disconnected')
    }

    bootSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setCloudSession(session)
      setCloudHydrated(false)
      setCloudStatus(session ? 'Connected to cloud' : 'Cloud disconnected')
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  }, [entries])

  useEffect(() => {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile))
  }, [profile])

  const mapCloudEntries = (rows) =>
    normalizeEntries(
      (rows ?? []).map((row) => ({
        date: row.entry_date,
        weight: row.weight,
        calories: row.calories,
        steps: row.steps,
      })),
    )

  const loadCloudEntries = async (userId) => {
    if (!supabase) {
      return { data: [], error: null }
    }

    const withSteps = await supabase
      .from('entries')
      .select('entry_date, weight, calories, steps')
      .eq('user_id', userId)
      .order('entry_date', { ascending: true })

    if (!withSteps.error) {
      return withSteps
    }

    if (!String(withSteps.error.message ?? '').toLowerCase().includes('steps')) {
      return withSteps
    }

    // Backward-compatible fallback when remote schema does not have steps yet.
    return supabase
      .from('entries')
      .select('entry_date, weight, calories')
      .eq('user_id', userId)
      .order('entry_date', { ascending: true })
  }

  const hydrateFromCloud = async (userId) => {
    if (!supabase) {
      return
    }

    setCloudStatus('Syncing from cloud...')

    const [entriesRes, profileRes] = await Promise.all([
      loadCloudEntries(userId),
      supabase.from('profiles').select('age, height_cm, sex, target_weight').eq('user_id', userId).maybeSingle(),
    ])

    if (entriesRes.error) {
      throw entriesRes.error
    }

    const cloudEntries = mapCloudEntries(entriesRes.data)
    const mergedEntries = normalizeEntries([...entries, ...cloudEntries])
    setEntries(mergedEntries)

    if (profileRes.error && profileRes.error.code !== 'PGRST116') {
      throw profileRes.error
    }

    if (profileRes.data) {
      setProfile((previous) => ({
        ...previous,
        age: profileRes.data.age ?? previous.age,
        heightCm: profileRes.data.height_cm ?? previous.heightCm,
        sex: profileRes.data.sex ?? previous.sex,
        targetWeight: profileRes.data.target_weight ?? previous.targetWeight,
      }))
    }

    setCloudHydrated(true)
    setCloudStatus('Cloud sync ready')
  }

  const syncToCloud = async (userId, nextEntries, nextProfile) => {
    if (!supabase) {
      return
    }

    const timestamp = new Date().toISOString()
    const entriesPayload = nextEntries.map((entry) => ({
      user_id: userId,
      entry_date: entry.date,
      weight: entry.weight,
      calories: entry.calories,
      steps: entry.steps,
      updated_at: timestamp,
    }))

    if (entriesPayload.length > 0) {
      let { error: entriesError } = await supabase
        .from('entries')
        .upsert(entriesPayload, { onConflict: 'user_id,entry_date' })

      if (entriesError && String(entriesError.message ?? '').toLowerCase().includes('steps')) {
        const fallbackPayload = entriesPayload.map(({ steps: _ignored, ...item }) => item)
        const fallbackResult = await supabase
          .from('entries')
          .upsert(fallbackPayload, { onConflict: 'user_id,entry_date' })
        entriesError = fallbackResult.error
      }

      if (entriesError) {
        throw entriesError
      }
    }

    const profilePayload = {
      user_id: userId,
      age: toOptionalPositiveNumber(nextProfile.age),
      height_cm: toOptionalPositiveNumber(nextProfile.heightCm),
      sex: nextProfile.sex || null,
      target_weight: toOptionalPositiveNumber(nextProfile.targetWeight),
      updated_at: timestamp,
    }

    const hasProfileData =
      profilePayload.age !== null ||
      profilePayload.height_cm !== null ||
      profilePayload.sex !== null ||
      profilePayload.target_weight !== null

    if (!hasProfileData) {
      return
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert(profilePayload, { onConflict: 'user_id' })

    if (profileError) {
      throw profileError
    }
  }

  useEffect(() => {
    if (
      !isSupabaseConfigured ||
      !cloudSession?.user?.id ||
      !entriesLoaded ||
      !profileLoaded ||
      cloudHydrated
    ) {
      return
    }

    hydrateFromCloud(cloudSession.user.id).catch((cloudError) => {
      setCloudStatus(`Cloud sync error: ${cloudError.message}`)
    })
  }, [cloudSession?.user?.id, entriesLoaded, profileLoaded, cloudHydrated])

  useEffect(() => {
    if (!isSupabaseConfigured || !cloudSession?.user?.id || !cloudHydrated) {
      return
    }

    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current)
    }

    setCloudStatus('Sync pending...')
    syncTimerRef.current = setTimeout(() => {
      syncToCloud(cloudSession.user.id, entries, profile)
        .then(() => {
          setCloudStatus('Cloud synced')
        })
        .catch((cloudError) => {
          setCloudStatus(`Cloud sync error: ${cloudError.message}`)
        })
    }, 700)

    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current)
      }
    }
  }, [entries, profile, cloudSession?.user?.id, cloudHydrated])

  const stats = useMemo(() => {
    if (entries.length === 0) {
      return {
        latest: null,
        delta7d: null,
        avg: null,
        avgCalories: null,
        avgSteps: null,
      }
    }

    const latest = entries[entries.length - 1]
    const avg = entries.reduce((sum, item) => sum + item.weight, 0) / entries.length
    const withCalories = entries.filter((item) => Number.isFinite(item.calories))
    const avgCalories =
      withCalories.length > 0
        ? withCalories.reduce((sum, item) => sum + item.calories, 0) / withCalories.length
        : null
    const withSteps = entries.filter((item) => Number.isFinite(item.steps))
    const avgSteps =
      withSteps.length > 0
        ? withSteps.reduce((sum, item) => sum + item.steps, 0) / withSteps.length
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
      avgSteps,
    }
  }, [entries])

  const forecast = useMemo(() => {
    return buildHybridForecast(entries, profile)
  }, [entries, profile])

  const olsForecast = useMemo(() => {
    return buildOlsForecast(entries)
  }, [entries])

  const mechanisticForecast = useMemo(() => {
    return buildMechanisticForecast(entries, profile)
  }, [entries, profile])

  const modelBacktest = useMemo(() => {
    return evaluateModelBacktest(entries, profile)
  }, [entries, profile])

  const activeModelKey = modelBacktest?.recommendedModel ?? 'hybrid'
  const activeForecast =
    activeModelKey === 'ols'
      ? {
          next90: olsForecast.next90,
          trendPerDay: olsForecast.trendPerDay,
          predicted30d: olsForecast.predicted30d,
          predicted30dLow95: null,
          predicted30dHigh95: null,
          calorieEffectPerDay: null,
          stepEffectPerDay: null,
          label: 'OLS baseline',
        }
      : activeModelKey === 'mechanistic'
        ? {
            next90: mechanisticForecast.next90,
            trendPerDay: mechanisticForecast.trendPerDay,
            predicted30d: mechanisticForecast.predicted30d,
            predicted30dLow95: null,
            predicted30dHigh95: null,
            calorieEffectPerDay: mechanisticForecast.calorieEffectPerDay,
            stepEffectPerDay: mechanisticForecast.stepEffectPerDay,
            label: 'Dynamic energy balance',
          }
        : {
            ...forecast,
            label: 'Hybrid forecast',
          }

  const getForecastByKey = (key) => {
    if (key === 'ols') {
      return {
        label: 'OLS baseline',
        next90: olsForecast.next90,
      }
    }

    if (key === 'mechanistic') {
      return {
        label: 'Dynamic energy balance',
        next90: mechanisticForecast.next90,
      }
    }

    return {
      label: 'Hybrid forecast',
      next90: forecast.next90,
    }
  }

  const goalProjection = useMemo(() => {
    const targetWeight = toOptionalPositiveNumber(profile.targetWeight)
    const latestWeight = entries.length > 0 ? entries[entries.length - 1].weight : null
    const trendPerDay = activeForecast.trendPerDay

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
  }, [entries, activeForecast.trendPerDay, profile.targetWeight])

  const projectionWindowDays = useMemo(() => {
    if (goalProjection.status === 'projected' && goalProjection.daysToGoal !== null) {
      return clamp(goalProjection.daysToGoal + 7, 30, 90)
    }

    return 30
  }, [goalProjection.daysToGoal, goalProjection.status])

  const chartData = useMemo(() => {
    const labels = [
      ...entries.map((entry) => formatDate(entry.date)),
      ...activeForecast.next90.slice(0, projectionWindowDays).map((entry) => formatDate(entry.date)),
    ]

    const actualPoints = [
      ...entries.map((entry) => entry.weight),
      ...Array.from({ length: projectionWindowDays }, () => null),
    ]

    const activePredictionPoints = [
      ...Array.from({ length: entries.length - 1 }, () => null),
      entries.length > 0 ? entries[entries.length - 1].weight : null,
      ...activeForecast.next90.slice(0, projectionWindowDays).map((item) => item.weight),
    ]

    const alternateKey = modelBacktest?.alternateModel ?? (activeModelKey === 'hybrid' ? 'ols' : 'hybrid')
    const alternateForecast = getForecastByKey(alternateKey)
    const alternatePredictionPoints = [
      ...Array.from({ length: entries.length - 1 }, () => null),
      entries.length > 0 ? entries[entries.length - 1].weight : null,
      ...alternateForecast.next90.slice(0, projectionWindowDays).map((item) => item.weight),
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
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.16)',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: '#2563eb',
        },
        {
          label: `${activeForecast.label} (active)`,
          data: activePredictionPoints,
          borderColor: 'rgba(37, 99, 235, 0.58)',
          backgroundColor: 'rgba(37, 99, 235, 0.58)',
          borderDash: [8, 6],
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: '#2563eb',
          pointBorderColor: '#2563eb',
        },
        ...(showOlsComparison
          ? [
              {
                label: `${alternateForecast.label} (alternate)`,
                data: alternatePredictionPoints,
                borderColor: 'rgba(37, 99, 235, 0.34)',
                backgroundColor: 'rgba(37, 99, 235, 0.34)',
                borderDash: [3, 4],
                tension: 0,
                pointRadius: 2,
                pointHoverRadius: 4,
                pointBackgroundColor: '#2563eb',
                pointBorderColor: '#2563eb',
              },
            ]
          : []),
        ...(goalProjection.targetWeight !== null
          ? [
              {
                label: 'Target weight',
                data: targetWeightLine,
                borderColor: '#e11d48',
                backgroundColor: '#e11d48',
                borderDash: [4, 5],
                borderWidth: 2.4,
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
                borderColor: '#be123c',
                backgroundColor: '#be123c',
                showLine: false,
                pointRadius: 5,
                pointHoverRadius: 7,
              },
            ]
          : []),
      ],
    }
  }, [entries, forecast, goalProjection, projectionWindowDays, olsForecast, showOlsComparison, activeForecast, activeModelKey, modelBacktest, mechanisticForecast])

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
          color: '#3f3a32',
          font: {
            family: 'IBM Plex Sans, Segoe UI, sans-serif',
            size: 12,
            weight: '500',
          },
        },
      },
      title: {
        display: true,
        text: 'Weight Trend and Forecast',
        color: '#28231d',
        font: {
          family: 'IBM Plex Sans, Segoe UI, sans-serif',
          size: 17,
          weight: '600',
        },
        padding: {
          top: 4,
          bottom: 14,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(28, 27, 25, 0.94)',
        padding: 12,
        cornerRadius: 10,
        titleFont: {
          family: 'IBM Plex Sans, Segoe UI, sans-serif',
          weight: '600',
        },
        bodyFont: {
          family: 'IBM Plex Sans, Segoe UI, sans-serif',
          weight: '500',
        },
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
          color: '#6b665e',
          font: {
            family: 'IBM Plex Sans, Segoe UI, sans-serif',
            size: 11,
            weight: '500',
          },
        },
      },
      y: {
        border: {
          display: false,
        },
        grid: {
          color: 'rgba(116, 107, 94, 0.18)',
          drawTicks: false,
        },
        ticks: {
          color: '#6b665e',
          font: {
            family: 'IBM Plex Sans, Segoe UI, sans-serif',
            size: 11,
            weight: '500',
          },
          callback: (value) => `${value} kg`,
        },
        title: {
          display: true,
          text: 'Weight (kg)',
          color: '#5e584f',
          font: {
            family: 'IBM Plex Sans, Segoe UI, sans-serif',
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
    const existingEntry = entries.find((item) => item.date === date)
    const hasWeightInput = form.weight !== ''
    const parsedWeight = Number(form.weight)
    const calories =
      form.calories === ''
        ? existingEntry?.calories ?? null
        : toOptionalPositiveNumber(form.calories)
    const steps =
      form.steps === ''
        ? existingEntry?.steps ?? null
        : toOptionalNonNegativeInteger(form.steps)

    if (!date) {
      setError('Invalid date. Please choose a valid day.')
      return
    }

    if (hasWeightInput && (!Number.isFinite(parsedWeight) || parsedWeight <= 0)) {
      setError('If entered, weight must be greater than 0.')
      return
    }

    const weight = hasWeightInput ? parsedWeight : existingEntry?.weight

    if (!Number.isFinite(weight) || weight <= 0) {
      setError('Weight is required for a new date. For existing dates, leave weight empty to keep it unchanged.')
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
          steps,
        },
      ])
    })

    setForm((previous) => ({
      ...previous,
      weight: '',
      calories: '',
      steps: '',
    }))
  }

  const removeEntry = (date) => {
    setEntries((previous) => previous.filter((entry) => entry.date !== date))
  }

  const startInlineEdit = (entry) => {
    setHistoryError('')
    setEditingDate(entry.date)
    setEditingRow({
      weight: String(entry.weight ?? ''),
      calories:
        Number.isFinite(entry.calories) && entry.calories !== null
          ? String(entry.calories)
          : '',
      steps:
        Number.isFinite(entry.steps) && entry.steps !== null
          ? String(entry.steps)
          : '',
    })
  }

  const cancelInlineEdit = () => {
    setEditingDate(null)
    setEditingRow({ weight: '', calories: '', steps: '' })
    setHistoryError('')
  }

  const saveInlineEdit = (date) => {
    const parsedWeight = Number(editingRow.weight)
    if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
      setHistoryError('Weight must be greater than 0.')
      return
    }

    const calories = toOptionalPositiveNumber(editingRow.calories)
    const steps = toOptionalNonNegativeInteger(editingRow.steps)

    setEntries((previous) =>
      normalizeEntries(
        previous.map((entry) =>
          entry.date === date
            ? {
                ...entry,
                weight: parsedWeight,
                calories,
                steps,
              }
            : entry,
        ),
      ),
    )

    setEditingDate(null)
    setEditingRow({ weight: '', calories: '', steps: '' })
    setHistoryError('')
    setRecentlySavedDate(date)

    if (saveHighlightTimerRef.current) {
      clearTimeout(saveHighlightTimerRef.current)
    }

    saveHighlightTimerRef.current = setTimeout(() => {
      setRecentlySavedDate((previous) => (previous === date ? null : previous))
    }, 1800)
  }

  const handleInlineKeyDown = (event, date) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      saveInlineEdit(date)
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      cancelInlineEdit()
    }
  }

  const sendMagicLink = async () => {
    if (!supabase || !cloudEmail.trim()) {
      return
    }

    setCloudStatus('Sending magic link...')
    const redirectTo = `${window.location.origin}${window.location.pathname}`

    const { error: authError } = await supabase.auth.signInWithOtp({
      email: cloudEmail.trim(),
      options: {
        emailRedirectTo: redirectTo,
      },
    })

    if (authError) {
      setCloudStatus(`Auth error: ${authError.message}`)
      return
    }

    setCloudStatus('Magic link sent. Check your email.')
  }

  const signOutCloud = async () => {
    if (!supabase) {
      return
    }

    await supabase.auth.signOut()
    setCloudStatus('Cloud disconnected')
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

  const resetLocalData = () => {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(PROFILE_STORAGE_KEY)
    setEntries([])
    setProfile(defaultProfile)
  }

  const clearLocalData = () => {
    const confirmed = window.confirm(
      'This will delete all locally stored entries and profile data in this browser. Continue?',
    )

    if (!confirmed) {
      return
    }

    resetLocalData()
    setBackupMessage('All local data has been cleared from this browser.')
  }

  const clearCloudData = async () => {
    if (!supabase || !cloudSession?.user?.id) {
      return
    }

    const confirmed = window.confirm(
      'This will permanently delete your cloud entries and profile, then clear local data on this browser. Continue?',
    )

    if (!confirmed) {
      return
    }

    setCloudStatus('Deleting cloud data...')
    const userId = cloudSession.user.id

    const [{ error: entriesError }, { error: profileError }] = await Promise.all([
      supabase.from('entries').delete().eq('user_id', userId),
      supabase.from('profiles').delete().eq('user_id', userId),
    ])

    if (entriesError || profileError) {
      setCloudStatus(`Cloud delete error: ${(entriesError ?? profileError)?.message}`)
      return
    }

    setCloudHydrated(false)
    resetLocalData()
    setCloudStatus('Cloud data deleted')
    setBackupMessage('Cloud data and local browser data were cleared.')
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
        <h2>Cloud Sync (Free)</h2>
        {!isSupabaseConfigured ? (
          <p className="backup-note">
            Cloud is not configured. Missing: {missingSupabaseEnv.join(', ')}. Add these variables to your env file (or GitHub Actions secrets) to enable free sync.
          </p>
        ) : (
          <>
            <p className="backup-note">{cloudStatus}</p>
            {cloudSession?.user ? (
              <div className="backup-actions">
                <span className="cloud-user">Signed in as {cloudSession.user.email}</span>
                <button type="button" className="ghost-button" onClick={clearCloudData}>
                  Delete Cloud Data
                </button>
                <button type="button" className="ghost-button" onClick={signOutCloud}>
                  Sign out
                </button>
              </div>
            ) : (
              <div className="cloud-auth-grid">
                <label>
                  Email for magic link
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={cloudEmail}
                    onChange={(event) => setCloudEmail(event.target.value)}
                  />
                </label>
                <button type="button" className="ghost-button" onClick={sendMagicLink}>
                  Send login link
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Add New Entry</h2>
        <p className="backup-note">
          Tip: if this date already exists, you can leave weight empty and update only calories or steps.
        </p>
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

          <label>
            Steps (optional)
            <input
              type="number"
              step="1"
              min="0"
              placeholder="e.g. 8200"
              value={form.steps}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, steps: event.target.value }))
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

      <section className="stats-section">
        <div className="stats-group">
          <header className="stats-group-header">
            <h2>Tracking Stats</h2>
            <p>Current and historical metrics from your logged data.</p>
          </header>
          <div className="stats-grid">
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
              <h3>Avg Logged Calories</h3>
              <p className="value">
                {stats.avgCalories === null ? '--' : `${Math.round(stats.avgCalories)} kcal`}
              </p>
              <small>
                {forecast.calorieEffectPerDay === null
                  ? 'Add profile + calories to enable calorie effect'
                  : `Calorie effect: ${forecast.calorieEffectPerDay > 0 ? '+' : ''}${forecast.calorieEffectPerDay.toFixed(3)} kg/day`}
              </small>
              <small>
                {forecast.stepEffectPerDay === null
                  ? 'Add steps for activity effect'
                  : `Step effect: ${forecast.stepEffectPerDay > 0 ? '+' : ''}${forecast.stepEffectPerDay.toFixed(3)} kg/day`}
              </small>
            </article>

            <article className="stat-card">
              <h3>Avg Daily Steps</h3>
              <p className="value">
                {stats.avgSteps === null ? '--' : `${Math.round(stats.avgSteps).toLocaleString()} steps`}
              </p>
              <small>
                {stats.avgSteps === null
                  ? 'Log steps to track activity alongside weight changes'
                  : 'Based on entries that include step count'}
              </small>
            </article>
          </div>
        </div>

        <div className="stats-group stats-group-forecast">
          <header className="stats-group-header">
            <h2>Forecast Stats</h2>
            <p>Projection, model confidence, and target trajectory.</p>
          </header>
          <div className="stats-grid">
            <article className="stat-card">
              <h3>30-Day Estimate</h3>
              <p className="value">
                {activeForecast.predicted30d === null ? '--' : `${activeForecast.predicted30d.toFixed(2)} kg`}
              </p>
              <small>
                {activeForecast.trendPerDay === null
                  ? 'Need at least 4 records for forecasting'
                  : `${activeForecast.label}: ${activeForecast.trendPerDay > 0 ? '+' : ''}${activeForecast.trendPerDay.toFixed(3)} kg/day`}
              </small>
              {activeForecast.predicted30dLow95 !== null && activeForecast.predicted30dHigh95 !== null ? (
                <small>
                  95% range: {activeForecast.predicted30dLow95.toFixed(2)} to {activeForecast.predicted30dHigh95.toFixed(2)} kg
                </small>
              ) : null}
            </article>

            <article className="stat-card">
              <h3>Model Quality (7-day Backtest)</h3>
              <p className="value">
                {modelBacktest ? `${modelBacktest.windows} windows` : '--'}
              </p>
              <small>
                {modelBacktest
                  ? `Hybrid MAE: ${modelBacktest.hybridMae.toFixed(2)} kg | Dynamic MAE: ${modelBacktest.mechanisticMae.toFixed(2)} kg | OLS MAE: ${modelBacktest.olsMae.toFixed(2)} kg`
                  : 'Need more history for rolling backtest'}
              </small>
              <small>
                {modelBacktest
                  ? `Hybrid 80% coverage: ${(modelBacktest.hybridCoverage80 * 100).toFixed(1)}% | Active model: ${activeForecast.label}`
                  : 'Backtest starts after enough historical entries are available'}
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
          </div>
        </div>
      </section>

      <section className="panel chart-panel">
        <h2>Trend & Forecast Chart</h2>
        <p className="chart-subtitle">
          Forecast is auto-selected from rolling backtest performance. Comparison mode shows the strongest alternate model.
        </p>
        <div className="chart-controls">
          <button
            type="button"
            className={`ghost-button ${showOlsComparison ? 'is-active' : ''}`}
            onClick={() => setShowOlsComparison((previous) => !previous)}
          >
            {showOlsComparison ? 'Hide OLS comparison' : 'Compare OLS vs Hybrid'}
          </button>
          {showOlsComparison ? (
            <p className="chart-hint">
              Active: {activeForecast.label}. Blue overlay shows the alternate challenger from backtest ranking.
            </p>
          ) : null}
        </div>
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

          <button type="button" className="ghost-button" onClick={clearLocalData}>
            Clear Local Data
          </button>
        </div>
        {backupMessage ? <p className="backup-message">{backupMessage}</p> : null}
      </section>

      <section className="panel">
        <h2>Entry History</h2>
        {entries.length === 0 ? (
          <p className="empty">No entries yet. Add your first weight record above.</p>
        ) : (
          <div className="history-table-wrap">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Weight (kg)</th>
                  <th>Calories (kcal)</th>
                  <th>Steps</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {entries
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <tr
                      key={entry.date}
                      className={recentlySavedDate === entry.date ? 'history-row-saved' : ''}
                    >
                      <td>{formatDate(entry.date)}</td>
                      {editingDate === entry.date ? (
                        <>
                          <td>
                            <input
                              className="history-input"
                              type="number"
                              step="0.1"
                              min="1"
                              value={editingRow.weight}
                              onChange={(event) =>
                                setEditingRow((previous) => ({
                                  ...previous,
                                  weight: event.target.value,
                                }))
                              }
                              onKeyDown={(event) => handleInlineKeyDown(event, entry.date)}
                            />
                          </td>
                          <td>
                            <input
                              className="history-input"
                              type="number"
                              step="1"
                              min="0"
                              value={editingRow.calories}
                              onChange={(event) =>
                                setEditingRow((previous) => ({
                                  ...previous,
                                  calories: event.target.value,
                                }))
                              }
                              onKeyDown={(event) => handleInlineKeyDown(event, entry.date)}
                            />
                          </td>
                          <td>
                            <input
                              className="history-input"
                              type="number"
                              step="1"
                              min="0"
                              value={editingRow.steps}
                              onChange={(event) =>
                                setEditingRow((previous) => ({
                                  ...previous,
                                  steps: event.target.value,
                                }))
                              }
                              onKeyDown={(event) => handleInlineKeyDown(event, entry.date)}
                            />
                          </td>
                          <td className="history-actions">
                            <button type="button" onClick={() => saveInlineEdit(entry.date)}>
                              Save
                            </button>
                            <button type="button" onClick={cancelInlineEdit}>
                              Cancel
                            </button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{entry.weight.toFixed(1)}</td>
                          <td>
                            {Number.isFinite(entry.calories)
                              ? Math.round(entry.calories)
                              : '--'}
                          </td>
                          <td>
                            {Number.isFinite(entry.steps)
                              ? Math.round(entry.steps).toLocaleString()
                              : '--'}
                          </td>
                          <td className="history-actions">
                            <button type="button" onClick={() => startInlineEdit(entry)}>
                              Edit
                            </button>
                            <button type="button" onClick={() => removeEntry(entry.date)}>
                              Delete
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        {historyError ? <p className="error">{historyError}</p> : null}
      </section>
    </div>
  )
}

export default App
