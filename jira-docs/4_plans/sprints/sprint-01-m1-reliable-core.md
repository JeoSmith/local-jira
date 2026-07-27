---
title: "Sprint 01 — M1 신뢰 가능한 코어"
status: planned
milestone: M1
scope_count: 20
created: 2026-07-27
updated: 2026-07-27
---

# Sprint 01 — M1 신뢰 가능한 코어

## 스프린트 목표

인증된 사용자가 이슈를 생성·조회·수정·검색할 수 있고, 프로세스 크래시나 외부 파일 편집,
git 대량 변경, SQLite 인덱스 유실 뒤에도 파일 SoT에서 일관된 상태로 복구되는 최소 코어를 완성한다.

스프린트 종료 시 다음 사용자 경로가 하나로 연결되어야 한다.

> admin 부트스트랩·로그인 → 이슈 생성 → 수정·정렬·관계 설정 → 필터·검색 →
> 이벤트·활동 조회 → 외부 편집 및 재기동 후 동일 결과 확인

## 기간·수용량

- 기간: 팀의 첫 계획 회의에서 확정
- 수용량: 담당 인원과 스토리 추정 후 확정
- 커밋 범위: M1 스토리 20건 전체
- 스트레치 범위: 없음

현재 스토리에 추정치가 없으므로 날짜나 포인트를 임의로 배정하지 않는다. 추정 결과 20건이 한
타임박스에 들어오지 않으면 목표를 흐리게 섞지 말고, 아래 **완료 절단선**을 기준으로 Sprint 01과
Sprint 02로 나눈다.

## 착수 조건

- [ ] [M0 부트스트랩 상세 설계](../../3_designs/detailed/m0-bootstrap.design.md)에 따른 초기화 명령으로
      `localjira/data` orphan 브랜치·worktree가 준비되어 있다(배치 결정은
      [ADR-006](../../0_decisions/adr-006-shared-board-data-branch.md)).
- [ ] [저장 계층 상세 설계](../../3_designs/detailed/storage-layer.design.md)와
      [SQLite 스키마](../../3_designs/database/index-schema.md)를 구현 기준선으로 승인한다.
- [ ] 각 스토리의 `⚠ 미정` 중 API·파일 스키마·복구 테스트를 바꾸는 항목은 구현 착수 전에 결정한다.
- [ ] 공통 테스트 fixture와 fault-injection 실행 방법을 정한다.

## 스프린트 백로그

숫자는 우선순위가 아니라 **의존성 웨이브**다. 같은 웨이브의 항목은 병렬 진행할 수 있지만,
다음 웨이브로 넘어갈 때 해당 게이트를 통과해야 한다.

### Wave 1 — 세 축의 기반

| 순서 | 스토리 | 결과 |
|---|---|---|
| 1.1 | [r08a](../../2_requirements/story/r08a-file-index-sync.md) | 파일 SoT 파서·SQLite 인덱스·무손실 전체 재빌드 |
| 1.2 | [r01a](../../2_requirements/story/r01a-issue-create-read.md) | 이슈 생성·조회와 uid/표시 키 발급 |
| 1.3 | [r12a](../../2_requirements/story/r12a-admin-bootstrap-login.md) | admin 부트스트랩·로컬 로그인 |

**Gate 1** — 인증된 admin이 이슈를 만들고, 인덱스를 삭제한 뒤 재기동해 같은 이슈를 조회한다.

### Wave 2 — 안전한 쓰기와 주체

| 순서 | 스토리 | 선행 | 결과 |
|---|---|---|---|
| 2.1 | [r08b](../../2_requirements/story/r08b-external-change-reconcile.md) | r08a | 외부 파일 변경 조정과 자기 쓰기 되울림 억제 |
| 2.2 | [r09](../../2_requirements/story/r09-atomic-write-outbox-recovery.md) | r08a | 원자적 파일 저장·outbox 재생·단일 writer |
| 2.3 | [r10](../../2_requirements/story/r10-etag-optimistic-concurrency.md) | r08a | 강한 ETag·`If-Match`·412 |
| 2.4 | [r01b](../../2_requirements/story/r01b-issue-update-delete.md) | r01a | 이슈 수정·상태 전이·삭제 |
| 2.5 | [r12b](../../2_requirements/story/r12b-role-authorization.md) | r12a | admin/member/agent 역할 인가 |
| 2.6 | [r14a](../../2_requirements/story/r14a-event-recording.md) | r12a | actor가 있는 이벤트 기록 |

**Gate 2** — 권한 있는 수정은 파일·인덱스·이벤트에 한 번만 반영되고, stale ETag·권한 없는 요청은
각각 412·403으로 거부된다. WriteTxn의 모든 단계에서 강제 종료 후 재기동 테스트가 통과한다.

### Wave 3 — 대량 조정과 백로그 도메인

| 순서 | 스토리 | 선행 | 결과 |
|---|---|---|---|
| 3.1 | [r08c](../../2_requirements/story/r08c-bulk-reconcile-tombstone.md) | r08a, r08b | git 대량 변경·삭제·rename 조정 |
| 3.2 | [r02a](../../2_requirements/story/r02a-issue-hierarchy.md) | r01a, r01b | 이슈 계층과 부모 삭제 전략 |
| 3.3 | [r02b](../../2_requirements/story/r02b-issue-links.md) | r01a, r01b | 관계 링크와 `claimable` 파생 |
| 3.4 | [r03](../../2_requirements/story/r03-backlog-rank-lexorank.md) | r01a, r01b | 결정적 백로그 정렬·재균형 |
| 3.5 | [r14b](../../2_requirements/story/r14b-issue-activity-timeline.md) | r14a | 이슈별 활동 타임라인·주체 표시 |

**Gate 3** — 외부 편집·checkout·rename 뒤 계층, 링크, 순서, 활동 이력이 새로고침 없이 수렴하고
동일 fixture를 반복 조정해도 결과가 바뀌지 않는다.

### Wave 4 — 검증과 조회

| 순서 | 스토리 | 선행 | 결과 |
|---|---|---|---|
| 4.1 | [r11a](../../2_requirements/story/r11a-integrity-validation-quarantine.md) | r08a, r08c | 구문·도메인 검증과 INVALID 격리 |
| 4.2 | [r04a](../../2_requirements/story/r04a-issue-filter.md) | r01a, r02b, r03 | 구조화 필터와 안정적 정렬 |

**Gate 4** — 깨진 파일 하나가 정상 이슈의 목록·필터·집계를 멈추지 않고, 정상 결과에서는 격리된
엔티티가 제외된다.

### Wave 5 — 운영 완결

| 순서 | 스토리 | 선행 | 결과 |
|---|---|---|---|
| 5.1 | [r11b](../../2_requirements/story/r11b-integrity-error-banner.md) | r11a | 오류 배너·격리 항목·복구 안내 |
| 5.2 | [r21](../../2_requirements/story/r21-manual-reindex-full-verify.md) | r08a, r11a | 수동 재인덱스·전체 검증 |
| 5.3 | [r26](../../2_requirements/story/r26-auto-rekey-former-keys.md) | r08c, r11a | 결정적 재키잉·옛 키 alias |
| 5.4 | [r04b](../../2_requirements/story/r04b-fulltext-search.md) | r01a, r04a | FTS5 전문 검색·옛 키 검색 |

**Gate 5** — 5,000개 이슈를 포함한 AC2 fixture로 전체 재빌드·전체 검증·검색 성능을 확인하고,
중복 표시 키 fixture가 반복 실행과 실행 노드에 관계없이 같은 키로 수렴한다.

## 핵심 경로와 병렬 작업선

- 저장 핵심 경로:
  `r08a → r08b → r08c → r11a → r21/r26`
- 백로그 핵심 경로:
  `r01a → r01b → r02b/r03 → r04a → r04b`
- 인증·이력 경로:
  `r12a → r12b`와 `r12a → r14a → r14b`
- 저장, 백로그, 인증의 세 작업선은 Wave 1부터 병렬 진행하고 각 Gate에서 통합한다.

가장 긴 두 경로의 마지막인 `r26`과 `r04b`가 Sprint 01 완료 시점을 결정한다. UI 성격의 `r11b`를
먼저 끝냈더라도 코어 복구·검색 경로가 끝나지 않으면 스프린트 목표는 달성한 것으로 보지 않는다.

## 완료 절단선

수용량상 20건을 한 타임박스에 담을 수 없을 때는 다음처럼 자른다.

- **Sprint 01 필수 코어**: Wave 1~4의 16건. 안전한 생성·수정·외부 조정·격리·필터까지 제공한다.
- **다음 스프린트 이월 묶음**: Wave 5의 4건. 운영 UI, 수동 복구, 재키잉, 전문 검색을 함께 넘긴다.

Wave 중간에서 임의로 자르지 않는다. 특히 `r08c` 없이 `r11a`, `r04a` 없이 `r04b`를 완료로
잡으면 스토리의 통합 인수조건을 검증할 수 없다.

## 스프린트 완료 정의

- [ ] 20개 스토리의 인수 조건과 연결된 자동 테스트가 모두 통과한다.
- [ ] PRD AC1~AC3, AC8~AC11, AC13, AC15, AC25 중 M1 관련 시나리오가 통합 테스트로 통과한다.
- [ ] 파일 SoT만 남긴 상태에서 인덱스를 재생성해 정규화 API 응답이 동일하다.
- [ ] WriteTxn 각 stage 전후 강제 종료, 외부 편집 경합, watcher overflow를 포함한 복구 테스트가 통과한다.
- [ ] 5,000개 이슈 fixture에서 검색 p95 ≤300ms, 전체 재빌드 ≤10s 목표를 측정하고 결과를 기록한다.
- [ ] INVALID·중복 키·dangling 참조 fixture가 정상 엔티티 조회를 방해하지 않는다.
- [ ] 문서의 열린 질문 중 구현에서 결정된 내용이 PRD·설계·스토리에 역반영되어 있다.
- [ ] 미완료 항목은 이유와 다음 조치가 기록되어 있고 “거의 완료” 상태로 닫지 않는다.

## 스프린트 범위 밖

- M0의 orphan 브랜치/worktree 부트스트랩 구현
- M2의 스프린트 CRUD·계획·칸반 보드·git 상태 배지
- M3 이후의 PAT, claim/lease, AgentRun, 코멘트, AI 제안
- 번다운 스냅샷 파일 형식 확정과 구현

## 주요 위험

| 위험 | 대응 |
|---|---|
| 20건에 추정치가 없어 타임박스 초과 | 계획 회의에서 추정 후 완료 절단선 적용 |
| 저장 계층이 모든 경로의 병목 | r08a 인터페이스와 fixture를 먼저 고정하고 세 작업선을 병렬화 |
| 파일·SQLite·이벤트의 비원자성 | stage별 fault injection을 Sprint 01의 완료 조건으로 유지 |
| 외부 편집과 서버 쓰기 경합 | ETag와 outbox CAS를 한 통합 시나리오로 검증 |
| 미정 항목이 구현 중 계약을 흔듦 | 착수 조건에서 계약 영향 항목만 먼저 닫고 나머지는 결정 로그로 관리 |
