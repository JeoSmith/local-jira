---
title: "Sprint 01 — M1 신뢰 가능한 코어"
status: ready
milestone: M1
scope_count: 16
scope_points: 76
carried_over: 4
created: 2026-07-27
updated: 2026-07-28
---

# Sprint 01 — M1 신뢰 가능한 코어

## 진행 현황 (2026-07-28)

| Wave | 스토리 | 점수 | 상태 |
|---|---|---:|---|
| **1** | r08a · r01a · r12a | 14 | ✅ **완료 — Gate 1 통과** |
| 2 | r08b · r09 · r10 · r01b · r12b · r14a | 31 | ⬜ |
| 3 | r08c · r02a · r02b · r03 · r14b | 20 | ⬜ |
| 4 | r11a · r04a | 11 | ⬜ |

**14 / 76점 (18%)** · 테스트 167건 통과 · CI는 ubuntu·macOS 양쪽 초록.

Wave 1에서 나온 것 중 스토리에 없던 작업 둘:
- **HTTP 서버** — r01a·r12a의 인수조건이 전제하는데 이를 다루는 스토리가 없었다(분해 누락).
  r12a에 함께 세웠다. `POST /auth/login`·`/issues`·`GET /issues/{key}` 등.
- **CLI 조회·생성 명령** — 보드를 눈으로 확인할 수단이 M2까지 없다는 문제 때문에 앞당겼다.
  `index status`·`issue list|show|create`·`admin create`·`user list`·`serve`.

## 스프린트 목표

인증된 사용자가 이슈를 생성·조회·수정·검색할 수 있고, 프로세스 크래시나 외부 파일 편집,
git 대량 변경, SQLite 인덱스 유실 뒤에도 파일 SoT에서 일관된 상태로 복구되는 최소 코어를 완성한다.

스프린트 종료 시 다음 사용자 경로가 하나로 연결되어야 한다.

> admin 부트스트랩·로그인 → 이슈 생성 → 수정·정렬·관계 설정 → 필터·검색 →
> 이벤트·활동 조회 → 외부 편집 및 재기동 후 동일 결과 확인

## 기간·수용량 (2026-07-27 합의)

| 항목 | 확정 |
|---|---|
| 수행 주체 | **사람 + AI 에이전트** (M0와 동일한 방식) |
| 기간 | **고정 타임박스 없음.** 진도는 Gate 통과로 끊고, 기간은 필요할 때 조정한다 |
| 커밋 범위 | **Wave 1~4 = 16건 / 76점** |
| 이월 | Wave 5 = 4건 / 14점 (운영 UI·수동 복구·재키잉·전문 검색) |
| 스트레치 | 없음 |

### 타임박스를 두지 않는 이유와 그 대가

구현을 AI가 맡는 방식에서는 달력 기간이 진척을 대변하지 않는다. M0가 그 예다 — 문서·설계·구현·
CI·Linux 결함 수정까지 한 세션에 끝났고, 이를 "며칠짜리"로 환산하는 것은 의미가 없었다.

**대신 잃는 것도 분명하다.** 타임박스가 없으면 번다운도 벨로시티도 성립하지 않고, "언제 끝나는가"에
답할 수단이 사라진다. 그래서 다음 두 가지로 대체한다.

1. **Gate가 유일한 진도 단위다.** Wave의 모든 스토리가 끝나고 해당 Gate 시나리오가 통과해야 다음
   Wave로 넘어간다. "거의 다 됐다"는 상태를 인정하지 않는다.
2. **점수는 예측이 아니라 순서·위험 신호로만 쓴다.** 아래 추정은 무엇이 어렵고 무엇이 병목인지를
   말할 뿐, 완료 시점을 약속하지 않는다.

### 유일한 실측 기준점 — M0

| | 값 |
|---|---|
| 구현 | `src` 2,912줄 (14파일) |
| 테스트 | `test` 1,723줄 (7파일, 77 케이스) |
| 실질 커밋 | 4개 (doctor → 상태·계획 → init/repair 조립 → fault injection·CI) |
| 아래 척도 환산 | **약 20~25점 상당** (잠금 = r09급, scaffold·입력검증 = r01a급) |

벨로시티 이력은 이것 하나뿐이다. Sprint 01이 두 번째 데이터 포인트가 되며, **이 스프린트가 끝나야
비로소 "이 방식의 처리량"을 말할 수 있다.**

## 추정 (확정)

척도는 스토리 포인트(D8)다. **복잡도와 불확실성**을 재며 시간으로 환산하지 않는다.
아래 20건 중 **Wave 1~4의 16건(76점)이 이번 커밋 범위**이고, Wave 5의 4건(14점)은 이월이다.

| 스토리 | 점수 | 근거 |
|---|---:|---|
| r09 원자적 저장·outbox 복구 | **13** | fault injection 6지점 + 재생 CAS 3분기. 이 스프린트에서 가장 어렵고 다른 전부의 토대 |
| r08a 파일↔인덱스 동기화 | **8** | 파서 + 스키마 전체 + 재빌드 동치. 범위가 넓다 |
| r08c 대량 조정·tombstone | **8** | git 조작 감지, 유예 영속화, 1,000파일 성능까지 |
| r11a 무결성 검증·격리 | **8** | Stage A/B 분리 + 격리 사유 10종 + 자동 해제 |
| r26 자동 재키잉 | **5** | 결정성이 핵심. property test 필요 |
| r03 백로그 정렬 | **5** | LexoRank 생성·재균형 + 결정성 property test (S1-D13) |
| r10 ETag 동시성 | **5** | JCS 직렬화와 428/412 계약. 규칙은 명확하나 정확도 요구가 높다 |
| r08b 외부 변경 조정 | **5** | 워처 + debounce + 되울림 억제 + SSE 연동 |
| r04b 전문 검색 | **5** | FTS5 + 토크나이저 실측(OQ1) + alias 색인 |
| r01a 이슈 생성·조회 | **3** | 저장 계층이 끝나면 얇다 |
| r01b 이슈 수정·전이·삭제 | **3** | 전이표 + 삭제 strategy |
| r02a 계층 | **3** | 규칙이 명시적이라 검증 위주 |
| r04a 구조화 필터 | **3** | 인덱스가 준비되면 쿼리 조립 |
| r12a admin 부트스트랩·로그인 | **3** | argon2id + 세션. 표준 경로 |
| r14a 이벤트 기록 | **3** | 범위(N7)가 넓지만 형태는 단순 |
| r11b 오류 배너 | **2** | UI. r11a에 종속 |
| r21 수동 재인덱스·검증 | **2** | 세대 교체는 r08a에서 이미 만든다 |
| r02b 관계 링크 | **2** | 단방향 저장 결정(S1-D4)으로 단순해짐 |
| r12b 역할 인가 | **2** | 미들웨어 한 겹 |
| r14b 활동 타임라인 | **2** | 조회 + 배지 |
| **합계** | **90** | |

> **점수보다 배분을 보라** — 저장 코어 9건(r08a·b·c, r09, r10, r11a·b, r21, r26)이 **56점으로 전체의 62%**다.
> 나머지 11건을 다 합쳐야 34점이다. 이 스프린트의 실질적 내용은 백로그 기능이 아니라 저장 계층이며,
> 상위 4건(r09 13 · r08a 8 · r08c 8 · r11a 8)만으로 37점(41%)이다.
>
> 웨이브별로는 Wave1 14 · Wave2 31 · Wave3 20 · Wave4 11 = **76점이 이번 범위**, Wave5 14점은 이월이다.
> **Wave 2가 31점으로 가장 무겁다** — `r09`(13)가 여기 있고, 저장·백로그·인증 세 작업선이
> 동시에 걸쳐 있어 통합 지점이기도 하다. 이 스프린트가 막힌다면 십중팔구 Wave 2다.

## 착수 조건

- [x] **M0 초기화 명령 구현 완료** — `localjira init` / `repair-worktree` / `doctor`가
      `localjira/data` orphan 브랜치·worktree를 만든다(배치 결정은
      [ADR-006](../../0_decisions/adr-006-shared-board-data-branch.md), 설계는
      [M0 부트스트랩](../../3_designs/detailed/m0-bootstrap.design.md)).
      fault injection(설계 §9.4)은 7개 mutation 지점 전부에서 통과하고,
      Linux advisory lock 검증(OQ-M0-2)도 **해소됐다** — CI가 `ubuntu-latest`·`macos-latest`
      양쪽에서 77/77 통과. **M0 잔여 없음.**
- [x] **저장 계층 기준선 확정** — [저장 계층 상세 설계](../../3_designs/detailed/storage-layer.design.md) v3와
      [SQLite 스키마](../../3_designs/database/index-schema.md) v3. codex 교차검증 2회(30건 + 9건) 반영 완료.
- [x] **계약 영향 미정 항목 결정** — [착수 결정 로그](sprint-01-decisions.md) S1-D1~S1-D13.
      미정 24건 중 13건 확정, 5건은 설계에서 이미 닫힘, 6건은 비파괴적이라 연기.
- [x] **테스트 fixture·fault injection 방법 확정** —
      [M1 fixture와 fault injection](../../5_tests/test-plan/m1-fixtures-and-fault-injection.md).
- [x] **스토리 추정 합의** — 2026-07-27 확정. 척도·수행 주체·커밋 범위는 §기간·수용량 참조.

## 스프린트 백로그

숫자는 우선순위가 아니라 **의존성 웨이브**다. 같은 웨이브의 항목은 병렬 진행할 수 있지만,
다음 웨이브로 넘어갈 때 해당 게이트를 통과해야 한다.

### Wave 1 — 세 축의 기반 ✅

| 순서 | 스토리 | 결과 | 상태 |
|---|---|---|---|
| 1.1 | [r08a](../../2_requirements/story/r08a-file-index-sync.md) | 파일 SoT 파서·SQLite 인덱스·무손실 전체 재빌드 | ✅ |
| 1.2 | [r01a](../../2_requirements/story/r01a-issue-create-read.md) | 이슈 생성·조회와 uid/표시 키 발급 | ✅ |
| 1.3 | [r12a](../../2_requirements/story/r12a-admin-bootstrap-login.md) | admin 부트스트랩·로컬 로그인 | ✅ |

**Gate 1 통과** — 인증된 admin이 이슈를 만들고, 인덱스를 삭제한 뒤 재기동해 같은 이슈를 조회한다.
`test/gate1.integration.test.ts`가 이 경로를 하나로 꿴다. 세 스토리가 각각 통과해도
그 사이 이음매는 별개라서, 게이트는 통합 시나리오 1건으로만 닫는다.

측정된 것:
- 재빌드 후 **ETag가 바이트 단위로 동일** — 파생 인덱스가 표현을 바꾸지 않는다
- 재빌드가 **도메인 파일을 한 바이트도 건드리지 않음**(`git status` 불변)
- 워킹트리에 남는 것은 `users.yaml`과 이슈 파일 1개뿐 — 인덱스·자격증명은 `.local/`
- 5,000건 전체 재빌드 **1.2s**(예산 10s), 무변경 재기동 시 hash **0회**

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

### Wave 5 — 운영 완결 *(Sprint 01 범위 밖 — Sprint 02 이월)*

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

이번 범위에서 가장 긴 경로는 `r08a → r08b → r08c → r11a`이고, **Gate 4 통과가 Sprint 01의 끝**이다.
`r26`·`r04b`는 이월됐으므로 완료 판단에 넣지 않는다.

저장 작업선이 세 작업선 전부의 선행이라 **`r08a`가 늦어지면 전체가 늦어진다.** 반대로 백로그·인증
작업선은 `r08a`만 서면 서로를 기다리지 않는다.

## 완료 절단선 (적용 완료)

절단은 **이미 반영됐다.** Wave 1~4의 16건이 Sprint 01이고, Wave 5의 4건은 Sprint 02로 넘긴다.

- **Sprint 01 (16건 76점)**: 안전한 생성·수정·외부 조정·격리·필터까지. 인덱스를 지워도 파일에서
  동일하게 복구되고, 크래시·git 대량 변경 뒤에도 수렴하는 코어가 선다.
- **Sprint 02 이월 (4건 14점)**: `r11b` 오류 배너 · `r21` 수동 재인덱스 · `r26` 재키잉 ·
  `r04b` 전문 검색. 운영 편의와 검색이라 코어 없이는 검증할 수도 없다.

**Wave 중간에서 더 자르지 않는다.** `r08c` 없이 `r11a`를, `r04a` 없이 `r04b`를 완료로 잡으면
스토리의 통합 인수조건을 검증할 수 없다. 범위를 더 줄여야 하면 Wave 4를 통째로 넘기는 식으로
Gate 단위로 자른다.

> 이월 4건이 빠지면서 **AC25(재키잉)와 검색 성능 측정이 Sprint 01 범위 밖**이 된다.
> 저장 계층 설계 OQ1(FTS 토크나이저)·OQ2(성능 예산 실측)도 함께 Sprint 02로 밀린다.

## 스프린트 완료 정의

- [ ] **16개** 스토리(Wave 1~4)의 인수 조건과 연결된 자동 테스트가 모두 통과한다.
- [ ] PRD AC1~AC3, AC8~AC12, AC15 중 이번 범위 시나리오가 통합 테스트로 통과한다.
      *(AC25 재키잉과 AC13 검색은 이월 스토리에 걸려 있어 Sprint 02로 넘어간다.)*
- [ ] 파일 SoT만 남긴 상태에서 인덱스를 재생성해 정규화 API 응답이 동일하다.
- [ ] WriteTxn 각 stage 전후 강제 종료, 외부 편집 경합, watcher overflow를 포함한 복구 테스트가 통과한다.
- [ ] 5,000개 이슈 fixture에서 **전체 재빌드 ≤10s**를 측정하고 결과를 기록한다.
      *(검색 p95는 `r04b`가 이월되어 Sprint 02에서 측정한다.)*
- [ ] INVALID·중복 키·dangling 참조 fixture가 정상 엔티티 조회를 방해하지 않는다.
- [ ] 문서의 열린 질문 중 구현에서 결정된 내용이 PRD·설계·스토리에 역반영되어 있다.
- [ ] 미완료 항목은 이유와 다음 조치가 기록되어 있고 “거의 완료” 상태로 닫지 않는다.

## 스프린트 범위 밖

- **Wave 5의 4건**(`r11b`·`r21`·`r26`·`r04b`) — Sprint 02 이월
- M0의 orphan 브랜치/worktree 부트스트랩 구현 (완료됨)
- M2의 스프린트 CRUD·계획·칸반 보드·git 상태 배지
- M3 이후의 PAT, claim/lease, AgentRun, 코멘트, AI 제안
- 번다운 스냅샷 파일 형식 확정과 구현

## 주요 위험

| 위험 | 대응 |
|---|---|
| 타임박스가 없어 스프린트가 무한정 늘어짐 | Gate 통과만 진도로 인정한다. Gate 하나가 오래 막히면 그 Wave를 잘라 다음 스프린트로 넘긴다 |
| 벨로시티 이력이 M0 하나뿐이라 76점의 체감을 모름 | Gate 1 통과 시점에 실제 소요를 기록해 두 번째 데이터 포인트로 삼는다 |
| 저장 계층이 모든 경로의 병목 | r08a 인터페이스와 fixture를 먼저 고정하고 세 작업선을 병렬화 |
| 파일·SQLite·이벤트의 비원자성 | stage별 fault injection을 Sprint 01의 완료 조건으로 유지 |
| 외부 편집과 서버 쓰기 경합 | ETag와 outbox CAS를 한 통합 시나리오로 검증 |
| 미정 항목이 구현 중 계약을 흔듦 | 착수 조건에서 계약 영향 항목만 먼저 닫고 나머지는 결정 로그로 관리 |
