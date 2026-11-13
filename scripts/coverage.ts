#!/usr/bin/env node
/**
 * 离线算归因覆盖率：给「解释力」一个可重复的硬指标。
 *
 * 用法：
 *   node scripts/coverage.ts <stateDir> [--json]
 *   npm run coverage -- /path/to/.dsh-home/state/superagent
 *
 * `<stateDir>` 是**放着 orchestrator.sqlite 的目录**（superagent 的 stateDir），不是 DSH_HOME。
 * 只读：不写库、不改配置、不发请求。
 */
import { openStore } from '../src/adapter/superagent/db.ts'
import { auditDecisionCoverage, formatCoverageReport } from '../src/service/coverage.ts'

const args = process.argv.slice(2)
const json = args.includes('--json')
const stateDir = args.find(arg => !arg.startsWith('--'))

if (!stateDir) {
  console.error('用法：node scripts/coverage.ts <stateDir> [--json]')
  console.error('  <stateDir>：放着 orchestrator.sqlite 的目录，例如 .dsh-home/state/superagent')
  process.exit(2)
}

const store = openStore(stateDir)
if (!store) {
  console.error(`打不开 ${stateDir}/orchestrator.sqlite（不存在或不可读）`)
  process.exit(2)
}

try {
  const report = auditDecisionCoverage(store.decisions())
  console.log(json ? JSON.stringify(report, null, 2) : formatCoverageReport(report))
} finally {
  store.close()
}
