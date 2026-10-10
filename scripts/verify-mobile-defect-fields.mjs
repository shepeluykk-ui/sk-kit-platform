// Gate: the mobile quick-submit payload (MobileSiteModal.tsx) must use the
// real DefectRemark field names. Before the fix, contractor attribution,
// responsible-person, inspector, category/sourceType, and photo evidence
// were silently dropped because the payload used different key names than
// the backend and DefectRemark type expect (responsibleContractorOrgId vs
// contractorOrgId, photoUrls vs beforePhotoUrls, etc). This is a structural
// regression guard, independent of the tsc gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(repoRoot, 'src', 'components', 'MobileSiteModal.tsx');
const source = fs.readFileSync(target, 'utf8');

const payloadMatch = source.match(/const newDefectPayload = \{([\s\S]*?)\n\s*\};/);
if (!payloadMatch) {
  console.log('could not locate newDefectPayload object literal in MobileSiteModal.tsx');
  process.exit(1);
}
const payload = payloadMatch[1];

const requiredKeys = [
  'contractorOrgId',
  'contractorOrgName',
  'responsiblePersonName',
  'issuedByInspectorName',
  'category',
  'sourceType',
  'beforePhotoUrls'
];
const missing = requiredKeys.filter(key => !new RegExp(`(^|[^A-Za-z])${key}\\s*:`).test(payload));

const bannedKeys = ['responsibleContractorOrgId', 'responsibleContractorName'];
const reintroduced = bannedKeys.filter(key => payload.includes(key));

// photoUrls (wrong name) must be absent as its own key; beforePhotoUrls
// containing "photoUrls" as a substring must not cause a false positive.
const hasBarePhotoUrlsKey = /(^|[^A-Za-z])photoUrls\s*:/.test(payload);

if (missing.length > 0 || reintroduced.length > 0 || hasBarePhotoUrlsKey) {
  if (missing.length > 0) console.log('missing required keys:', missing.join(', '));
  if (reintroduced.length > 0) console.log('reintroduced wrong keys:', reintroduced.join(', '));
  if (hasBarePhotoUrlsKey) console.log('payload still uses wrong key "photoUrls" instead of "beforePhotoUrls"');
  process.exit(1);
}

console.log('mobile defect field mapping verification passed');
process.exit(0);
