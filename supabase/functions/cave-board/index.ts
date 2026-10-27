import { createClient } from "jsr:@supabase/supabase-js@2";

// Only the GitHub Pages site may call this function; requests without an allowed Origin
// are rejected. The old kratos561 address is no longer trusted: that username is free and
// anyone could claim it. CAVE_ALLOWED_ORIGIN can add origins as a comma-separated list.
const allowedOrigins = new Set([
  "https://isaaclorenzo.github.io",
  ...(Deno.env.get("CAVE_ALLOWED_ORIGIN") ?? "").split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean),
]);

function corsFor(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://isaaclorenzo.github.io",
    "Access-Control-Allow-Headers": "content-type, x-cave-access",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "7200",
    "Vary": "Origin",
  };
}

const statuses = new Set(["pendiente", "proceso", "listo"]);
const priorities = new Set(["normal", "alta", "urgente"]);
const MAX_BODY = 64 * 1024;
const TRASH_TTL = 48 * 60 * 60 * 1000;
const ACTIVITY_TTL = 180 * 24 * 60 * 60 * 1000;

// Errors the caller may see. Anything else is logged and answered with a generic message.
class Invalid extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// Best-effort limits per client IP and isolate: they stop scripts that flood or wipe the board.
const limits = { request: [240, 60_000], write: [120, 60_000], erase: [40, 3_600_000] } as const;
const hits = new Map<string, number[]>();

function allow(ip: string, kind: keyof typeof limits) {
  const [max, windowMs] = limits[kind];
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return true;
}

function response(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function string(value: unknown, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function identifier(value: unknown) {
  const id = string(value, 100);
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) throw new Invalid("Identificador inválido.");
  return id;
}

function amount(value: unknown, label: string) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000000) throw new Invalid(`${label} inválido.`);
  return Math.round(parsed * 100) / 100;
}

function timestamp(value: unknown, label: string) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > Date.now() + 86_400_000) throw new Invalid(`${label} inválida.`);
  return Number(value);
}

function checklist(value: unknown) {
  if (!Array.isArray(value) || value.length > 40) throw new Invalid("Checklist inválida.");
  return value.map((item) => {
    const text = string(item?.text, 200);
    if (!text || typeof item?.done !== "boolean") throw new Invalid("Checklist inválida.");
    return { id: string(item.id, 40) || crypto.randomUUID(), text, done: item.done };
  });
}

function taskPayload(value: Record<string, unknown>, partial = false) {
  const next: Record<string, unknown> = {};
  const has = (key: string) => !partial || key in value;
  if (has("text")) {
    const text = string(value.text, 220);
    if (!text) throw new Invalid("El nombre del proyecto es obligatorio.");
    next.text = text;
  }
  for (const [key, max] of [["client", 220], ["description", 5000], ["phone", 80]] as const) {
    if (has(key)) next[key] = string(value[key], max) || null;
  }
  if (has("date")) {
    const date = string(value.date, 10);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Invalid("Fecha inválida.");
    next.date = date || null;
  }
  if (has("payment_amount")) next.payment_amount = amount(value.payment_amount, "Abono");
  if (has("amount_due")) next.amount_due = amount(value.amount_due, "Saldo pendiente");
  for (const [key, label] of [["paid_in_full", "Estado de pago"], ["awaiting_pickup", "Estado de retiro"]] as const) {
    if (!has(key)) continue;
    if (typeof value[key] !== "boolean") throw new Invalid(`${label} inválido.`);
    next[key] = value[key];
  }
  if (has("status")) {
    const status = string(value.status, 24) || "pendiente";
    if (!statuses.has(status)) throw new Invalid("Estado inválido.");
    next.status = status;
  }
  if (has("priority")) {
    const priority = string(value.priority, 24) || "normal";
    if (!priorities.has(priority)) throw new Invalid("Prioridad inválida.");
    next.priority = priority;
  }
  if (has("checklist")) next.checklist = checklist(value.checklist ?? []);
  if (has("deleted_at")) next.deleted_at = timestamp(value.deleted_at, "Fecha de papelera");
  if (has("completed_at")) next.completed_at = timestamp(value.completed_at, "Fecha de entrega");
  return next;
}

function debtPayload(value: Record<string, unknown>) {
  const client = string(value.client, 220);
  if (!client) throw new Invalid("El cliente es obligatorio.");
  const amountDue = amount(value.amount_due, "Saldo pendiente");
  if (amountDue <= 0) throw new Invalid("El saldo pendiente debe ser mayor que cero.");
  return { client, amount_due: amountDue, note: string(value.note, 1000) || null };
}

const fieldNames: Record<string, string> = {
  text: "nombre", client: "cliente", description: "notas", date: "fecha de entrega", phone: "contacto",
  payment_amount: "abono", amount_due: "saldo", paid_in_full: "pago", priority: "prioridad", checklist: "checklist",
};
const statusNames: Record<string, string> = { pendiente: "Pendiente", proceso: "En proceso", listo: "Listo" };

type Entry = { id: number; at: string; table_name: string; row_id: string; action: string; old_row: Record<string, unknown> | null; new_row: Record<string, unknown> | null };

// Turns raw audit rows into short, human readable events for the board.
function describe(entry: Entry) {
  const before = entry.old_row ?? {};
  const after = entry.new_row ?? {};
  const row = entry.action === "delete" ? before : after;
  const isDebt = entry.table_name === "debts";
  const base = { id: entry.id, at: entry.at, table: entry.table_name, rowId: entry.row_id, label: String((isDebt ? row.client : row.text) ?? "") };
  if (entry.action === "insert") return { ...base, kind: isDebt ? "debt_added" : "created", detail: isDebt ? String(row.amount_due ?? "") : "" };
  if (entry.action === "delete") return { ...base, kind: isDebt ? "debt_paid" : "deleted", detail: "", row: before };
  if (!before.deleted_at && after.deleted_at) return { ...base, kind: "trashed", detail: "" };
  if (before.deleted_at && !after.deleted_at) return { ...base, kind: "restored", detail: "" };
  if (!before.completed_at && after.completed_at) return { ...base, kind: "delivered", detail: "" };
  if (before.completed_at && !after.completed_at) return { ...base, kind: "reopened", detail: "" };
  if (!before.awaiting_pickup && after.awaiting_pickup) return { ...base, kind: "pickup", detail: "" };
  const changed = Object.keys(fieldNames).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (before.status !== after.status && !changed.length) return { ...base, kind: "status", detail: statusNames[String(after.status)] ?? "" };
  return { ...base, kind: "updated", detail: changed.map((key) => fieldNames[key]).join(", ") };
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const cors = corsFor(origin);
  const respond = (payload: unknown, status = 200) => response(payload, status, cors);
  if (!origin || !allowedOrigins.has(origin)) return respond({ error: "Origen no permitido." }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET" && request.method !== "POST") return respond({ error: "Método no permitido." }, 405);

  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "desconocido";
  if (!allow(ip, "request")) return respond({ error: "Demasiadas solicitudes. Espera un momento." }, 429);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return respond({ error: "Servicio no configurado." }, 500);
  const database = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  try {
    if (request.method === "GET") {
      const now = Date.now();
      const purgeTrash = database.from("tasks").delete().not("deleted_at", "is", null).lt("deleted_at", now - TRASH_TTL);
      const pruneActivity = Math.random() < 0.05
        ? database.from("activity_log").delete().lt("at", new Date(now - ACTIVITY_TTL).toISOString())
        : Promise.resolve({ error: null });
      const [tasks, debts, activity, purged, pruned] = await Promise.all([
        database.from("tasks").select("*").order("updated_at", { ascending: false }),
        database.from("debts").select("*").order("updated_at", { ascending: false }),
        database.from("activity_log").select("*").order("at", { ascending: false }).limit(40),
        purgeTrash,
        pruneActivity,
      ]);
      for (const { error } of [tasks, debts, activity, purged, pruned]) if (error) throw error;
      const live = (tasks.data ?? []).filter((task) => !task.deleted_at || task.deleted_at >= now - TRASH_TTL);
      return respond({ data: live, debts: debts.data, activity: ((activity.data ?? []) as Entry[]).map(describe) });
    }

    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) throw new Invalid("Solicitud demasiado grande.", 413);
    const raw = await request.text();
    if (raw.length > MAX_BODY) throw new Invalid("Solicitud demasiado grande.", 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) ?? {};
    } catch {
      throw new Invalid("Solicitud inválida.");
    }
    const operation = body.operation;
    const record = (value: unknown) => (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    if (!allow(ip, "write")) throw new Invalid("Demasiadas acciones seguidas. Espera un momento.", 429);
    if ((operation === "delete" || operation === "debt_delete") && !allow(ip, "erase")) {
      throw new Invalid("Demasiados borrados en poco tiempo. Espera un momento.", 429);
    }

    if (operation === "insert") {
      const supplied = record(body.task);
      const id = identifier(supplied.id);
      const createdAt = timestamp(supplied.created_at, "Fecha de creación") ?? Date.now();
      const task = { id, ...taskPayload(supplied), created_at: createdAt, updated_at: Date.now() };
      const { data, error } = await database.from("tasks").upsert(task, { onConflict: "id" }).select().single();
      if (error) throw error;
      return respond({ data }, 201);
    }
    if (operation === "update") {
      const id = identifier(body.id);
      const patch = { ...taskPayload(record(body.task), true), updated_at: Date.now() };
      const { data, error } = await database.from("tasks").update(patch).eq("id", id).select().maybeSingle();
      if (error) throw error;
      if (!data) throw new Invalid("El proyecto ya no existe.", 404);
      return respond({ data });
    }
    if (operation === "delete") {
      const id = identifier(body.id);
      const { error } = await database.from("tasks").delete().eq("id", id);
      if (error) throw error;
      return respond({ ok: true });
    }
    if (operation === "debt_insert") {
      const supplied = record(body.debt);
      const id = identifier(supplied.id);
      const createdAt = timestamp(supplied.created_at, "Fecha de creación") ?? Date.now();
      const debt = { id, ...debtPayload(supplied), created_at: createdAt, updated_at: Date.now() };
      const { data, error } = await database.from("debts").upsert(debt, { onConflict: "id" }).select().single();
      if (error) throw error;
      return respond({ data }, 201);
    }
    if (operation === "debt_delete") {
      const id = identifier(body.id);
      const { error } = await database.from("debts").delete().eq("id", id);
      if (error) throw error;
      return respond({ ok: true });
    }
    return respond({ error: "Operación no permitida." }, 400);
  } catch (error) {
    if (error instanceof Invalid) return respond({ error: error.message }, error.status);
    console.error(error);
    const code = String((error as { code?: unknown })?.code ?? "");
    if (/^(22|23)/.test(code)) return respond({ error: "Datos no válidos." }, 422);
    return respond({ error: "No se pudo completar la solicitud." }, 500);
  }
});
