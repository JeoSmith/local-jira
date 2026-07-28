---
title: "이슈별 활동 타임라인과 주체 표기"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R14
milestone: M1
priority: P0
---

# 이슈별 활동 타임라인과 주체 표기

> R14 분할 두 번째 스토리. `r14a`가 남긴 이벤트를 사람이 읽는 화면으로 만든다. **"에이전트 변경이 사람 변경처럼 보여서는 안 된다"**(§8)가 이 스토리의 핵심 판정 기준이다.

## 사용자 스토리 (User Story)

> **As a** 에이전트를 감독하는 개발자,
> **I want** 이슈 상세에서 누가(사람·에이전트·외부 편집·시스템) 무엇을 언제 바꿨는지 시간순으로 보기를,
> **so that** 보드 상태가 실제와 어긋났을 때 원인을 추적하고, 에이전트가 임의로 진행한 변경을 즉시 알아볼 수 있다.

## 인수 조건 (Acceptance Criteria)

- [x] Given 변경 이력이 있는 이슈, When `/issues/:key` 상세를 열면, Then 활동 타임라인이 시간순으로 표시되고 각 항목에 발생 시각·주체·행위(verb)·대상이 나타난다(§8).
- [x] Given 타임라인 항목들, When 주체를 보면, Then `human` / `agent` / `external` / `system` 네 종류가 **시각적으로 구분**되며 에이전트 변경이 사람 변경과 같은 표기로 보이지 않는다(AC17, §8 주체 표기 규칙).
- [ ] Given 에이전트가 수행한 상태 변경, When 해당 항목을 보면, Then `agent` 배지와 함께 `run_id`, `initiated_by`(지시한 사람)가 표시되어 **실행 주체와 지시 주체가 모두** 드러난다(AC6, §6.2).  
      **→ 이월: r13b-pat-scope(M4) — 에이전트 run 엔티티가 M4. 표시 경로는 이미 있고 값이 없을 뿐이다**
- [ ] Given 외부 편집(API 밖 파일 수정)으로 생긴 항목, When 해당 항목을 보면, Then 주체가 `external`·`unknown`으로 표시되고, `source_commit`이 있으면 **참고 정보로만** 곁들여지며 "이 커밋 작성자가 변경했다"고 단정하는 표기를 하지 않는다(§5.7).  
      **→ 이월: r08c 후속 — `source_commit`을 git에서 채우는 작업. 표시 규칙(단정하지 않음)은 구현했다**
- [x] Given 필드 변경 항목, When 항목을 펼치면, Then `before`/`after` 값이 표시되어 무엇이 무엇으로 바뀌었는지 확인된다.
- [x] Given 백로그·보드의 이슈 카드, When 배지를 보면, Then **마지막 도메인 변경의 `actor_kind`** 가 표시되고, `created_by_kind`는 이와 별도로 유지된다(§5.1, §8).
- [x] Given 에디터로 이슈 파일을 직접 수정, When 상세 화면을 연 채로 두면, Then **새로고침 없이 3초 이내** 타임라인에 `external` 항목이 나타난다(AC3).
- [x] Given 조회·검색만 반복 수행, When 타임라인을 보면, Then 새 항목이 생기지 않는다(N7).
- [x] Given `.local/index.sqlite`를 삭제하고 재기동, When 같은 이슈의 타임라인을 다시 열면, Then 삭제 전과 동일한 항목이 동일한 순서로 표시된다(AC2 — 이벤트는 파일 SoT).
- [ ] Given 격리(`INVALID`)된 이슈, When 상세를 열면, Then 오류 배너와 파일 경로가 표시되고 해당 엔티티의 변경은 차단되지만, 기존 타임라인 조회는 가능하다(§5.6, AC10).  
      **→ 이월: r11a-integrity-quarantine(Wave 4) — 격리 판정·배너가 R11**
- [x] Given 타임라인 화면, When 라이트/다크 테마를 전환하면, Then 양쪽 모두 정상 렌더링된다(§8 — Next.js App Router + shadcn/ui + lucide).

> ✅ 해소: 기본 **50건**, `limit`은 최대 500까지, `before` 커서로 페이지를 넘긴다. 정렬 키는
> `(at, event_id)`다 — 시각이 초 단위라 같은 초의 두 변경이 흔하고, 두 번째 키가 없으면
> 클론마다·재빌드마다 순서가 달라진다. `event_id`는 ULID라 생성 순서로 갈린다.
> ✅ 해소: **제공하지 않는다.** 한 이슈의 타임라인은 기본 50건이면 대개 전부이고,
> 필터는 "안 보이는 항목이 있다"는 오해를 만든다. 전역 활동 피드(§8 범위 밖)가 생기면
> 그때 함께 정한다.

## 범위 밖 (Out of Scope)

- 이벤트 기록 규칙·저장 경로·`actor_kind` 판정 — `r14a-event-recording.md`.
- 프로젝트 전역 활동 피드 화면 (§8 IA에 이슈 상세 타임라인만 명시).
- 타임라인에서의 되돌리기(revert)·이벤트 편집 — append-only이므로 비대상.
- 변조 방지 표시(서명·검증 뱃지) — §3 비목표.
- 알림 발송 — 1차는 In-App까지(§3).

## 선행 의존 (Depends on)

- `r14a-event-recording.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(`created_by_kind`·Event), §5.6(격리·오류 배너), §5.7(external 주체 표기 한계), §6.2, §7 R14, §8(이슈 상세 화면·주체 표기 규칙), §9 N7, §12 M1
- 검증: PRD AC17·AC6, 보조 AC2·AC3
