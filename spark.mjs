import { getStore } from "@netlify/blobs";

const KEY = "custom_quotes";

export const config = { path: "/api/spark" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default async (req) => {
  const store = getStore("spark-quotes");
  const ownerPin = process.env.OWNER_PIN || "1234";

  if (req.method === "GET") {
    const quotes = (await store.get(KEY, { type: "json" })) || [];
    return json(quotes);
  }

  const pin = req.headers.get("x-owner-pin");
  if (pin !== ownerPin) {
    return json({ error: "Неверный PIN" }, 403);
  }

  if (req.method === "POST") {
    const { quote } = await req.json();
    if (!quote?.id || !quote?.t) {
      return json({ error: "Некорректная карточка" }, 400);
    }
    const quotes = (await store.get(KEY, { type: "json" })) || [];
    quotes.push(quote);
    await store.setJSON(KEY, quotes);
    return json({ ok: true });
  }

  if (req.method === "DELETE") {
    const { id } = await req.json();
    if (!id) return json({ error: "Нет id" }, 400);
    const quotes = (await store.get(KEY, { type: "json" })) || [];
    await store.setJSON(KEY, quotes.filter((q) => q.id !== id));
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
};
