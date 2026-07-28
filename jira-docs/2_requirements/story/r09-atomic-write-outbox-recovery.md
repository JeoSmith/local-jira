---
title: "원자적 파일 저장과 outbox 기반 크래시 복구"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R9
milestone: M1
priority: P0
---

# 원자적 파일 저장과 outbox 기반 크래시 복구

## 사용자 스토리 (User Story)

> **As a** 개발자(내부 기술 스토리 — 저장 코어 담당자),
> **I want** 어느 시점에 서버가 죽어도 이슈 파일이 항상 이전 버전 또는 새 버전 중 하나의 완전한 상태로 남고, 끊긴 쓰기가 재기동 시 스스로 마무리되기를,
> **so that** 반쯤 잘린 YAML이나 "파일은 바뀌었는데 이벤트는 없는" 상태를 사람이 손으로 수습하지 않아도 된다.

## 인수 조건 (Acceptance Criteria)

- [x] Given 이슈 수정 요청, When 파일을 교체하면, Then **대상과 같은 디렉터리**에 temp 파일 생성 → 내용 flush + `fsync` → `rename` → **부모 디렉터리 `fsync`** 순서로 수행된다. `/tmp` 등 다른 파일시스템을 경유하지 않는다(syscall 추적 또는 테스트 훅으로 검증).
- [x] Given 동일 파일에 대한 두 쓰기 요청이 동시에 도착, When 처리하면, Then 프로세스 내 mutex로 직렬화되어 둘 다 완전한 파일을 남기고 잃어버린 갱신이 없다(선행 요청 반영 후 후행은 R10의 412 또는 순차 적용).
- [x] Given 쓰기 파이프라인의 5개 지점 — ① outbox 레코드 기록 직후 ② `rename` 직전 ③ `rename` 직후 ④ 인덱스 upsert 직후 ⑤ 이벤트 append 직후 — 각각에 fault injection, When 프로세스를 강제 종료하고 재기동하면, Then 매 경우 이슈 파일이 **부분 YAML·잘린 frontmatter 없이** 이전 버전 또는 새 버전 중 하나의 완전한 상태다. *(AC15, N5)*
- [x] Given ② 지점(파일 미교체) 크래시, When 재기동 시 미완료 outbox를 재생하면, Then 파일·인덱스·이벤트가 모두 **새 버전으로 롤포워드**되어 수렴한다. outbox 레코드는 재생에 필요한 최종 내용을 담는다.
- [x] Given ③·④ 지점 크래시, When 재생하면, Then 누락된 인덱스 upsert와 이벤트 append가 복구된다. *(AC15)*
- [x] Given 이벤트 append+fsync 직후 `EVENT_DONE` 기록 전 크래시, When 재생하면, Then 대상 JSONL에서 `event_id` 존재를 확인해 append를 건너뛰므로 **중복 인덱스 레코드 0건, 중복 이벤트 0건**이다.
- [x] Given 재생이 진행되는 중 다시 크래시, When 재기동해 또 재생하면, Then 결과가 1회 재생과 동일하다(재생 자체가 멱등).
- [x] Given 재생할 미완료 outbox 레코드가 있는 상태, When 서버가 기동하면, Then **재생을 마치기 전에는 도메인 쓰기 API를 수락하지 않고**, 재생 진행 상태를 로그로 남긴다.
- [x] Given `.local/outbox.sqlite`가 통째로 유실됨, When 재기동하면, Then 서버는 정상 기동하고 파일이 SoT이므로 도메인 데이터는 온전하며 인덱스는 전체 재빌드로 복구된다. `.local/`은 백업 대상이 아니다. *(D5)*
- [x] Given 이미 같은 `.localjira/`를 잡고 있는 서버 프로세스, When 두 번째 서버를 기동하면, Then lock 파일 충돌로 **기동을 거부**하고 기존 프로세스 정보(pid·시작 시각)를 출력한다. *(§5.4 단일 writer)*
- [x] Given 이전 서버가 비정상 종료해 lock 파일이 남음, When 새 서버가 기동하면, Then 파일 존재나 PID 추측이 아니라 OS가 해제한 advisory lock을 획득해 정상 기동한다(ADR-002).
- [x] Given 코멘트 `.ops.jsonl`·이벤트 `.jsonl`에 대한 append, When 크래시하면, Then 마지막 줄이 잘린 채 남지 않는다(줄 단위 원자성 보장 또는 재생 시 불완전 줄 절삭).

## 범위 밖 (Out of Scope)

- `Idempotency-Key` 저장·`(actor_id, key)` 24시간 보존·재요청 응답 재현 → R15 (같은 `outbox.sqlite`를 쓰지만 요구사항이 다르다)
- 인덱스 전체 재빌드 로직 자체 → R8 (`r08a-file-index-sync.md`)
- **디스크 장애·파일시스템 손상** — D5에 따라 보장 범위 밖
- claim/lease 등 `.local/runtime.sqlite` 런타임 상태의 복구 — 재기동 시 만료분 전량 회수가 정상 동작이며 복구 대상이 아니다(§5.4, G4)
- 낙관적 동시성 판정(ETag/412) → R10

## 선행 의존 (Depends on)

- `r08a-file-index-sync.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.4(원자적 저장·단일 writer) · §5.5(API 쓰기 파이프라인) · §13 D5
- 검증: PRD AC15, NFR N5
