import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

type RequestPayload = {
  date?: string
  steps?: number
}

const normalizeInputDate = (value?: string): string | null => {
  if (!value) {
    return new Date().toISOString().slice(0, 10)
  }

  const raw = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!slashMatch) {
    return null
  }

  const day = Number(slashMatch[1])
  const month = Number(slashMatch[2])
  const year = Number(slashMatch[3])
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
    return null
  }

  const candidate = new Date(Date.UTC(year, month - 1, day))
  const isValidDate =
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day

  if (!isValidDate) {
    return null
  }

  const dd = String(day).padStart(2, "0")
  const mm = String(month).padStart(2, "0")
  return `${year}-${mm}-${dd}`
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  })

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" })
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, { error: "Server configuration missing" })
  }

  const ingestToken = req.headers.get("x-ingest-token")?.trim()
  if (!ingestToken) {
    return json(401, { error: "Missing x-ingest-token header" })
  }

  let payload: RequestPayload
  try {
    payload = await req.json()
  } catch {
    return json(400, { error: "Invalid JSON body" })
  }

  const stepsRaw = Number(payload.steps)
  if (!Number.isFinite(stepsRaw) || stepsRaw < 0) {
    return json(400, { error: "steps must be a non-negative number" })
  }
  const steps = Math.round(stepsRaw)

  const entryDate = normalizeInputDate(payload.date)
  if (!entryDate) {
    return json(400, { error: "date must be YYYY-MM-DD or DD/MM/YYYY" })
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: tokenRow, error: tokenError } = await admin
    .from("step_ingest_tokens")
    .select("user_id, is_active")
    .eq("token", ingestToken)
    .maybeSingle()

  if (tokenError) {
    return json(500, { error: tokenError.message })
  }

  if (!tokenRow || !tokenRow.is_active) {
    return json(401, { error: "Invalid or inactive ingest token" })
  }

  const { data: updatedRows, error: updateError } = await admin
    .from("entries")
    .update({
      steps,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", tokenRow.user_id)
    .eq("entry_date", entryDate)
    .select("entry_date, weight, calories, steps")

  if (updateError) {
    return json(500, { error: updateError.message })
  }

  if (!updatedRows || updatedRows.length === 0) {
    return json(409, {
      error: "No weight entry for that date yet. Add weight first, then send steps.",
      date: entryDate,
    })
  }

  return json(200, {
    ok: true,
    date: entryDate,
    steps,
    entry: updatedRows[0],
  })
})
