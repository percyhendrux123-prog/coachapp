import { allowedOrigins } from "./origins.ts";

Deno.test("redirect allowlist defaults to app hostname and localhost or explicit configuration", () => {
  const keys = ["APP_ORIGIN", "ALLOWED_ORIGINS"];
  const saved = keys.map((key) => Deno.env.get(key));
  const eq = (expected: string[]) => { if (JSON.stringify(allowedOrigins()) !== JSON.stringify(expected)) throw new Error(JSON.stringify(allowedOrigins())); };
  try {
    keys.forEach((key) => Deno.env.delete(key));
    eq(["localhost"]);
    Deno.env.set("APP_ORIGIN", "https://app.example.com/path");
    eq(["app.example.com", "localhost"]);
    Deno.env.set("ALLOWED_ORIGINS", " app.example.com, OTHER.example.com, app.example.com ");
    eq(["app.example.com", "other.example.com"]);
    Deno.env.delete("ALLOWED_ORIGINS");
    Deno.env.set("APP_ORIGIN", "not a url");
    eq(["localhost"]);
  } finally {
    keys.forEach((key, index) => saved[index] === undefined ? Deno.env.delete(key) : Deno.env.set(key, saved[index]!));
  }
});
