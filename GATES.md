# Gates: fix mobile defect quick-submit field mismatch

OWNS: src/components/MobileSiteModal.tsx, scripts/verify-mobile-defect-typecheck.mjs, scripts/verify-mobile-defect-fields.mjs, GATES.md

Scope: MobileSiteModal.tsx's "quick submit" defect form (the on-site inspector's mobile terminal) builds a payload for addDefect() using field names that do not match the real DefectRemark/backend contract established by the Phase 9L.2 migration (see src/components/RemarksDefectsView.tsx for the correct, already-migrated call). As a result every defect filed from the mobile terminal while online silently loses contractor attribution (contractorOrgId/contractorOrgName sent as responsibleContractorOrgId/responsibleContractorName, which the server ignores), the responsible person and issuing inspector name, the defect category and source type, and -- most visibly -- the inspector's photo evidence (sent as photoUrls, but the type and server only recognize beforePhotoUrls). Fix MobileSiteModal.tsx to send the correct field names/values, matching the convention already used in RemarksDefectsView.tsx.

- [x] G1: MobileSiteModal.tsx no longer produces a TypeScript error against the DefectRemark/addDefect contract (repo has pre-existing unrelated tsc errors from an in-progress migration; this gate is scoped to this file only)
  CHECK: node scripts/verify-mobile-defect-typecheck.mjs
  EXPECT: mobile defect typecheck verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a6963a3320b44008a02024e01c857852a8604bea89493395bf091fe0c11d7a24; exit=0; EXPECT=matched; output-sha256=ad2a3825a5f143d21995f199661eacb682db643456f606afa2112979b746d83c; output-bytes=44; shell=C:\Windows\system32\cmd.exe; cwd=D:\SK-KIT; path=fe53316b9512/21 entries

- [x] G2: the quick-submit payload uses the real field names (contractorOrgId, contractorOrgName, responsiblePersonName, issuedByInspectorName, category, sourceType, beforePhotoUrls) and no longer uses the wrong legacy names (responsibleContractorOrgId, responsibleContractorName, photoUrls)
  CHECK: node scripts/verify-mobile-defect-fields.mjs
  EXPECT: mobile defect field mapping verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7d80e25bc923b72846041c59395419ee69bfeef45e9acc875536abdc56c15091; exit=0; EXPECT=matched; output-sha256=ba1a98bd03816b4dcbaf09f18ce5e13e94b306646e3de058f3321507ae760734; output-bytes=48; shell=C:\Windows\system32\cmd.exe; cwd=D:\SK-KIT; path=fe53316b9512/21 entries
