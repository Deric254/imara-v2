const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

function runScenario(seed) {
  return new Promise((resolve) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'imara-fuzz-'));
    const child = spawn('node', [path.join(__dirname, 'fuzz_scenario.js'), String(seed)], {
      cwd: __dirname,
      env: { ...process.env, HOME: tmpHome },
    });
    let output = '';
    child.stdout.on('data', d => output += d.toString());
    child.stderr.on('data', () => {}); // discard noisy migration logs
    child.on('close', () => {
      const line = output.split('\n').find(l => l.startsWith('FUZZRESULT:'));
      if (!line) {
        resolve({ seed, crashed: true, error: 'no result line found', rawOutput: output.slice(-500) });
        return;
      }
      try {
        resolve(JSON.parse(line.slice('FUZZRESULT:'.length)));
      } catch (e) {
        resolve({ seed, crashed: true, error: 'parse error: ' + e.message });
      }
    });
  });
}

(async () => {
  const NUM_SCENARIOS = 25;
  console.log(`Running ${NUM_SCENARIOS} fuzz scenarios, each in a TRUE isolated child process...\n`);

  let totalFails = 0;
  const allResults = [];
  for (let seed = 1; seed <= NUM_SCENARIOS; seed++) {
    const result = await runScenario(seed);
    allResults.push(result);
    const converged = result.convergeDiff === null || result.convergeDiff === undefined || result.convergeDiff < 1;
    const ok = !result.crashed && (result.failCount || 0) === 0 && converged;
    console.log(`${ok ? '✅' : '❌'} Scenario ${seed}: sellAll=${result.sellEverything} checks=${result.checksTotal} fails=${result.failCount || 0} netProfit=${result.netProfit} soldNet=${result.soldNet} convergeDiff=${result.convergeDiff}`);
    if (result.crashed) { console.log(`   CRASHED: ${result.error}`); totalFails++; }
    if (result.failCount > 0) { totalFails += result.failCount; for (const f of result.fails) console.log(`   FAIL: ${f.label}: ${f.detail}`); }
    if (!converged) { totalFails++; console.log(`   CONVERGENCE FAIL: diff=${result.convergeDiff}`); }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`FUZZ TEST COMPLETE (true process isolation): ${NUM_SCENARIOS} scenarios, ${totalFails} total failures`);
  console.log('='.repeat(70));
  process.exit(totalFails > 0 ? 1 : 0);
})();
