#!/usr/bin/env node
// Actual Chat nesting from 5.11492.5: a square ChatComposer shell contains a
// rounded input field plus a controls footer. Backdrop-off is the control case.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installEngine, mkWc, settle, findChromium, dumpDom, readProbe, reporter, runSuite, Skip } from '../lib/theme-engine-harness.mjs';

await runSuite(async () => {
  const r = reporter('Chat backdrop backing and glass boundaries');
  const chromium = findChromium();
  if (!chromium) throw new Skip('Chromium unavailable');
  const out = mkdtempSync(join(tmpdir(), 'cdb-backdrop-chat-'));
  const cases = [
    ['scene', 'braille-stars', '', true],
    ['palette-with-backdrop', 'nord', 'braille-stars', true],
    ['backdrop-without-palette', '', 'braille-stars', true],
    ['palette-backdrop-off', 'braille-stars', 'off', false],
    ['stock', '', 'off', false],
  ];
  for (const [name, activeTheme, activeBackdrop, enabled] of cases) {
    const { themes, appEvents } = installEngine({ config: { activeTheme, activeBackdrop, themeWatch: false } });
    const wc = mkWc(); appEvents['web-contents-created']({}, wc); wc.fire('dom-ready'); await settle();
    const css = wc.sheet() || '';
    const page = String.raw`<!doctype html><html data-mode="dark"><head><style>
      .dframe-root{--bg-000:251 25.4% 13.1%;--bg-100:251 41.5% 8%;--engine-glass-tint:#0a1430;--engine-glass-opacity:.3;--engine-glass-blur:20px}
      [data-chat-input-container],[data-cds=ChatComposer],[data-composer-card-holder],[data-disclaimer],.bg-page{background:#14111d}
      [data-cds=ChatComposer]{height:84px;width:768px}
      .rounded-composer{height:44px;border-radius:14px;background:#272331;border:1px solid #aaa}
      [data-cds=ChatComposerChin]{background:#14111d;box-shadow:0 0 0 32px #14111d}
      [data-approval-card-root]{background:#34303d}
      [data-testid=transcript-bottom-fade]{background:linear-gradient(to top,#14111d,transparent)}
    </style><style>${css}</style></head><body>
    <div class="dframe-root" ${enabled ? 'data-engine-backdrop-on data-engine-glass' : ''}><div data-testid="chat-column">
    <div data-chat-input-container id="outer"><div data-composer-card-holder id="holder"><div data-cds="ChatComposer" id="shell">
    <div class="rounded-composer" id="field"><div data-cds="ChatComposerEditor"><div contenteditable="true" id="edit">Draft</div></div></div>
    <div data-cds="ChatComposerChin" id="chin"><button id="send">Send</button></div></div>
    <div data-approval-card-root id="approval">Allow tool?</div></div></div>
    <div data-testid="transcript-bottom-fade" id="fade"><div data-testid="transcript-bottom-backing-start" class="bg-page" id="start"></div><div data-testid="transcript-bottom-backing-end" class="bg-page" id="end"></div><div data-testid="transcript-bottom-gap" class="bg-page" id="gap"></div></div>
    <div data-disclaimer id="disclaimer">Claude is AI and can make mistakes.</div></div></div>
    <pre id="probe"></pre><script>
    const s=id=>getComputedStyle(document.getElementById(id));
    const surfaces=Object.fromEntries(['outer','holder','shell','chin','start','end','gap','disclaimer'].map(id=>[id,{bg:s(id).backgroundColor,blur:s(id).backdropFilter}]));
    document.getElementById('edit').focus();let clicks=0;document.getElementById('send').onclick=()=>clicks++;document.getElementById('send').click();
    document.getElementById('probe').textContent=JSON.stringify({surfaces,fade:s('fade').backgroundImage,chinShadow:s('chin').boxShadow,field:{bg:s('field').backgroundColor,blur:s('field').backdropFilter,radius:s('field').borderRadius,border:s('field').borderTopWidth},approval:s('approval').backgroundColor,focused:document.activeElement.id,draft:document.getElementById('edit').textContent,clicks});
    </script></body></html>`;
    const path = join(out, name + '.html'); writeFileSync(path, page);
    const lines = readProbe(dumpDom(chromium, path), 'probe');
    if (!lines || lines.length !== 1 || !lines[0]) throw new Error('Style probe did not run');
    const probe = JSON.parse(lines[0]);
    if (enabled) {
      for (const [id, surface] of Object.entries(probe.surfaces)) {
        r.ok(surface.bg === 'rgba(0, 0, 0, 0)' && surface.blur === 'none', name + ': ' + id + ' stays clear', JSON.stringify(surface));
      }
      r.ok(probe.fade === 'none' && probe.chinShadow === 'none', name + ': footer/fade backings removed');
      r.ok(probe.field.bg !== 'rgba(0, 0, 0, 0)' && probe.field.blur === 'blur(20px) saturate(1.2)', name + ': rounded field retains glass');
    } else {
      r.ok(Object.values(probe.surfaces).every(s => s.bg === 'rgb(20, 17, 29)' && s.blur === 'none'), name + ': original solid backing is unchanged');
      r.ok(probe.fade !== 'none' && probe.chinShadow !== 'none', name + ': original fade and footer shadow unchanged');
    }
    r.ok(probe.field.radius === '14px' && probe.field.border === '1px', name + ': native corners and border preserved');
    r.ok(probe.approval === 'rgb(52, 48, 61)', name + ': approval card preserved');
    r.ok(probe.focused === 'edit' && probe.draft === 'Draft' && probe.clicks === 1, name + ': focus, draft and controls preserved');
    themes.apply(''); await settle();
  }
  r.done();
});
