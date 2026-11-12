// Local-only real component proof: no auth, no env files, no live transport.
import { createServer } from "vite";
import { resolve } from "node:path";
import { p13FixturePlugin } from "./p13-fixture-plugin.mjs";
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {__ProgramTab, __MessagesTab} from '/src/pages/Client.jsx';
import CoachInbox from '/src/pages/CoachInbox.jsx';
import {createFixture, ctx} from '/scripts/p13-fixtures.mjs';
import '@fontsource-variable/archivo/wdth.css';
import '/src/index.css';
globalThis.__p13 = createFixture();
const params = new URLSearchParams(location.search);
if(params.get('cardio')) __p13.pack.assignment.current_day_index=1;
if(params.get('active')) __p13.session={id:'demo-session'};
function Proof(){
 const [coach,setCoach]=useState(false);
 return <MemoryRouter><main className="mx-auto max-w-3xl px-5 py-4 pb-24">
 <p className="mb-5 rounded-xl border border-ink/20 p-3 text-xs font-semibold">DEMO / FICTIONAL DATA · Local in-memory proof only</p>
 <button className="btn-ghost mb-4 min-h-[44px] px-4" onClick={()=>setCoach(!coach)}>{coach?'Client workout':'Coach inbox'}</button>
 {coach ? <CoachInbox/> : <__ProgramTab ctx={ctx} mode={params.get('mode')||'coached'} messagingOn={params.get('messaging')!=='off'}/>}
 </main></MemoryRouter>;
}
createRoot(document.getElementById('root')).render(<Proof/>);
`;
const csp = "default-src 'self'; connect-src 'self' ws:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'";
const server = await createServer({
  configFile: false, root: process.cwd(), envDir: resolve('scripts/p13-no-env'), envPrefix: 'P13_UNUSED_', publicDir: false,
  server: {host: '127.0.0.1', port: 5193, strictPort: true, headers: {'Content-Security-Policy': csp}},
  plugins: [p13FixturePlugin(), {
    name: 'p13-proof-entry',
    resolveId: (id) => id === '/__p13-entry.jsx' ? id : undefined,
    load: (id) => id === '/__p13-entry.jsx' ? entry : undefined,
    configureServer(s) {s.middlewares.use((req,res,next)=>{
      if(req.url?.split('?')[0] !== '/p13') return next();
      res.setHeader('Content-Type','text/html');
      res.end('<!doctype html><html><head><title>P13 fictional proof</title><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content"></head><body><div id="root"></div><script type="module" src="/__p13-entry.jsx"></script></body></html>');
    });},
  }],
});
await server.listen();
console.log('P13 loopback fixture: http://127.0.0.1:5193/p13');
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async()=>{await server.close(); process.exit(0);});
