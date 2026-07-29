---
title: "무결성 검증과 격리(INVALID) — 깨진 파일이 보드 전체를 멈추지 않게"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R11
milestone: M1
priority: P0
---

# 무결성 검증과 격리(INVALID) — 깨진 파일이 보드 전체를 멈추지 않게

> **R11 분할 사유**: 검증·격리 엔진(서버)과 오류 배너·격리 목록 화면(UI)은 검증 방식과 완료 시점이 달라 함께 묶으면 스프린트에 들어가지 않는다. 본 스토리는 **판정·격리·차단 로직**만 다룬다.

## 사용자 스토리 (User Story)

> **As a** 팀원,
> **I want** 머지 사고로 이슈 파일 몇 건이 깨져도 그 몇 건만 격리되고 나머지 보드는 평소대로 돌기를,
> **so that** 한 사람의 충돌 커밋 때문에 팀 전체가 보드를 못 쓰는 상황이 생기지 않는다.

## 인수 조건 (Acceptance Criteria)

- [x] Given frontmatter YAML이 깨진 이슈 파일 1건, When 조정하면, Then 해당 uid의 기존 인덱스 레코드가 **`INVALID`로 격리**되어 일반 조회·집계·검색에서 제외되고, **삭제되지는 않는다**. 오류 테이블에 (파일 경로, 마지막 정상 content hash, 오류 메시지, 발견 시각)이 보존된다.
- [x] Given `<<<<<<<` git conflict marker를 포함한 파일, When 조정하면, Then 파싱을 시도하지 않고 즉시 격리하며 **인덱싱하지 않는다**.
- [x] Given 손상 파일 1건 + conflict marker 파일 1건이 섞인 5,000건 데이터셋, When 보드·백로그·검색을 사용하면, Then 나머지 4,998건은 조회·생성·상태 전이가 정상 동작한다. *(AC10)*
- [x] Given 서로 다른 두 파일이 **같은 `uid`** 를 가짐, When 조정하면, Then 어느 쪽이 원본인지 알 수 없으므로 **자동 해결하지 않고 양쪽을 모두 격리**하고, 오류 테이블에 두 파일 경로를 모두 기록한다.
- [ ] Given 서로 다른 uid가 **같은 표시 키**를 가짐, When 조정하면, Then **격리하지 않고** 자동 재키잉(D3, R26) 경로로 넘겨 정상 동작시킨다.  
      **→ 이월: r26-auto-rekey(M5) — 격리하지 않고 넘기는 것까지 구현. 재키잉 실행이 R26**
- [x] Given 이슈의 `parent` uid가 파일 집합에 존재하지 않음, When 조정하면, Then 해당 이슈를 격리하고 수정 후보(최상위로 승격 / 유사 후보 uid)를 함께 표시한다. 존재하지 않는 `sprint` 참조도 동일하다.
- [x] Given 계층 순환(A→B→A 또는 A→B→C→A), When 조정하면, Then 순환에 포함된 **모든 엔티티를 격리**하고 순환 경로를 오류 메시지에 담는다.
- [ ] Given 머지 결과 ACTIVE 스프린트가 2건 이상, When 감지하면, Then **프로젝트 전체를 "스프린트 충돌" 상태**로 표시하고 스프린트 시작·종료 명령을 **409**로 차단한다. 이슈 조회·편집·상태 전이는 계속 동작한다.  
      **→ 이월: r05-sprint-crud(M2) — 충돌 **감지**와 `/integrity/issues` 보고는 구현했다. 차단할 시작·종료 명령 자체가 M2에 생긴다**
- [x] Given 동일 `backlog_rank`(또는 `board_rank`)를 가진 이슈 2건, When 목록을 정렬하면, Then 오류가 아니라 **`(rank, uid)` 결정적 tie-break**로 매번 같은 순서를 반환하고, 해당 구간이 **재균형 대상으로 표시**된다.
- [x] Given 격리된 이슈, When 그 이슈에 대한 수정·상태 전이·삭제를 시도하면, Then **409**와 함께 격리 유형 코드·파일 경로·복구 방법이 반환된다.
- [x] Given 격리된 이슈 X, When 다른 이슈에서 X를 `to`로 하는 링크를 추가·삭제하거나 X를 parent로 지정하려 하면, Then **409**로 차단된다. X를 참조하지 않는 이슈의 변경은 200이다.
- [x] Given 사람이 파일을 고쳐 오류를 해소, When 다음 조정이 돌면, Then 격리가 **자동 해제**되어 정상 조회·집계에 복귀하고, 오류 테이블 항목이 해소 처리되며 변경 차단이 풀린다.
- [x] Given 격리 항목이 있는 상태, When `GET /integrity/issues`를 호출하면, Then 파일 경로·격리 유형·오류 메시지·발견 시각·차단 중인 대상 목록이 반환된다.
- [x] Given 파싱은 성공했으나 도메인 불변조건만 깨진 파일, When 처리하면, Then 파싱 단계와 도메인 검증 단계가 분리되어 격리 유형이 서로 구분된다(`parse_error` / `conflict_marker` / `duplicate_uid` / `dangling_ref` / `cycle`).

> ✅ 해소: **409**다. 423(Locked)은 다른 주체가 자원을 점유했다는 뜻인데, 격리는 아무도
> 잡고 있지 않고 **보드가 그 상태를 보증하지 못한다**는 뜻이다. 해제 방법도 다르다 —
> 잠금은 기다리면 풀리지만 격리는 사람이 파일을 고쳐야 풀린다. 409는 '지금 상태와
> 충돌한다'이므로 여기에 맞고, 응답에 격리 유형·파일 경로·복구 방법을 함께 싣는다.

## 범위 밖 (Out of Scope)

- 오류 배너 UI·격리 항목 화면 → `r11b-integrity-error-banner.md`
- 중복 표시 키의 자동 재키잉 실행 → R26 (`r26-auto-rekey-former-keys.md`)
- LexoRank 재균형 실행 자체 → R3 (본 스토리는 **탐지와 표시**까지)
- 계층 규칙을 정상 API 경로에서 강제하는 검증(400) → R2 (본 스토리는 **머지로 이미 깨진 파일**의 사후 처리)
- 변조 방지(tamper-evident) 감사 — §3 비목표
- 격리 항목의 자동 수정 — 복구는 사람이 파일을 고치는 것으로 한다

## 선행 의존 (Depends on)

- `r08a-file-index-sync.md`
- `r08c-bulk-reconcile-tombstone.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.6(무결성 검증·격리) · §5.7(rank 한계) · §5.2(스프린트 ACTIVE 유일성)
- ADR `../../0_decisions/adr-006-shared-board-data-branch.md` (D2 — 머지 충돌을 격리 모델로 흡수)
- 검증: PRD AC10
