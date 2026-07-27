---
title: "파일 SoT ↔ SQLite 인덱스 동기화와 무손실 재빌드"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R8
milestone: M1
priority: P0
---

# 파일 SoT ↔ SQLite 인덱스 동기화와 무손실 재빌드

> **R8 분할 사유**: R8(§5.5)은 쓰기 경로 인덱싱·외부 변경 조정·대량 조정/tombstone 세 가지 독립 트리거를 담고 있어 한 스프린트에 들어가지 않는다. 본 스토리는 그중 **파생 인덱스의 정의와 재빌드 경로**만 다룬다.

## 사용자 스토리 (User Story)

> **As a** 개발자(내부 기술 스토리 — 저장 코어 담당자),
> **I want** `.localjira/` 파일을 유일한 원본으로 두고 SQLite를 언제든 버리고 다시 만들 수 있는 파생 인덱스로 유지하기를,
> **so that** 인덱스가 깨지거나 스키마가 바뀌어도 도메인 데이터를 한 건도 잃지 않고 조회 성능만 되찾을 수 있다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 이슈 생성 API가 200을 반환한 직후, When `.localjira/issues/LJ/LJ-12.md`를 직접 읽으면, Then frontmatter의 `uid`·`key`·`status`·`schema_version`이 API 응답 및 인덱스 조회 결과와 모두 일치한다.
- [ ] Given API 쓰기가 완료된 시점, When 인덱스를 조회하면, Then 인덱스 레코드는 항상 파일에서 파생된 값만 담으며, 파일에 없는 도메인 값(사람이 인덱스에만 넣은 값)은 존재할 수 없다.
- [ ] Given 이슈 5,000건 + 스프린트 + 코멘트(`.ops.jsonl`의 `resolve` op 포함) + run fixture, When 서버 중지 → `.local/index.sqlite` 삭제 → 재기동, Then 전체 재빌드가 자동 수행되고 삭제 전후 API 응답이 정규화 비교로 **동일**하다. 비교 제외 필드는 검색 score, 인덱싱 시각, claim/lease 등 런타임 상태뿐이다. *(AC2)*
- [ ] Given 위 5,000 파일 fixture, When 전체 재빌드 소요 시간을 측정하면, Then **≤ 10s**다. *(N2)*
- [ ] Given 종료 이후 파일이 하나도 바뀌지 않은 상태, When 서버를 재기동하면, Then 저장된 `(path, file identity, mtime, size)` 비교로 후보가 0건이 되어 **hash 재계산이 0회** 발생한다.
- [ ] Given 종료 이후 이슈 파일 1건만 외부에서 변경된 상태, When 서버를 재기동하면, Then 그 1건만 hash 검증·재파싱되고 증분 반영이 **≤ 100ms**다. *(N2)*
- [ ] Given 인덱스 스키마 버전이 서버가 기대하는 값과 다름, When 서버가 기동하면, Then 인덱스를 폐기하고 전체 재빌드하며 **도메인 파일은 한 바이트도 수정하지 않는다**(재빌드 후 `git -C .localjira status`가 clean).
- [ ] Given 인덱스에만 존재하고 대응 파일이 사라진 레코드, When 전체 재빌드가 끝나면, Then 그 레코드는 재빌드 결과에 남지 않는다.
- [ ] Given 코멘트 원문 파일 + 같은 ULID의 `.ops.jsonl`(`resolve` 후 `unresolve`), When 재빌드하면, Then 인덱스의 코멘트 현재 상태가 **op 순차 재생 결과**(= `unresolved`)와 일치하고, 원문 파일은 불변으로 유지된다.
- [ ] Given 전체 재빌드, When 완료되면, Then 도메인 이벤트가 **0건** 추가된다 — 인덱스는 파생물이므로 재생성이 변경 이력이 아니다.
- [ ] Given 알 수 없는 frontmatter 키와 임의의 본문 heading(`## 코멘트` 등)을 가진 이슈 파일, When 인덱싱하면, Then 알려진 필드만 인덱싱하고 **파일 원문은 그대로 보존**되며 API가 재작성하지 않는다. 본문 heading은 도메인 구분자로 파싱하지 않는다.
- [ ] Given `events/2026-07-27/<node_id>.jsonl`가 여러 node_id로 존재, When 재빌드하면, Then 모든 node 파일이 인덱싱되고 이벤트 정렬은 `at` 기준으로 병합된다.

## 범위 밖 (Out of Scope)

- 워처 기반 실시간 외부 변경 반영 → `r08b-external-change-reconcile.md`
- git checkout/pull 대량 조정, 삭제·rename tombstone → `r08c-bulk-reconcile-tombstone.md`
- 사람이 누르는 [전체 재인덱스]·[전체 검증] 버튼과 인덱스 상태 화면 → R21 (`r21-manual-reindex-full-verify.md`)
- outbox 저널·크래시 복구·fsync 순서 → R9 (`r09-atomic-write-outbox-recovery.md`)
- FTS5 검색 쿼리·필터 API 자체 → R4
- 파싱은 됐지만 도메인 불변조건이 깨진 파일의 격리 판정 → R11 (`r11a-integrity-validation-quarantine.md`)

## 선행 의존 (Depends on)

- 없음

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.3(파일 레이아웃) · §5.5(파일 ↔ 인덱스 동기화) · §1(핵심 성질 1)
- 검증: PRD AC2, NFR N2
