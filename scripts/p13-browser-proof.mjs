// Run only against the appbuilder-owned, Cua-prepared CDP port.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const port = process.argv[2];
const out = resolve(process.argv[3]);
mkdirSync(out, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = targets.filter((t) => t.type === "page");
assert.equal(pages.length, 1, "only owned isolated proof tab");
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let serial = 0;
const waiting = new Map();
ws.addEventListener("message", (event) => { const data = JSON.parse(event.data); if (data.id) { const item = waiting.get(data.id); waiting.delete(data.id); if (data.error) item.reject(data.error); else item.resolve(data.result); } });
function cdp(method, params = {}) { return new Promise((resolve, reject) => { const id = ++serial; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
const pause = (ms = 160) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expression) { for (let i = 0; i < 80; i++) { if (await js(`!!(${expression})`)) return; await pause(100); } throw new Error(`Timeout: ${expression}`); }
async function nav(query = "") { await cdp("Page.navigate", { url: `http://127.0.0.1:5193/p13${query}` }); await waitFor("document.querySelector('button') && document.body.textContent.includes('Fictional foundation block')"); }
function select(label, scope = "document") { return `[...${scope}.querySelectorAll('button')].find(b=>${label === "Demo Client" ? "b.textContent.includes(" + JSON.stringify(label) + ")" : "b.textContent.trim()===" + JSON.stringify(label)})`; }
async function click(label, scope = "document") {
  const point = await js(`(()=>{const b=${select(label, scope)}; if(!b||b.disabled)throw Error('Missing or disabled: ${label}'); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  await pause();
}
async function type(selector, value) { await js(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`); await cdp("Input.insertText", { text: value }); await pause(); }
const records = [];
async function shot(name) {
  await js("window.scrollTo(0,0)");
  const geometry = await js(`({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,dialog:document.querySelector('dialog[open]')?.getBoundingClientRect().toJSON(),focus:document.activeElement?.tagName})`);
  assert.equal(geometry.width, geometry.scrollWidth);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(out, name), Buffer.from(data, "base64")); records.push({ file: name, ...geometry });
}
try {
  await cdp("Page.enable");
  await cdp("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 13; Demo) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36" });
  for (const width of [360, 390, 768]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await nav();
    assert.ok(await js(`${select('Ask coach for substitute')}.getBoundingClientRect().height >= 44`));
    await shot(`entry-${width}.png`);
    await click("Ask coach for substitute");
    await waitFor("document.querySelector('dialog')?.open && document.querySelector('textarea')?.value.includes('Bench press')");
    assert.ok(await js("document.querySelector('dialog').contains(document.activeElement)"));
    await shot(`draft-${width}.png`);
    await click("Close", "document.querySelector('dialog')");
    assert.equal(await js("document.activeElement.textContent.trim()"), "Ask coach for substitute");
  }
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await nav(); await click("Ask coach for substitute");
  await type("textarea", "Please suggest a substitute for Bench press · Upper body. Available equipment: bands and dumbbells.");
  for (let i = 0; i < 8; i++) { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); assert.ok(await js("document.querySelector('dialog').contains(document.activeElement)||document.activeElement===document.body")); }
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await pause(); assert.equal(await js("document.querySelector('dialog').open"), false);
  await click("Ask coach for substitute"); assert.ok(await js("document.querySelector('textarea').value.includes('bands and dumbbells')"));
  await js("__p13.failSend=true"); await click("Send", "document.querySelector('dialog')");
  assert.ok(await js("document.querySelector('dialog').innerText.includes('Message not sent') && document.querySelector('textarea').value.includes('bands')"));
  await shot("insert-failure-390.png");
  await js("__p13.failSend=false"); await click("Send", "document.querySelector('dialog')");
  assert.equal(await js("__p13.messages.length"), 1); assert.equal(await js("__p13.activities.length"), 1);
  assert.equal(await js("document.querySelector('textarea').value"), ""); await shot("sent-390.png");
  await click("Close", "document.querySelector('dialog')"); await click("Coach inbox");
  await waitFor("document.body.innerText.includes('Demo Client')"); await click("Demo Client");
  assert.ok(await js("document.body.innerText.includes('Available equipment: bands and dumbbells')")); await shot("coach-thread-390.png");
  for (const cardio of [false, true]) for (const fail of [false, true]) {
    await nav(`?active=1${cardio ? '&cardio=1' : ''}`);
    await waitFor("document.querySelector('input')");
    await js(`__p13.failLog=${fail}`);
    const input = cardio ? "input[id^=dur-]" : "input[id^=wt-]";
    await type(input, "25");
    const id = await js(`document.querySelector(${JSON.stringify(input)}).id`);
    await js(`window.__savedInput=document.getElementById(${JSON.stringify(id)});true`);
    await click("Ask coach for substitute");
    assert.equal(await js("__p13.writes.filter(w=>w.kind==='log').length"), 1);
    assert.equal(await js("__p13.writes.find(w=>w.kind==='log').done"), false);
    assert.equal(await js(`document.getElementById(${JSON.stringify(id)}).value`), "25");
    assert.ok(await js(`document.getElementById(${JSON.stringify(id)})===window.__savedInput`));
    if (fail) { assert.ok(await js("document.querySelector('dialog').innerText.includes('Workout input did not save')")); await shot(`autosave-failure-${cardio ? 'cardio' : 'strength'}.png`); await js("__p13.failLog=false"); await click("Retry workout save", "document.querySelector('dialog')"); }
    await click("Close", "document.querySelector('dialog')");
    assert.ok(await js("document.body.innerText.includes('Step 1 of')"));
    assert.equal(await js(`document.getElementById(${JSON.stringify(id)}).value`), "25");
  }
  await nav("?active=1"); await waitFor("document.querySelector('input')");
  await click("Mark"); assert.ok(await js("document.body.innerText.includes('Step 2 of')"));
  await shot("runner-390.png"); await click("Ask coach for substitute"); await pause(1100); await click("Close", "document.querySelector('dialog')");
  assert.ok(await js("document.body.innerText.includes('Step 2 of') && document.body.innerText.includes('Rest 1:')"));
  await shot("runner-preserved-390.png");
  writeFileSync(resolve(out, "browser-proof.json"), JSON.stringify({ result: "PASS", records, checks: ["360/390/768 entry and dialog; 44px target; no overflow", "modal focus entry/Tab containment/Escape/restoration", "draft retention; insert failure; explicit confirmed Send", "exact sent request in real CoachInbox/Thread", "native dirty strength/cardio blur autosave success/failure; same input node and value; no Mark; retry", "runner step and rest preserved"] }, null, 2));
  console.log(JSON.stringify({ result: "PASS", screenshots: records.length, out }));
} finally { ws.close(); }
