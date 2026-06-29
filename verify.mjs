import { chromium } from 'playwright-core';
import { pathToFileURL } from 'url';
import path from 'path';

const file = pathToFileURL(path.resolve('index.html')).href;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

await page.goto(file, { waitUntil: 'networkidle' });

let ok = true;
const fail = (m) => { ok = false; console.log('  ✗ ' + m); };
const pass = (m) => console.log('  ✓ ' + m);

// Helpers operating on the live page (id-keyed)
const setWinner = (id, team) => page.evaluate(([id, team]) => {
  const sel = document.querySelector(`select[data-id="${id}"]`);
  if (!sel) throw new Error('no select ' + id);
  sel.value = team; sel.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, team]);
const matchInfo = (id) => page.evaluate((id) => {
  const sel = document.querySelector(`select[data-id="${id}"]`);
  const card = sel.closest('.match');
  return {
    fixture: card.querySelector('.fixture').textContent.replace(/\s+/g,' ').trim(),
    disabled: sel.disabled,
    options: [...sel.options].map(o => o.value).filter(Boolean),
    selected: sel.value,
    right: card.querySelectorAll('.pick.right').length,
    wrong: card.querySelectorAll('.pick.wrong').length,
  };
}, id);
const board = () => page.$$eval('#lboard .lrow', rows => rows.map(r => ({
  name: r.querySelector('.name').textContent.trim(),
  pts: parseInt(r.querySelector('.pts').childNodes[0].textContent.trim(), 10),
  hits: parseInt(r.querySelector('.pts small').textContent.trim(), 10),
})));

// 1) Stage tabs include 1/16 → 7 tabs (all + 6 stages)
const tabs = await page.$$eval('#stageSeg button', b => b.map(x => x.textContent.trim()));
console.log('TABS:', tabs.join(' | '));
tabs.length === 7 ? pass('7 stage tabs incl. 1/16') : fail(`expected 7 tabs got ${tabs.length}`);
const total = await page.textContent('#pillTotal');
total.trim() === '32' ? pass('32 total matches') : fail(`total ${total} != 32`);

// storage: page should read the shared Gist on load (dot goes green / online)
const dot = await page.getAttribute('#syncDot', 'class');
dot.includes('on') ? pass('gist read OK on load (online)') : fail(`syncDot=${dot} (gist read failed)`);
const storageNote = await page.textContent('#storageNote');
storageNote.includes('Gist') ? pass('storage note mentions Gist') : fail(`note: ${storageNote}`);

// 2) Before deciding, an 1/8 match is pending/disabled with no real teams
let r81 = await matchInfo('R8-1');
r81.disabled ? pass('R8-1 disabled before feeders decided') : fail('R8-1 should be disabled initially');
r81.fixture.includes('?') ? pass('R8-1 shows ? placeholders') : fail(`R8-1 fixture ${r81.fixture}`);

// 3) Decide R16-1 (Германия vs Парагвай → Германия) and R16-2 (Франция vs Швеция → Франция)
await setWinner('R16-1', 'Германия');
await setWinner('R16-2', 'Франция');
await page.waitForTimeout(120);
r81 = await matchInfo('R8-1');
// propagation: R8-1 fixture now Германия vs Франция, options exactly those two, enabled
(!r81.disabled) ? pass('R8-1 enabled after feeders decided') : fail('R8-1 still disabled');
(r81.fixture.includes('Германия') && r81.fixture.includes('Франция')) ? pass('R8-1 shows propagated teams (Германия vs Франция)') : fail(`R8-1 fixture ${r81.fixture}`);
(JSON.stringify([...r81.options].sort()) === JSON.stringify(['Германия','Франция'].sort()))
  ? pass('R8-1 dropdown options = the two qualified teams') : fail(`R8-1 options ${r81.options}`);

// R16-1: everyone picked Германия (7 right, 0 wrong)
const r161 = await matchInfo('R16-1');
(r161.right === 7 && r161.wrong === 0) ? pass('R16-1 all 7 correct') : fail(`R16-1 right ${r161.right} wrong ${r161.wrong}`);

// 4) Decide R8-1 → Франция. Then test cascade pruning:
await setWinner('R8-1', 'Франция');
await page.waitForTimeout(120);
let info = await matchInfo('R8-1');
info.selected === 'Франция' ? pass('R8-1 winner set to Франция') : fail('R8-1 not set');
// Now change R16-2 so Франция no longer qualifies (Швеция wins) → R8-1 result must auto-clear
await setWinner('R16-2', 'Швеция');
await page.waitForTimeout(120);
info = await matchInfo('R8-1');
(info.selected === '') ? pass('cascade: R8-1 winner cleared when Франция no longer qualifies') : fail(`R8-1 still ${info.selected} after upstream change`);
(info.fixture.includes('Германия') && info.fixture.includes('Швеция')) ? pass('R8-1 now Германия vs Швеция') : fail(`R8-1 fixture ${info.fixture}`);
// restore Франция
await setWinner('R16-2', 'Франция');
await page.waitForTimeout(80);

// 5) Scoring scenario — build a clean small scenario from scratch
await page.evaluate(() => { RESULTS = {}; render(); });
await page.waitForTimeout(60);
// R16-9 (Бразилия vs Япония) → Бразилия. Preds: Митя&Денис=Япония (wrong), others Бразилия (right). weight 1.
await setWinner('R16-9', 'Бразилия');
// R16-13 (Аргентина vs Кабо-Верде) → Аргентина: everyone Аргентина (7 right). weight 1.
await setWinner('R16-13', 'Аргентина');
await page.waitForTimeout(120);
const r169 = await matchInfo('R16-9');
(r169.right === 5 && r169.wrong === 2) ? pass('R16-9: 5 right / 2 wrong (Митя,Денис picked Япония)') : fail(`R16-9 right ${r169.right} wrong ${r169.wrong}`);

// Expected points after these two 1/16 results (weight 1 each):
// Everyone +1 for Аргентина. +1 for Бразилия except Митя & Денис.
const exp = { 'Митя':1,'Мила':2,'Даша':2,'Алёна':2,'Володя':2,'Даня':2,'Денис':1 };
const b = await board();
console.log('BOARD:', b.map(x=>`${x.name}:${x.pts}`).join(' '));
let scoreOk = true;
for (const row of b) { if (row.pts !== exp[row.name]) { scoreOk = false; fail(`${row.name} pts ${row.pts} != ${exp[row.name]}`); } }
if (scoreOk) pass('scoring matches expected for 1/16 results');
// leaderboard ordering: top group has 2 pts
(b[0].pts === 2) ? pass('leaderboard sorted, leader has 2 pts') : fail('leaderboard not sorted by pts');

// 6) decided count
const dec = await page.textContent('#pillDecided');
dec.trim() === '2' ? pass('decided count = 2') : fail(`decided ${dec} != 2`);

// 7) filter to 1/16 shows 16 matches
await page.click('#stageSeg button[data-s="1/16"]');
await page.waitForTimeout(100);
const c16 = await page.$$eval('.match', m => m.length);
c16 === 16 ? pass('1/16 filter shows 16 matches') : fail(`1/16 shows ${c16}`);
await page.click('#stageSeg button[data-s="all"]');
await page.waitForTimeout(100);

// 8) Full champion run-through for one bracket (Денис → champion Аргентина), check FINAL & BRONZE wiring
await page.evaluate(() => { RESULTS = {}; render(); });
const denisPath = {
  'R16-2':'Франция','R16-7':'США','R16-13':'Аргентина','R16-14':'Австралия', // feeders we need
};
// Build Денис's full winning path to the final via his picks:
const setSeq = [
  ['R16-1','Германия'],['R16-2','Франция'],   // R8-1
  ['R16-3','Канада'],['R16-4','Нидерланды'],   // R8-2
  ['R16-5','Португалия'],['R16-6','Испания'],  // R8-3
  ['R16-7','США'],['R16-8','Бельгия'],         // R8-4
  ['R16-9','Япония'],['R16-10','Норвегия'],    // R8-5
  ['R16-11','Мексика'],['R16-12','Англия'],    // R8-6
  ['R16-13','Аргентина'],['R16-14','Австралия'],// R8-7
  ['R16-15','Швейцария'],['R16-16','Колумбия'],// R8-8
  ['R8-1','Франция'],['R8-2','Нидерланды'],['R8-3','Португалия'],['R8-4','США'],
  ['R8-5','Япония'],['R8-6','Мексика'],['R8-7','Аргентина'],['R8-8','Колумбия'],
  ['R4-1','Франция'],['R4-2','США'],['R4-3','Япония'],['R4-4','Аргентина'],
  ['R2-1','Франция'],['R2-2','Аргентина'],
  ['FINAL','Аргентина'],
];
for (const [id,t] of setSeq) await setWinner(id, t);
await page.waitForTimeout(150);
const fin = await matchInfo('FINAL');
(fin.fixture.includes('Франция') && fin.fixture.includes('Аргентина')) ? pass('FINAL fixture = Франция vs Аргентина (propagated)') : fail(`FINAL fixture ${fin.fixture}`);
// BRONZE teams = semifinal losers: R2-1 (Франция vs США → loser США), R2-2 (Япония vs Аргентина → loser Япония)
const bronze = await matchInfo('BRONZE');
(bronze.fixture.includes('США') && bronze.fixture.includes('Япония')) ? pass('BRONZE fixture = США vs Япония (SF losers)') : fail(`BRONZE fixture ${bronze.fixture}`);
(JSON.stringify([...bronze.options].sort()) === JSON.stringify(['США','Япония'].sort())) ? pass('BRONZE options = the two SF losers') : fail(`BRONZE options ${bronze.options}`);
// Денис predicted champion Аргентина → his pick on FINAL is right
const champRight = await page.evaluate(() => {
  const card = document.querySelector('select[data-id="FINAL"]').closest('.match');
  const picks = [...card.querySelectorAll('.pick')];
  const d = picks.find(p => p.querySelector('.pname').textContent.trim()==='Денис');
  return d.classList.contains('right');
});
champRight ? pass('Денис FINAL pick (Аргентина) highlighted correct') : fail('Денис FINAL pick not highlighted');

console.log('CONSOLE ERRORS:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) fail('console errors present');

await page.screenshot({ path: 'verify-screenshot.png', fullPage: true });
console.log('screenshot -> verify-screenshot.png');
console.log(ok ? '\nRESULT: ALL CHECKS PASSED ✓' : '\nRESULT: FAILURES ✗');
await browser.close();
process.exit(ok ? 0 : 1);
