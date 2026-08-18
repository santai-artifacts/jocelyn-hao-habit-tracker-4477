import Database from "bun:sqlite";
import { mkdir } from "fs/promises";

await mkdir(`${import.meta.dir}/data`, { recursive: true });

const db = new Database(
  process.env.DATABASE_URL || `${import.meta.dir}/data/tv-tracker.db`
);

db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS shows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tvmaze_id INTEGER UNIQUE NOT NULL,
    name TEXT NOT NULL,
    image_url TEXT,
    status TEXT,
    genres TEXT DEFAULT '[]',
    summary TEXT,
    network TEXT,
    premiere_year TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    tvmaze_episode_id INTEGER,
    season INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    name TEXT,
    air_date TEXT,
    runtime INTEGER,
    UNIQUE(show_id, season, episode_number)
  );

  CREATE TABLE IF NOT EXISTS watched_episodes (
    episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    watched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rewatch_sessions (
    show_id INTEGER PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rewatched_episodes (
    episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    rewatched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default {
  port: process.env.PORT || 3000,

  async fetch(req: Request) {
    const url = new URL(req.url);
    const { pathname: path, searchParams } = url;
    const method = req.method;

    // Serve static files
    if (method === "GET" && !path.startsWith("/api/")) {
      const filePath = path === "/" ? "/index.html" : path;
      const file = Bun.file(`${import.meta.dir}/public${filePath}`);
      if (await file.exists()) return new Response(file);
      return new Response("Not found", { status: 404 });
    }

    try {
      // Search TVMaze
      if (path === "/api/search" && method === "GET") {
        const q = searchParams.get("q")?.trim();
        if (!q || q.length < 2) return json({ results: [] });
        const res = await fetch(
          `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`
        );
        const data = (await res.json()) as unknown[];
        return json({ results: data.slice(0, 12) });
      }

      // List shows with stats (including rewatch)
      if (path === "/api/shows" && method === "GET") {
        const shows = db
          .prepare(
            `SELECT s.*,
              COUNT(DISTINCT e.id) AS total_episodes,
              COUNT(DISTINCT w.episode_id) AS watched_count,
              CASE WHEN rs.show_id IS NOT NULL THEN 1 ELSE 0 END AS is_rewatch,
              COUNT(DISTINCT rw.episode_id) AS rewatch_count
             FROM shows s
             LEFT JOIN episodes e ON e.show_id = s.id
             LEFT JOIN watched_episodes w ON w.episode_id = e.id
             LEFT JOIN rewatch_sessions rs ON rs.show_id = s.id
             LEFT JOIN rewatched_episodes rw ON rw.episode_id = e.id
             GROUP BY s.id
             ORDER BY s.added_at DESC`
          )
          .all();
        return json({ shows });
      }

      // Add show
      if (path === "/api/shows" && method === "POST") {
        const { tvmazeId } = (await req.json()) as { tvmazeId: number };

        const exists = db
          .prepare("SELECT id FROM shows WHERE tvmaze_id = ?")
          .get(tvmazeId);
        if (exists) return json({ error: "Already added" }, 409);

        const [showRes, epsRes] = await Promise.all([
          fetch(`https://api.tvmaze.com/shows/${tvmazeId}`),
          fetch(`https://api.tvmaze.com/shows/${tvmazeId}/episodes`),
        ]);
        if (!showRes.ok) return json({ error: "Show not found" }, 404);

        const show = (await showRes.json()) as Record<string, unknown> & {
          id: number;
          name: string;
          image?: { medium?: string; original?: string };
          status?: string;
          genres?: string[];
          summary?: string;
          network?: { name?: string };
          webChannel?: { name?: string };
          premiered?: string;
        };
        const episodes = (await epsRes.json()) as Array<{
          id: number;
          season: number;
          number: number;
          name: string;
          airdate: string;
          runtime?: number;
        }>;

        const { lastInsertRowid: showId } = db
          .prepare(
            `INSERT INTO shows (tvmaze_id, name, image_url, status, genres, summary, network, premiere_year)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            show.id,
            show.name,
            show.image?.medium || show.image?.original || null,
            show.status || null,
            JSON.stringify(show.genres || []),
            show.summary
              ? (show.summary as string).replace(/<[^>]+>/g, "").trim()
              : null,
            show.network?.name || show.webChannel?.name || null,
            show.premiered ? show.premiered.slice(0, 4) : null
          );

        const insertEp = db.prepare(
          `INSERT OR IGNORE INTO episodes (show_id, tvmaze_episode_id, season, episode_number, name, air_date, runtime)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const ep of episodes.filter(
          (e) => e.season != null && e.number != null
        )) {
          insertEp.run(
            showId,
            ep.id,
            ep.season,
            ep.number,
            ep.name,
            ep.airdate,
            ep.runtime || null
          );
        }

        return json({ success: true, showId });
      }

      // Delete show
      const showMatch = path.match(/^\/api\/shows\/(\d+)$/);
      if (showMatch && method === "DELETE") {
        db.prepare("DELETE FROM shows WHERE id = ?").run(
          parseInt(showMatch[1])
        );
        return json({ success: true });
      }

      // Get episodes for a show (includes rewatched field)
      const epsMatch = path.match(/^\/api\/shows\/(\d+)\/episodes$/);
      if (epsMatch && method === "GET") {
        const episodes = db
          .prepare(
            `SELECT e.id, e.season, e.episode_number, e.name, e.air_date, e.runtime,
               CASE WHEN w.episode_id IS NOT NULL THEN 1 ELSE 0 END AS watched,
               CASE WHEN rw.episode_id IS NOT NULL THEN 1 ELSE 0 END AS rewatched
             FROM episodes e
             LEFT JOIN watched_episodes w ON w.episode_id = e.id
             LEFT JOIN rewatched_episodes rw ON rw.episode_id = e.id
             WHERE e.show_id = ?
             ORDER BY e.season, e.episode_number`
          )
          .all(parseInt(epsMatch[1]));
        return json({ episodes });
      }

      // Toggle episode watched/unwatched
      const epWatchMatch = path.match(/^\/api\/episodes\/(\d+)\/watch$/);
      if (epWatchMatch) {
        const epId = parseInt(epWatchMatch[1]);
        if (method === "POST") {
          db.prepare(
            "INSERT OR IGNORE INTO watched_episodes (episode_id) VALUES (?)"
          ).run(epId);
        } else if (method === "DELETE") {
          db.prepare(
            "DELETE FROM watched_episodes WHERE episode_id = ?"
          ).run(epId);
        }
        return json({ success: true });
      }

      // Watch/unwatch entire season
      const seasonMatch = path.match(/^\/api\/shows\/(\d+)\/watch-season\/(\d+)$/);
      if (seasonMatch) {
        const [, showId, season] = seasonMatch;
        if (method === "POST") {
          db.prepare(
            `INSERT OR IGNORE INTO watched_episodes (episode_id)
             SELECT id FROM episodes WHERE show_id = ? AND season = ?`
          ).run(parseInt(showId), parseInt(season));
        } else if (method === "DELETE") {
          db.prepare(
            `DELETE FROM watched_episodes WHERE episode_id IN (
               SELECT id FROM episodes WHERE show_id = ? AND season = ?
             )`
          ).run(parseInt(showId), parseInt(season));
        }
        return json({ success: true });
      }

      // Toggle rewatch mode for a show
      const rewatchShowMatch = path.match(/^\/api\/shows\/(\d+)\/rewatch$/);
      if (rewatchShowMatch) {
        const showId = parseInt(rewatchShowMatch[1]);
        if (method === "POST") {
          db.prepare(
            "INSERT OR IGNORE INTO rewatch_sessions (show_id) VALUES (?)"
          ).run(showId);
        } else if (method === "DELETE") {
          db.prepare(
            "DELETE FROM rewatch_sessions WHERE show_id = ?"
          ).run(showId);
        }
        return json({ success: true });
      }

      // Toggle episode rewatched/un-rewatched
      const epRewatchMatch = path.match(/^\/api\/episodes\/(\d+)\/rewatch$/);
      if (epRewatchMatch) {
        const epId = parseInt(epRewatchMatch[1]);
        if (method === "POST") {
          db.prepare(
            "INSERT OR IGNORE INTO rewatched_episodes (episode_id) VALUES (?)"
          ).run(epId);
        } else if (method === "DELETE") {
          db.prepare(
            "DELETE FROM rewatched_episodes WHERE episode_id = ?"
          ).run(epId);
        }
        return json({ success: true });
      }

      // Bulk rewatch/un-rewatch season
      const rewatchSeasonMatch = path.match(
        /^\/api\/shows\/(\d+)\/rewatch-season\/(\d+)$/
      );
      if (rewatchSeasonMatch) {
        const [, showId, season] = rewatchSeasonMatch;
        if (method === "POST") {
          db.prepare(
            `INSERT OR IGNORE INTO rewatched_episodes (episode_id)
             SELECT id FROM episodes WHERE show_id = ? AND season = ?`
          ).run(parseInt(showId), parseInt(season));
        } else if (method === "DELETE") {
          db.prepare(
            `DELETE FROM rewatched_episodes WHERE episode_id IN (
               SELECT id FROM episodes WHERE show_id = ? AND season = ?
             )`
          ).run(parseInt(showId), parseInt(season));
        }
        return json({ success: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[Error]", msg);
      return json({ error: msg }, 500);
    }
  },
};
