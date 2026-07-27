---
title: "AgentRun 생명주기 — 시작·heartbeat·종료와 이슈 연결"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R17
milestone: M3
priority: P0
---

# AgentRun 생명주기 — 시작·heartbeat·종료와 이슈 연결

> R17 분할 첫 번째 스토리. 본 스토리는 run의 **생명주기와 식별**(무엇을 등록하고, 어떤 이슈·세션·브랜치에 묶이며, 언제 `STALE`이 되는가)을 다루고, `r17b`가 종료 시 제출하는 **구조화 결과의 내용과 형식**을 다룬다. 앞은 상태 기계, 뒤는 페이로드 스키마라 검증 방법이 다르다.

## 사용자 스토리 (User Story)

> **As a** 에이전트 작업을 감독하는 개발자,
> **I want** 에이전트의 각 실행이 세션·브랜치·지시자와 함께 이슈에 묶여 기록되기를,
> **so that** "이 이슈를 어떤 세션이 어느 브랜치에서 어디까지 했나"를 커밋 메시지를 뒤지지 않고 보드에서 바로 볼 수 있다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 에이전트가 작업을 시작, When `POST /runs`를 호출하면, Then `session_id`·`agent_id`·`initiated_by`(지시한 사람 계정)·`branch`·대상 `issue`가 등록되고 `run_id`(ULID)가 반환된다(§6.2, §5.1 AgentRun).
- [ ] Given 위 필드 중 하나라도 누락된 요청, When 처리하면, Then **400**으로 거부된다(§6.2는 네 항목을 모두 등록 대상으로 규정한다).
- [ ] Given 생성된 run, When 파일을 확인하면, Then `.localjira/runs/<PROJECT>/<YYYY-MM>/<ULID>.json`에 파일로 남는다(§5.3). run은 파일 SoT이며 claim/lease와 달리 런타임 상태가 아니다.
- [ ] Given run fixture가 포함된 데이터셋, When `.local/index.sqlite`를 삭제하고 재기동하면, Then run 조회 응답이 삭제 전후 정규화 비교로 동일하다(AC2, G4).
- [ ] Given `run:write` scope가 없는 PAT, When `POST /runs`를 호출하면, Then **403**이다(§6.4, AC16).
- [ ] Given 같은 `Idempotency-Key`로 `POST /runs`를 재전송, When 처리하면, Then 최초 응답이 그대로 반환되고 run 파일이 두 개 생기지 않는다(§5.4, AC18 — 상세는 `r15-idempotency-key.md`).
- [ ] Given 진행 중인 run, When 에이전트가 heartbeat를 보내면, Then `last_heartbeat_at`이 갱신된다(§5.1).
- [ ] Given heartbeat가 **3회 연속(=3분) 누락**된 run, When 상태를 조회하면, Then `state`가 **`STALE`** 이다(D7, AC20).
- [ ] Given `STALE` run, When 사람이 회수·재할당하면, Then 이슈가 다시 claim 가능해진다(S5 — 회수 판정 자체는 `r16b`).
- [ ] Given 정상 종료된 run, When 레코드를 확인하면, Then `ended_at`이 기록되고 `state`가 종료 상태로 전이하며, 이후 heartbeat는 반영되지 않는다.
- [ ] Given 사람이 취소한 run, When 그 run이 이후 쓰기를 시도하면, Then **409**다(§6.1, AC20 — 상세는 `r16b`).
- [ ] Given 사람 A가 지시하고 에이전트 B가 수행한 run, When 이슈 타임라인과 보드 카드를 보면, Then **실행 주체(`agent_id`)와 지시 주체(`initiated_by`)가 모두** 표시된다(§6.2 대리 실행, AC6).
- [ ] Given 같은 run이 남긴 도메인 변경 이벤트, When 이벤트를 확인하면, Then `actor_kind=agent`와 함께 `run_id`·`initiated_by`가 기록된다(AC6, §5.1 Event).
- [ ] Given 이슈 상세 화면, When 열면, Then 그 이슈에 연결된 AgentRun 목록이 표시된다(§8 이슈 상세).
- [ ] Given ACTIVE 스프린트 보드, When 카드를 보면, Then claim 소유자와 run 상태 배지가 카드에 노출된다(§8 보드).
- [ ] Given 에이전트 변경이 섞인 타임라인, When 배지를 보면, Then 에이전트 변경이 사람 변경처럼 보이지 않는다(§8 주체 표기 규칙).

> ⚠ 미정: `state`의 전체 열거값 — PRD는 `STALE`만 명시하고 정상 종료·실패·취소를 구분하는 값 이름을 규정하지 않는다.
> ⚠ 미정: heartbeat 엔드포인트가 **run 단위인지 claim 단위인지** — §6.1은 claim lease를, §6.2/§5.1은 run의 `last_heartbeat_at`을 말하며 API 분리 여부를 규정하지 않는다.
> ⚠ 미정: 한 이슈에 **동시에 여러 run**을 허용하는지 — claim은 1개로 제한되지만 run 자체의 동시성 제약은 PRD에 없다.

## 범위 밖 (Out of Scope)

- 종료 시 제출하는 구조화 결과의 필드·검증 — `r17b-agent-run-structured-result.md`.
- claim 취득·lease 만료·강제 해제 판정 — R16.
- `commits[]`의 **자동** 채움(커밋 트레일러 `Issue: LJ-12` 스캔) — R23(P2/M5).
- 멱등성 저장소·24시간 보존 구현 — `r15-idempotency-key.md`.
- PAT scope 판정 구현 — `r13b-pat-scope-enforcement.md`.
- 에이전트 자동 갱신 비중 등 지표 집계 — §11 성공 지표.

## 선행 의존 (Depends on)

- `r16a-issue-claim.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §4 S3·S5, §5.1(AgentRun·Event), §5.3(runs 디렉터리), §5.4(멱등성), §6.1, §6.2, §6.4, §7 R17, §8, §12 M3, §13 D7
- 검증: PRD AC20, 보조 AC2·AC6·AC16·AC18
