// Gate: MobileSiteModal's defect-creation payload must satisfy the real
// DefectRemark/addDefect contract. The repo has pre-existing unrelated tsc
// errors from an in-progress backend migration, so this gate does not
// require a clean `tsc --noEmit` overall -- it requires that no error is
// reported against MobileSiteModal.tsx specifically.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const result = spawnSync(process.execPath, [tscBin, '--noEmit'], {
  cwd: repoRoot,
  encoding: 'utf8'
});

const combined = `${result.stdout || ''}${result.stderr || ''}`;
const offending = combined
  .split(/\r?\n/)
  .filter(line => line.includes('MobileSiteModal.tsx'));

if (offending.length > 0) {
  console.log('tsc errors against MobileSiteModal.tsx:');
  for (const line of offending) console.log(line);
  process.exit(1);
}

console.log('mobile defect typecheck verification passed');
process.exit(0);
