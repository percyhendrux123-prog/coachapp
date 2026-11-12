import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTRIBUTION_KEY,
  ATTRIBUTION_TTL_MS,
  sanitizeAttribution,
  attributionRef,
  captureAttribution,
} from "./attribution.js";

// captureAttribution reads window.localStorage. Node has no window, so stand one up per test.
function withStorage(seed = null) {
  const map = new Map();
  if (seed) map.set(ATTRIBUTION_KEY, typeof seed === "string" ? seed : JSON.stringify(seed));
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  globalThis.window = { localStorage: storage, location: { search: "", hostname: "app.example.com" } };
  return {
    stored: () => {
      const raw = map.get(ATTRIBUTION_KEY);
      return raw ? JSON.parse(raw) : null;
    },
  };
}

test.afterEach(() => { delete globalThis.window; });

const NOW = Date.parse("2026-09-08T14:24:00.000Z");
const TAGGED = "?src=ig&med=reel&camp=system-q4&cnt=2026-09-10-hook-01";

test("a tagged link is read, sanitized, and stored", () => {
  const s = withStorage();
  const got = captureAttribution({ search: TAGGED, hostname: "app.example.com", now: NOW });

  assert.deepEqual(got, {
    src: "ig",
    med: "reel",
    camp: "system-q4",
    cnt: "2026-09-10-hook-01",
    landing: "app.example.com",
    first_touch_at: "2026-09-08T14:24:00.000Z",
  });
  assert.deepEqual(s.stored(), got, "the same record is on disk for the next visit");
  assert.equal(attributionRef(got), "ig_reel_2026-09-10-hook-01");
});

test("no parameters → a complete direct record, and nothing is stored", () => {
  const s = withStorage();
  const got = captureAttribution({ search: "", hostname: "app.example.com", now: NOW });

  assert.equal(got.src, "direct");
  assert.equal(attributionRef(got), "direct_none_none");
  assert.equal(got.landing, "app.example.com");
  assert.equal(got.first_touch_at, "2026-09-08T14:24:00.000Z");
  // Storing "direct" would sit there for 30 days and swallow the tagged click that follows it.
  assert.equal(s.stored(), null, "an untagged visit writes nothing");
});

test("first touch wins — a second, differently tagged visit does not overwrite it", () => {
  const s = withStorage();
  captureAttribution({ search: TAGGED, hostname: "app.example.com", now: NOW });

  const later = captureAttribution({
    search: "?src=yt&med=short&camp=other&cnt=b",
    hostname: "app.example.com",
    now: NOW + 5 * 24 * 60 * 60 * 1000,
  });

  assert.equal(later.src, "ig", "the first post keeps the credit");
  assert.equal(later.cnt, "2026-09-10-hook-01");
  assert.equal(s.stored().src, "ig");
});

test("an untagged visit later still reports the stored first touch", () => {
  withStorage();
  captureAttribution({ search: TAGGED, hostname: "app.example.com", now: NOW });
  const later = captureAttribution({ search: "", hostname: "app.example.com", now: NOW + 60_000 });
  assert.equal(later.src, "ig");
});

test("the record expires after 30 days, and the next tagged visit takes over", () => {
  const s = withStorage();
  captureAttribution({ search: TAGGED, hostname: "app.example.com", now: NOW });

  const past = captureAttribution({
    search: "?src=yt&med=short&camp=q4&cnt=hook-02",
    hostname: "app.example.com",
    now: NOW + ATTRIBUTION_TTL_MS + 1,
  });

  assert.equal(past.src, "yt", "expired first touch gives way");
  assert.equal(s.stored().cnt, "hook-02");
});

test("one day short of 30 days, the stored record still holds", () => {
  withStorage();
  captureAttribution({ search: TAGGED, hostname: "app.example.com", now: NOW });
  const inside = captureAttribution({
    search: "?src=yt",
    hostname: "app.example.com",
    now: NOW + ATTRIBUTION_TTL_MS - 1,
  });
  assert.equal(inside.src, "ig");
});

test("a partly tagged link fills the rest with defaults, never blanks", () => {
  withStorage();
  const got = captureAttribution({ search: "?src=ig", hostname: "app.example.com", now: NOW });
  assert.deepEqual(
    { src: got.src, med: got.med, camp: got.camp, cnt: got.cnt },
    { src: "ig", med: "none", camp: "none", cnt: "none" },
  );
});

test("corrupt, undated, or future-dated storage is ignored rather than trusted", () => {
  for (const seed of ["not json", { src: "ig" }, { src: "ig", first_touch_at: "2099-01-01T00:00:00.000Z" }]) {
    withStorage(seed);
    const got = captureAttribution({ search: "", hostname: "app.example.com", now: NOW });
    assert.equal(got.src, "direct", `bad stored record should not be used: ${JSON.stringify(seed)}`);
  }
});

test("blocked storage (private browsing) never throws — checkout still works", () => {
  globalThis.window = {
    get localStorage() { throw new Error("access denied"); },
    location: { search: TAGGED, hostname: "app.example.com" },
  };
  const got = captureAttribution({ now: NOW });
  assert.equal(got.src, "ig", "the current link is still read, it just is not remembered");
});

test("sanitizing: lowercased, trimmed, stripped to [a-z0-9._-], capped at 64", () => {
  const a = sanitizeAttribution({
    src: "  IG ",
    med: "Re el",
    camp: "sys<script>tem",
    cnt: "c".repeat(200),
    landing: "APP.Example.com",
    first_touch_at: "2026-09-08T14:24:00Z",
  });
  assert.equal(a.src, "ig");
  assert.equal(a.med, "reel");
  assert.equal(a.camp, "sysscripttem");
  assert.equal(a.cnt.length, 64);
  assert.equal(a.landing, "app.example.com");
  assert.equal(a.first_touch_at, "2026-09-08T14:24:00.000Z");
});

test("no field is ever blank, whatever it is handed", () => {
  for (const input of [null, undefined, "x", 7, [], { src: "", med: "  ", camp: "!!!", cnt: null }]) {
    for (const [k, v] of Object.entries(sanitizeAttribution(input))) {
      assert.equal(typeof v, "string", `${k} should be a string`);
      assert.notEqual(v, "", `${k} should never be blank`);
    }
  }
});
