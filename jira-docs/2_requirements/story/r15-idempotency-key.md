---
title: "생성·append API 멱등성 (Idempotency-Key)"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R15
milestone: M3
priority: P0
---

# 생성·append API 멱등성 (Idempotency-Key)

## 사용자 스토리 (User Story)

> **As a** 네트워크 오류·타임아웃 후 요청을 재시도하는 에이전트,
> **I want** 같은 `Idempotency-Key`로 다시 보낸 생성 요청이 최초 결과를 그대로 돌려주기를,
> **so that** 같은 이슈·코멘트·run이 두 번 만들어지거나 타임라인에 중복 이벤트가 쌓이지 않는다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 생성·append API(`POST /issues`, `POST .../comments`, `POST /runs`), When 요청에 `Idempotency-Key` 헤더를 실으면, Then 서버가 이를 수용한다(§5.4).
- [ ] Given `Idempotency-Key` 없이 보낸 요청, When 처리하면, Then 평소대로 처리된다(키는 선택 사항이며, 없으면 재시도 보호도 없다).
- [ ] Given 어떤 actor가 키 `K`로 이슈를 생성해 **201**과 `LJ-12`를 받은 상태, When 같은 actor가 같은 키 `K`로 동일 요청을 재전송하면, Then **최초 응답(상태코드·본문·`ETag` 포함)이 그대로 반환**되고 새 이슈 파일이 생기지 않는다(AC18).
- [ ] Given 위 재전송 후, When 이벤트를 확인하면, Then 이슈 생성 이벤트는 **1건뿐**이며 중복 이벤트가 없다(AC18, N7).
- [ ] Given 같은 이슈에 코멘트를 키 `K2`로 작성한 뒤 재전송, When 코멘트 파일 목록을 확인하면, Then `comments/<key>/` 아래 코멘트 파일이 1개이며 `git status`에도 1건만 잡힌다.
- [ ] Given actor A가 키 `K`를 사용한 상태, When **다른 actor B**가 같은 문자열 `K`로 요청하면, Then 별개의 요청으로 처리되어 정상 생성된다(키 범위는 `(actor_id, key)`).
- [ ] Given 키 `K`로 성공한 요청, When 저장소를 확인하면, Then `(actor_id, key)` → 최초 응답이 **`.local/outbox.sqlite`** 에 보존된다(§5.3, §5.4).
- [ ] Given 키 `K`로 성공한 뒤 **서버를 재기동**, When 같은 actor가 같은 키로 재전송하면, Then 여전히 최초 결과가 반환된다(재기동 후에도 유효).
- [ ] Given 키 `K`의 기록이 **24시간을 경과**한 상태, When 같은 actor가 같은 키로 재전송하면, Then **새 요청으로 처리**되어 새 엔티티가 생성된다(만료 키는 보호 대상이 아니다).
- [ ] Given 요청 처리 중 서버가 죽어 outbox에 미완료 레코드가 남은 상태, When 재기동 후 같은 키로 재전송하면, Then outbox 재생 결과와 합쳐져 **엔티티가 두 번 생기지 않는다**(§5.5, AC15).
- [ ] Given `.local/`을 삭제한 기기, When 서버를 기동하면, Then 멱등성 기록도 함께 사라지며 이는 정상 동작이다 — `.local/`은 재생성 가능한 기기 고유 영역이자 백업 비대상이다(§5.3, D5).

> ⚠ 미정: 같은 `(actor_id, key)`로 **페이로드가 다른** 요청이 왔을 때의 처리 — 최초 응답을 그대로 돌려줄지, 충돌로 거부할지(및 그 상태코드) PRD가 규정하지 않는다.
> ⚠ 미정: 최초 요청이 **아직 처리 중일 때** 같은 키의 동시 요청이 도착한 경우의 처리(대기 vs 즉시 거부) — PRD 미규정.
> ⚠ 미정: `Idempotency-Key`의 형식·최대 길이 제약 — PRD 미규정.

## 범위 밖 (Out of Scope)

- `POST /issues/{id}/claim` — 선점은 생성·append가 아니며 중복 시도는 멱등이 아니라 **409**로 거부된다(§6.1, R16).
- 수정 API(`PUT`/`PATCH`)의 중복 방지 — 여기서는 강한 ETag + `If-Match` + 412가 담당한다(R10, AC8).
- outbox 저널 자체의 크래시 복구·재생 구현 — R9.
- 클라이언트 측 재시도 정책(백오프·최대 횟수) — PRD 미규정.

## 선행 의존 (Depends on)

- `r14a-event-recording.md` (중복 이벤트 미생성 판정에 이벤트 기록이 선행되어야 한다)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.3(`.local/outbox.sqlite`), §5.4(멱등성), §5.5(outbox 재생), §7 R15, §12 M3, §13 D5
- 검증: PRD AC18, 보조 AC15
