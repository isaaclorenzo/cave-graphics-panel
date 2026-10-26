import { createClient } from "jsr:@supabase/supabase-js@2";

// GitHub Pages origins allowed to call this function. The account was renamed from
// kratos561 to isaaclorenzo, so both are accepted. CAVE_ALLOWED_ORIGIN can add more
// origins as a comma-separated list.
const allowedOrigins = new Set([
  "https://isaaclorenzo.github.io",
  "https://kratos561.github.io",
  ...(Deno.env.get("CAVE_ALLOWED_ORIGIN") ?? "").split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean),
]);

function corsFor(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://isaaclorenzo.github.io",
    "Access-Control-Allow-Headers": "content-type, x-cave-access",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Vary": "Origin",
  };
}

const statuses = new Set(["pendiente", "proceso", "listo"]);
const priorities = new Set(["normal", "alta", "urgente"]);

function response(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function string(value: unknown, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function taskPayload(value: Record<string, unknown>, partial = false) {
  const next: Record<string, unknown> = {};
  if (!partial || "text" in value) {
    const text = string(value.text, 220);
    if (!text) throw new Error("El nombre del proyecto es obligatorio.");
    next.text = text;
  }
  for (const [key, max] of [["client", 220], ["description", 5000], ["phone", 80]] as const) {
    if (!partial || key in value) next[key] = string(value[key], max) || null;
  }
  if (!partial || "date" in value) {
    const date = string(value.date, 10);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Fecha inválida.");
    next.date = date || null;
  }
  if (!partial || "payment_amount" in value) {
    const amount = Number(value.payment_amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) throw new Error("Abono inválido.");
    next.payment_amount = amount;
  }
  if (!partial || "amount_due" in value) {
    const amountDue = Number(value.amount_due ?? 0);
    if (!Number.isFinite(amountDue) || amountDue < 0 || amountDue > 100000000) throw new Error("Saldo pendiente inválido.");
    next.amount_due = amountDue;
  }
  if (!partial || "paid_in_full" in value) {
    if (typeof value.paid_in_full !== "boolean") throw new Error("Estado de pago inválido.");
    next.paid_in_full = value.paid_in_full;
  }
  if (!partial || "awaiting_pickup" in value) {
    if (typeof value.awaiting_pickup !== "boolean") throw new Error("Estado de retiro inválido.");
    next.awaiting_pickup = value.awaiting_pickup;
  }
  if (!partial || "status" in value) {
    const status = string(value.status, 24) || "pendiente";
    if (!statuses.has(status)) throw new Error("Estado inválido.");
    next.status = status;
  }
  if (!partial || "priority" in value) {
    const priority = string(value.priority, 24) || "normal";
    if (!priorities.has(priority)) throw new Error("Prioridad inválida.");
    next.priority = priority;
  }
  if (!partial || "deleted_at" in value) {
    const deletedAt = value.deleted_at;
    if (deletedAt !== null && deletedAt !== undefined && (!Number.isInteger(deletedAt) || Number(deletedAt) < 0)) throw new Error("Archivo inválido.");
    next.deleted_at = deletedAt ?? null;
  }
  return next;
}

function debtPayload(value: Record<string, unknown>) {
  const client = string(value.client, 220);
  if (!client) throw new Error("El cliente es obligatorio.");
  const amountDue = Number(value.amount_due ?? 0);
  if (!Number.isFinite(amountDue) || amountDue <= 0 || amountDue > 100000000) throw new Error("El saldo pendiente debe ser mayor que cero.");
  return { client, amount_due: amountDue, note: string(value.note, 1000) || null };
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const cors = corsFor(origin);
  const respond = (payload: unknown, status = 200) => response(payload, status, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (origin && !allowedOrigins.has(origin)) return respond({ error: "Origen no permitido." }, 403);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return respond({ error: "Servicio no configurado." }, 500);
  const database = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  try {
    if (request.method === "GET") {
      const expiredAt = Date.now() - 48 * 60 * 60 * 1000;
      const { error: cleanupError } = await database
        .from("tasks")
        .delete()
        .not("deleted_at", "is", null)
        .lt("deleted_at", expiredAt);
      if (cleanupError) throw cleanupError;
      const [{ data, error }, { data: debts, error: debtsError }] = await Promise.all([
        database.from("tasks").select("*").order("updated_at", { ascending: false }),
        database.from("debts").select("*").order("updated_at", { ascending: false }),
      ]);
      if (error) throw error;
      if (debtsError) throw debtsError;
      return respond({ data, debts });
    }

    const body = await request.json();
    const operation = body?.operation;
    if (operation === "insert") {
      const supplied = body.task ?? {};
      const id = string(supplied.id, 100);
      if (!id) throw new Error("Identificador inválido.");
      const task = { id, ...taskPayload(supplied), created_at: Date.now(), updated_at: Date.now() };
      const { data, error } = await database.from("tasks").insert(task).select().single();
      if (error) throw error;
      return respond({ data }, 201);
    }
    if (operation === "update") {
      const id = string(body.id, 100);
      if (!id) throw new Error("Identificador inválido.");
      const patch = { ...taskPayload(body.task ?? {}, true), updated_at: Date.now() };
      const { data, error } = await database.from("tasks").update(patch).eq("id", id).select().single();
      if (error) throw error;
      return respond({ data });
    }
    if (operation === "delete") {
      const id = string(body.id, 100);
      if (!id) throw new Error("Identificador inválido.");
      const { data, error } = await database.from("tasks").delete().eq("id", id).select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("El proyecto ya no existe.");
      return respond({ ok: true });
    }
    if (operation === "debt_insert") {
      const supplied = body.debt ?? {};
      const id = string(supplied.id, 100);
      if (!id) throw new Error("Identificador inválido.");
      const debt = { id, ...debtPayload(supplied), created_at: Date.now(), updated_at: Date.now() };
      const { data, error } = await database.from("debts").insert(debt).select().single();
      if (error) throw error;
      return respond({ data }, 201);
    }
    if (operation === "debt_delete") {
      const id = string(body.id, 100);
      if (!id) throw new Error("Identificador inválido.");
      const { data, error } = await database.from("debts").delete().eq("id", id).select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("El cobro ya no existe.");
      return respond({ ok: true });
    }
    return respond({ error: "Operación no permitida." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo completar la solicitud.";
    return respond({ error: message }, 400);
  }
});
