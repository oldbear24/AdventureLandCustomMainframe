// node:test reporter that renders results as a Markdown table for the GitHub Actions job summary.
// Usage: node --test --test-reporter=./scripts/github-summary-reporter.js --test-reporter-destination="$GITHUB_STEP_SUMMARY"
import path from 'node:path';

const ICONS = { passed: '✅', failed: '❌', skipped: '⏭️', todo: '📝' };
const cell = value => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const seconds = ms => `${(ms / 1000).toFixed(2)} s`;

export default async function* summaryReporter(source) {
  const started = performance.now();
  const results = [];
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, nesting, file, skip, todo, details } = event.data;
    const status = event.type === 'test:fail' ? 'failed' : skip ? 'skipped' : todo ? 'todo' : 'passed';
    const error = details.error?.cause ?? details.error;
    results.push({ name, nesting, file: file ? path.relative(process.cwd(), file) : '', status, duration: details.duration_ms ?? 0, error });
  }
  // Subtests finish before their parent; show each parent above its children.
  const groups = [];
  for (const result of results) {
    let index = groups.length;
    while (index > 0 && groups[index - 1].nesting > result.nesting) index--;
    groups.push({ nesting: result.nesting, rows: [result, ...groups.splice(index).flatMap(group => group.rows)] });
  }
  const ordered = groups.flatMap(group => group.rows);
  const count = status => results.filter(result => result.status === status).length;
  const failed = count('failed');

  yield `### ${failed ? '❌' : '✅'} Backend tests\n\n`;
  yield '| Passed | Failed | Skipped | Todo | Duration |\n| ---: | ---: | ---: | ---: | ---: |\n';
  yield `| ${count('passed')} | ${failed} | ${count('skipped')} | ${count('todo')} | ${seconds(performance.now() - started)} |\n\n`;
  yield '| Result | File | Test | Duration |\n| :---: | --- | --- | ---: |\n';
  for (const result of ordered) {
    const name = `${'&nbsp;&nbsp;'.repeat(result.nesting)}${result.nesting ? '↳ ' : ''}${cell(result.name)}`;
    yield `| ${ICONS[result.status]} | ${cell(result.file)} | ${name} | ${seconds(result.duration)} |\n`;
  }
  const failures = ordered.filter(result => result.status === 'failed' && result.error);
  if (failures.length) {
    yield '\n#### Failures\n\n';
    for (const result of failures) {
      const detail = String(result.error.stack ?? result.error.message ?? result.error).replace(/```/g, "'''");
      yield `<details><summary>${cell(result.file)} › ${cell(result.name)}</summary>\n\n\`\`\`\n${detail}\n\`\`\`\n\n</details>\n\n`;
    }
  }
  yield '\n';
}
