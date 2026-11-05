import type { Config } from "@netlify/functions";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { cards } from "../../db/schema.js";

export const config: Config = { path: "/api/spark" };

const json = (data: unknown, status = 200) => Response.json(data, { status });

export default async (req: Request) => {
  if (req.method === "GET") {
    const rows = await db.select().from(cards).orderBy(asc(cards.createdAt));
    return json(
      rows.map((r) => ({ id: r.id, t: r.text, a: r.author, tag: r.tag, custom: true }))
    );
  }

  const ownerPin = Netlify.env.get("OWNER_PIN") || "1234";
  if (req.headers.get("x-owner-pin") !== ownerPin) {
    return json({ error: "Неверный PIN" }, 403);
  }

  if (req.method === "POST") {
    const { quote } = await req.json().catch(() => ({}));
    const t = typeof quote?.t === "string" ? quote.t.trim() : "";
    if (!quote?.id || !t) return json({ error: "Некорректная карточка" }, 400);
    await db
      .insert(cards)
      .values({
        id: String(quote.id).slice(0, 64),
        text: t.slice(0, 2000),
        author: typeof quote.a === "string" ? quote.a.trim().slice(0, 200) : "",
        tag: typeof quote.tag === "string" && quote.tag ? quote.tag.slice(0, 50) : "своё",
      })
      .onConflictDoNothing();
    return json({ ok: true }, 201);
  }

  if (req.method === "DELETE") {
    const { id } = await req.json().catch(() => ({}));
    if (!id) return json({ error: "Нет id" }, 400);
    await db.delete(cards).where(eq(cards.id, String(id)));
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
};
