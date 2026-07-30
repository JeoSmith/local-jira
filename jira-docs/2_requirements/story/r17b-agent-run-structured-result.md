---
title: "AgentRun 종료 시 구조화 결과 제출"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-30
related_prd: ../prd/backlog-sprint.md
requirement: R17
milestone: M3
priority: P0
---

# AgentRun 종료 시 구조화 결과 제출

> R17 분할 두 번째 스토리. `r17a`의 생명주기 위에서 **종료 시점의 산출물**만 다룬다. 자유 서술 한 덩어리가 아니라 다섯 개 필드로 강제하는 것이 요점이므로, 스키마 검증과 화면 표기가 독립적으로 검증된다.

## 사용자 스토리 (User Story)

> **As a** 에이전트의 결과를 리뷰해야 하는 개발자,
> **I want** 에이전트가 작업을 끝낼 때 결과 요약·검증 방법과 통과 여부·변경 파일·커밋 해시·잔여 위험을 정해진 필드로 제출하기를,
> **so that** "다 했습니다" 한 줄을 믿는 대신 무엇을 어떻게 검증했고 무엇이 남았는지를 일정한 형식으로 확인할 수 있다.

## 인수 조건 (Acceptance Criteria)

- [x] Given run 종료 요청, When 페이로드를 확인하면, Then **결과 요약 · 검증 방법과 통과 여부 · 변경 파일 · 커밋 해시 · 잔여 위험** 다섯 항목이 구조화 필드로 포함된다(§6.2).
- [x] Given 위 항목 중 하나라도 누락한 종료 요청, When 처리하면, Then **400**으로 거부되고 run은 종료되지 않는다.
- [x] Given 결과 전체를 자유 텍스트 한 필드로 보낸 종료 요청, When 처리하면, Then **400**이다. 결과는 `result` 하위의 개별 필드로 저장된다(§5.1 AgentRun `result`).
- [x] Given 검증을 수행하지 않은 run, When 종료하면, Then "검증 방법" 필드에 그 사실이 명시적으로 담기며 필드 자체를 생략할 수는 없다.
- [x] Given 종료된 run, When `.localjira/runs/<PROJECT>/<YYYY-MM>/<ULID>.json`을 확인하면, Then 제출된 결과가 파일에 저장되어 있고 `.local/index.sqlite` 삭제·재기동 후에도 동일하게 조회된다(§5.3, AC2).
- [x] Given `run:write` scope가 없는 PAT, When 결과 제출을 시도하면, Then **403**이다(§6.4).
- [x] Given 사람이 이미 강제 해제·취소한 run, When 그 run이 결과를 제출하면, Then **409**이며 결과가 저장되지 않는다(§6.1, AC20).
- [x] Given 결과 제출과 함께 `IN_REVIEW`로 전이하는 에이전트, When 본인 claim이 유효하면, Then 전이가 성공한다(S3). 본인 claim이 없으면 **403**이다(§6.1, AC19).
- [x] Given 이슈 상세 화면, When 연결된 AgentRun을 펼치면, Then 다섯 항목이 각각 구분되어 표시되고 실행 주체·지시 주체가 함께 보인다(§8, §6.2).
- [x] Given `STALE`로 끝나 결과를 제출하지 못한 run, When 화면을 보면, Then 결과 미제출 상태가 정상 종료와 **구분되어** 표시된다(S5, AC20).
- [x] Given 결과 제출 이벤트, When 이벤트를 확인하면, Then `actor_kind=agent`·`run_id`·`initiated_by`와 함께 기록된다(AC6, N7 — run은 감사 범위).
- [x] Given 같은 `Idempotency-Key`로 종료 요청을 재전송, When 처리하면, Then 최초 응답이 반환되고 결과가 중복 기록되지 않는다(§5.4, AC18).

> 결정됨(S3-D6): 검증 결과는 불리언이 아니라 `passed`·`failed`·`skipped` 열거다. 불리언에는
> "확인하지 않았다"가 들어갈 자리가 없는데 AC4가 그 사실을 명시하라고 요구한다. `skipped`일
> 때도 `method`는 필수다 — 검증하지 않은 이유를 적는 자리다.
> 결정됨(S3-D6): 커밋 해시는 기록만 하고 저장소에서 존재를 검증하지 않는다. 커밋 연결
> 자동화는 R23(M5)이다.
> 결정됨(S3-D6): 제출된 결과는 불변이다. 나중에 고칠 수 있으면 "그때 그 실행이 무엇을 했다고
> 보고했는가"의 기록이 증거로서 쓸모가 없다. 정정은 이슈 코멘트로 남긴다.
>
> 구현 메모: `FAILED`도 다섯 필드를 요구한다. "실패했습니다" 한 줄은 실패판 "다 했습니다"이고,
> 실패를 말할 만큼 살아 있는 run은 무엇을 시도했는지도 말할 수 있다. 결과 없이 끝나는 경우는
> 밖에서 취소된 run(강제 해제·취소)뿐이며, 그것이 AC10이 구분하라는 상태다.

## 범위 밖 (Out of Scope)

- run 시작·heartbeat·`STALE` 판정·이슈 연결 — `r17a-agent-run-lifecycle.md`.
- 커밋 트레일러 스캔으로 `commits[]`를 자동 채우기 — R23(P2/M5).
- 결과에 대한 사람의 승인/반려 워크플로 — PRD는 `IN_REVIEW` 상태만 정의하고 별도 승인 절차를 두지 않는다(§5.2).
- 결과 텍스트의 LLM 요약·후처리 — Q10 미결이며 M5 범위다.
- 코드 리뷰·CI 연동.

## 선행 의존 (Depends on)

- `r17a-agent-run-lifecycle.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §4 S3·S5, §5.1(AgentRun `result`), §5.3(runs 파일), §6.1, §6.2, §6.4, §7 R17, §8, §9 N7, §12 M3
- 검증: PRD AC20, 보조 AC2·AC6·AC18·AC19
