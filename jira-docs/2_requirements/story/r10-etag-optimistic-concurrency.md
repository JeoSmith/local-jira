---
title: "강한 ETag 낙관적 동시성과 412 충돌 응답"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R10
milestone: M1
priority: P0
---

# 강한 ETag 낙관적 동시성과 412 충돌 응답

## 사용자 스토리 (User Story)

> **As a** 개발자(사람·에이전트 클라이언트를 만드는 입장),
> **I want** 내가 읽은 버전을 `If-Match`로 못 박아 보내고, 그 사이 누가 고쳤으면 덮어쓰기 대신 412와 함께 현재 문서·거부된 값을 돌려받기를,
> **so that** 사람과 에이전트가 같은 이슈를 동시에 건드려도 남의 변경이 조용히 사라지지 않고, 클라이언트가 스스로 병합할 재료를 갖는다.

## 인수 조건 (Acceptance Criteria)

- [x] Given `GET /issues/LJ-12`, When 응답 헤더를 보면, Then `ETag: "<content-hash>"` 형식의 **강한 ETag**(약한 `W/` 접두 없음)가 있고, 값은 JCS로 전송한 API 응답 바이트의 SHA-256이다. 동일 API 표현을 가진 다른 클론에서 읽어도 **같은 값**이 나온다.
- [x] Given 동일 ETag `E1`을 읽은 두 클라이언트, When 서로 다른 `title`로 `PUT /issues/LJ-12`를 보내면, Then 첫 요청은 **200 + 새 ETag `E2`**, 두 번째는 **412**다. *(AC8)*
- [x] Given 위 412 응답, When 본문을 보면, Then ① 현재 ETag ② **현재 문서 전문** ③ 거부된 요청 값이 **필드 단위로** 담긴다(필드별 `{현재 값, 요청 값}`). 서버는 클라이언트의 base 스냅샷을 보관하지 않으므로 3-way diff는 클라이언트가 자기 base로 계산한다.
- [x] Given 412가 반환된 뒤, When 파일을 확인하면, Then **첫 변경이 온전히 보존**되어 있고 두 번째 요청의 값은 어떤 필드에도 반영되지 않았다. *(AC8)*
- [x] Given 412를 받은 클라이언트가 응답의 현재 ETag로 동일 요청을 재시도, When 그 사이 다른 변경이 없으면, Then **200**과 새 ETag를 받는다.
- [x] Given 변경 요청(`PUT`/`PATCH`/상태 전이/삭제)에 `If-Match` 헤더가 없음, When 처리하면, Then **428 Precondition Required**로 거부하고 현재 ETag를 안내한다 — 마지막 쓰기 승리를 허용하지 않는다.
- [x] Given 에디터로 파일을 외부 편집해 content hash가 바뀐 이슈, When 편집 전 ETag로 `PUT`을 보내면, Then **412**다(외부 변경도 동일한 충돌 판정을 받는다). *(r08b 연계)*
- [x] Given 이슈 frontmatter에 정수 `rev` 필드가 있음, When 동시성 판정을 수행하면, Then `rev`는 판정에 **전혀 쓰이지 않으며** 표시·이력 용도로만 응답에 실린다. 서로 다른 클론이 같은 `rev` 값을 만들어도 오탐·미탐이 발생하지 않는다.
- [x] Given 요청 값이 현재 값과 완전히 동일한 no-op `PUT`, When 처리하면, Then 파일이 재작성되지 않아 ETag가 그대로이고 도메인 이벤트도 추가되지 않는다(`git status`에 변경 없음).
- [ ] Given `sprints/LJ/LJ-S3.yaml`·`projects/LJ.yaml` 등 파일 SoT 리소스, When 조회·변경하면, Then 이슈와 동일한 ETag/`If-Match`/412 계약이 적용된다.  
      **→ 이월: r05-sprint-crud(M2) — 스프린트·프로젝트 쓰기 경로가 아직 없다**
- [ ] Given 코멘트 원문, When 변경을 시도하면, Then 원문 파일은 불변이므로 `PUT` 대상이 아니며, 상태 변경은 `.ops.jsonl` append 경로로만 가능하다(멱등성은 R15).  
      **→ 이월: r15-idempotency-key(M3) — 코멘트 엔티티가 M3에서 생긴다**
- [ ] Given 격리(INVALID) 상태인 이슈, When `If-Match`가 맞더라도 변경을 시도하면, Then R11의 차단 규칙이 우선하여 거부된다.  
      **→ 이월: r11a-integrity-quarantine(Wave 4) — INVALID 판정 자체가 R11 범위**

> 결정됨: ETag 입력과 wire representation은 ADR-003 및 저장 설계 §3.2의 JCS 계약을 따른다.

## 범위 밖 (Out of Scope)

- 서버 측 3-way 자동 병합 — §5.4에서 명시적으로 클라이언트 책임으로 둔다
- 실시간 다중 편집(CRDT) — §3 비목표
- `Idempotency-Key`(생성·append API의 중복 방지) → R15. ETag는 **갱신** 충돌, 멱등성 키는 **생성** 중복으로 문제가 다르다
- claim/lease를 통한 논리적 선점 → R16
- 파일 원자 교체·크래시 복구 → R9

## 선행 의존 (Depends on)

- `r08a-file-index-sync.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.4(낙관적 동시성 · 정수 rev 기각 근거) · §6.2(작업 컨텍스트가 현재 ETag를 포함)
- ADR `../../0_decisions/adr-003-etag-concurrency.md`
- 검증: PRD AC8
