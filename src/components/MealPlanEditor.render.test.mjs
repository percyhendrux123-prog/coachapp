// Measured on a 390 px phone: the coach's meal editor rows were 8 px wider than the screen
// (the page scrolled sideways and each row's remove button sat under the card edge), because
// a flex-1 text input keeps its intrinsic width unless it is allowed to shrink (min-w-0).
import React from "react";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { renderToStaticMarkup } from "react-dom/server";

const server = await createServer({ configFile: false, root: new URL("../..", import.meta.url).pathname,
  envDir: "/nonexistent-editor-env", logLevel: "error", appType: "custom",
  server: { middlewareMode: true, hmr: false }, esbuild: { jsx: "automatic" } });
after(() => server.close());
const { default: MealPlanEditor } = await server.ssrLoadModule("/src/components/MealPlanEditor.jsx");

test("every stretching input in the meal editor may shrink on a phone", () => {
  const plan = { calories: 1800, protein_g: 150, fat_g: 50, carb_g: 180,
    meals: [{ name: "Meal 1", items: [{ food: "Greek yogurt, plain, nonfat", qty: "330 g", kcal: 197 }], note: "" }] };
  const html = renderToStaticMarkup(React.createElement(MealPlanEditor, { plan, onChange() {} }));
  const inputs = html.match(/<input[^>]*>/g) || [];
  const stretching = inputs.filter((i) => /class="[^"]*\bflex-1\b/.test(i));
  assert.ok(stretching.length >= 2, "meal name and food inputs render");
  for (const i of stretching) assert.match(i, /\bmin-w-0\b/, i.slice(0, 120));
});
