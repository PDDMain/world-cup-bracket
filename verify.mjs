import { chromium } from 'playwright-core';
import { pathToFileURL } from 'url';
import path from 'path';

const file = pathToFileURL(path.resolve('index.html')).href;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1500 } });

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

await page.goto(file, { waitUntil: 'networkidle' });

// Helper: set a match winner by its slot text
async function setWinner(slot, team) {
  await page.evaluate(([slot, team]) => {
    const sel = document.querySelector(`select[data-slot="${encodeURIComponent(slot)}"]`);
    sel.value = team;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, [slot, team]);
}

// --- Enter sample results ---
await setWinner('1: Германия vs Франция', 'Германия');         // 1/8 w1, all 6 correct
await setWinner('5: Бразилия vs Кот-д.Ивуар', 'Бразилия');     // 1/8 w1, Митя wrong
await setWinner('Четвертьфинал 4', 'Аргентина');               // 1/4 w2, all correct
await setWinner('ЧЕМПИОН', 'Бразилия');                        // Финал w5, 3 correct

await page.waitForTimeout(300);

// --- Read leaderboard ---
const board = await page.$$eval('#lboard .lrow', rows => rows.map(r => ({
  name: r.querySelector('.name').textContent.trim(),
  pts: parseInt(r.querySelector('.pts').childNodes[0].textContent.trim(), 10),
  hits: parseInt(r.querySelector('.pts small').textContent.trim(), 10),
  lead: r.classList.contains('lead'),
})));

console.log('LEADERBOARD:');
board.forEach((b, i) => console.log(`  ${i+1}. ${b.name} — ${b.pts} pts, ${b.hits} hits${b.lead ? '  [LEAD]' : ''}`));

// --- Expected ---
const expected = {
  'Митя': { pts: 3, hits: 2 },
  'Мила': { pts: 9, hits: 4 },
  'Даша': { pts: 9, hits: 4 },
  'Алёна': { pts: 9, hits: 4 },
  'Володя': { pts: 4, hits: 3 },
  'Аня': { pts: 4, hits: 3 },
};
const expectedOrder = ['Алёна','Даша','Мила','Аня','Володя','Митя'];

let ok = true;
const fail = (m) => { ok = false; console.log('  ✗ ' + m); };

// scoring math
for (const b of board) {
  const e = expected[b.name];
  if (!e) { fail(`unexpected name ${b.name}`); continue; }
  if (b.pts !== e.pts) fail(`${b.name} pts ${b.pts} != expected ${e.pts}`);
  if (b.hits !== e.hits) fail(`${b.name} hits ${b.hits} != expected ${e.hits}`);
}
// ordering (reorders by points)
const order = board.map(b => b.name);
if (JSON.stringify(order) !== JSON.stringify(expectedOrder))
  fail(`order ${order.join(',')} != expected ${expectedOrder.join(',')}`);
// leader highlight: the 9-pt group should be flagged lead
for (const b of board) {
  const shouldLead = b.pts === 9;
  if (b.lead !== shouldLead) fail(`${b.name} lead=${b.lead} expected ${shouldLead}`);
}

// highlight logic in match cards: champion row -> 3 right, 3 wrong
const champ = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.match')];
  const card = cards.find(c => c.querySelector('.fixture').textContent.includes('ЧЕМПИОН'));
  return {
    right: card.querySelectorAll('.pick.right').length,
    wrong: card.querySelectorAll('.pick.wrong').length,
    decided: card.classList.contains('decided'),
  };
});
console.log('CHAMP CARD:', JSON.stringify(champ));
if (champ.right !== 3) fail(`champ right ${champ.right} != 3`);
if (champ.wrong !== 3) fail(`champ wrong ${champ.wrong} != 3`);
if (!champ.decided) fail('champ card not marked decided');

// pill / decided count
const decidedText = await page.textContent('#pillDecided');
if (decidedText.trim() !== '4') fail(`pill decided ${decidedText} != 4`);

// stage filter tabs exist (all + 5 stages = 6)
const tabs = await page.$$eval('#stageSeg button', b => b.map(x => x.textContent.trim()));
console.log('TABS:', tabs.join(' | '));
if (tabs.length !== 6) fail(`expected 6 tabs, got ${tabs.length}`);

// test a stage filter (1/8) shows only 8 matches
await page.click('#stageSeg button[data-s="1/8"]');
await page.waitForTimeout(150);
const eighthCount = await page.$$eval('.match', m => m.length);
if (eighthCount !== 8) fail(`1/8 filter showed ${eighthCount} matches, expected 8`);
await page.click('#stageSeg button[data-s="all"]');
await page.waitForTimeout(150);

console.log('CONSOLE ERRORS:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) fail('console errors present');

await page.screenshot({ path: 'verify-screenshot.png', fullPage: true });
console.log('screenshot -> verify-screenshot.png');

console.log(ok ? '\nRESULT: ALL CHECKS PASSED ✓' : '\nRESULT: FAILURES ✗');
await browser.close();
process.exit(ok ? 0 : 1);
