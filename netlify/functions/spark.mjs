import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const db = getDatabase();
const images = () => getStore("card-images");
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export const config = { path: ["/api/auth/:action", "/api/me", "/api/quotes", "/api/quotes/:id", "/api/favorites", "/api/images", "/api/images/:id"] };

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;
const SESSION_DAYS = 180;

const json = (data, status = 200) => Response.json(data, { status });
const bad = (error, status = 400) => json({ error }, status);

async function hashPin(pin, salt) {
  const buf = await scryptAsync(pin, salt, 32);
  return buf.toString("hex");
}

function normName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function validPin(pin) {
  return typeof pin === "string" && /^\d{4,8}$/.test(pin);
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  await db.sql`INSERT INTO sessions (token, user_id) VALUES (${token}, ${userId})`;
  return token;
}

async function currentUser(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const rows = await db.sql`
    SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.created_at > NOW() - make_interval(days => ${SESSION_DAYS}::int)`;
  return rows[0] ? { ...rows[0], token } : null;
}

async function userPayload(user) {
  const quotes = await db.sql`
    SELECT id, text AS t, author AS a, has_image FROM quotes WHERE user_id = ${user.id} ORDER BY created_at`;
  const favs = await db.sql`SELECT quote_key FROM favorites WHERE user_id = ${user.id}`;
  return {
    user: { name: user.name },
    quotes: quotes.map(({ has_image, ...q }) => ({ ...q, custom: true, ...(has_image ? { img: true } : {}) })),
    favorites: favs.map((f) => f.quote_key),
  };
}

async function register(body) {
  const name = normName(body.name);
  const pin = body.pin;
  if (name.length < 2) return bad("Имя — минимум 2 символа");
  if (!validPin(pin)) return bad("PIN — от 4 до 8 цифр");
  const key = name.toLowerCase();
  const exists = await db.sql`SELECT 1 FROM users WHERE name_key = ${key}`;
  if (exists.length) return bad("Такое имя уже занято", 409);
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPin(pin, salt);
  const [user] = await db.sql`
    INSERT INTO users (name, name_key, pin_hash, pin_salt)
    VALUES (${name}, ${key}, ${hash}, ${salt})
    ON CONFLICT (name_key) DO NOTHING
    RETURNING id, name`;
  if (!user) return bad("Такое имя уже занято", 409);
  const token = await createSession(user.id);
  return json({ token, ...(await userPayload(user)) });
}

async function login(body) {
  const name = normName(body.name);
  const pin = String(body.pin || "");
  const rows = await db.sql`
    SELECT id, name, pin_hash, pin_salt, failed_attempts, locked_until
    FROM users WHERE name_key = ${name.toLowerCase()}`;
  const u = rows[0];
  if (!u) return bad("Пользователь не найден", 404);
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    return bad("Слишком много попыток. Подожди несколько минут", 429);
  }
  const hash = await hashPin(pin, u.pin_salt);
  const ok = timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(u.pin_hash, "hex"));
  if (!ok) {
    const attempts = u.failed_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db.sql`UPDATE users SET failed_attempts = 0,
        locked_until = NOW() + make_interval(mins => ${LOCK_MINUTES}::int) WHERE id = ${u.id}`;
      return bad("Слишком много попыток. Подожди " + LOCK_MINUTES + " минут", 429);
    }
    await db.sql`UPDATE users SET failed_attempts = ${attempts} WHERE id = ${u.id}`;
    return bad("Неверный PIN", 401);
  }
  await db.sql`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ${u.id}`;
  const token = await createSession(u.id);
  return json({ token, ...(await userPayload(u)) });
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    if (path.startsWith("/api/images/") && method === "GET") {
      const id = String(context.params.id || "");
      if (!/^[a-f0-9]{16}$/.test(id)) return new Response("Not found", { status: 404 });
      const res = await images().getWithMetadata(id, { type: "arrayBuffer" });
      if (!res) return new Response("Not found", { status: 404 });
      return new Response(res.data, {
        headers: {
          "Content-Type": res.metadata?.contentType || "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (path.startsWith("/api/auth/")) {
      if (method !== "POST") return bad("Method not allowed", 405);
      const action = context.params.action;
      const body = await readBody(req);
      if (action === "register") return await register(body);
      if (action === "login") return await login(body);
      if (action === "logout") {
        const user = await currentUser(req);
        if (user) await db.sql`DELETE FROM sessions WHERE token = ${user.token}`;
        return json({ ok: true });
      }
      return bad("Not found", 404);
    }

    const user = await currentUser(req);
    if (!user) return bad("Нужно войти", 401);

    if (path === "/api/me" && method === "GET") {
      return json(await userPayload(user));
    }

    if (path === "/api/quotes" && method === "POST") {
      const body = await readBody(req);
      const text = String(body.t || "").trim().slice(0, 600);
      const author = String(body.a || "").trim().slice(0, 100);
      if (!text) return bad("Пустой текст");
      const id = randomBytes(8).toString("hex");
      await db.sql`INSERT INTO quotes (id, user_id, text, author) VALUES (${id}, ${user.id}, ${text}, ${author})`;
      return json({ quote: { id, t: text, a: author, custom: true } }, 201);
    }

    if (path === "/api/images" && method === "POST") {
      const type = (req.headers.get("content-type") || "").split(";")[0].trim();
      if (!IMAGE_TYPES.includes(type)) return bad("Нужна картинка (jpg, png, webp, gif)");
      const data = await req.arrayBuffer();
      if (!data.byteLength) return bad("Пустой файл");
      if (data.byteLength > MAX_IMAGE_BYTES) return bad("Картинка слишком большая");
      const caption = String(url.searchParams.get("t") || "").trim().slice(0, 600);
      const author = String(url.searchParams.get("a") || "").trim().slice(0, 100);
      const id = randomBytes(8).toString("hex");
      await images().set(id, data, { metadata: { contentType: type } });
      await db.sql`INSERT INTO quotes (id, user_id, text, author, has_image)
        VALUES (${id}, ${user.id}, ${caption}, ${author}, true)`;
      return json({ quote: { id, t: caption, a: author, custom: true, img: true } }, 201);
    }

    if (path.startsWith("/api/quotes/") && method === "DELETE") {
      const id = context.params.id;
      const del = await db.sql`DELETE FROM quotes WHERE id = ${id} AND user_id = ${user.id} RETURNING has_image`;
      if (del[0]?.has_image) await images().delete(id);
      return json({ ok: true });
    }

    if (path === "/api/favorites" && method === "POST") {
      const body = await readBody(req);
      const keys = (Array.isArray(body.add) ? body.add : []).map(String).filter(Boolean).slice(0, 500);
      for (const k of keys) {
        await db.sql`INSERT INTO favorites (user_id, quote_key) VALUES (${user.id}, ${k.slice(0, 800)})
          ON CONFLICT DO NOTHING`;
      }
      const remove = typeof body.remove === "string" ? body.remove : null;
      if (remove) await db.sql`DELETE FROM favorites WHERE user_id = ${user.id} AND quote_key = ${remove}`;
      return json({ ok: true });
    }

    return bad("Not found", 404);
  } catch (e) {
    console.error(e);
    return bad("Ошибка сервера", 500);
  }
};
