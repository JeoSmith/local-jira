---
title: "칸반 보드 — 상태 컬럼과 카드 배지"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R7
milestone: M2
priority: P0
---

# 칸반 보드 — 상태 컬럼과 카드 배지

> **R7 분할 사유**: 보드 읽기(컬럼 구성·카드 표기·브랜치 무관 동일성)와 쓰기(드래그 전이·`board_rank` 갱신)는
> 검증 수단이 다르다. 본 스토리는 렌더와 조회 계약, `r07b`는 전이표 준수와 순서 유지를 다룬다.

## 사용자 스토리 (User Story)

> **As a** 개발자,
> **I want** ACTIVE 스프린트의 이슈를 상태 컬럼으로 보고 각 카드에서 담당자·포인트·누가 마지막으로 손댔는지·지금 누가 잡고 있는지를 한눈에 보기를,
> **so that** 에이전트가 돌리고 있는 작업과 사람이 손댄 작업을 구분해서 감독할 수 있다.

## 인수 조건 (Acceptance Criteria)

### 컬럼과 스코프

- [x] Given ACTIVE 스프린트 `LJ-S3`, When `/projects/LJ/board`를 열면, Then `LJ-S3`에 담긴 이슈만 표시되고 다른 스프린트·백로그 이슈는 보이지 않는다. — §8
- [x] Given 보드, When 컬럼 구성을 보면, Then 컬럼은 §5.2의 이슈 상태이며 각 컬럼 헤더에 **건수와 포인트 합계**가 표시된다.
- [x] Given ACTIVE 스프린트가 없는 프로젝트, When 보드를 열면, Then 빈 상태 안내와 스프린트 화면(`/projects/LJ/sprints`)으로 가는 경로가 표시되고 오류로 처리되지 않는다.
- [x] Given 머지 결과로 ACTIVE 스프린트가 2개인 프로젝트, When 보드를 열면, Then "스프린트 충돌" 배너가 표시되고 시작·종료 명령이 차단 중임이 안내된다(배너 자체는 R11). — §5.6

### 카드 표기

- [x] Given 이슈 `LJ-12`(assignee `u_hooooondev`, points 3), When 카드를 보면, Then 표시 키·제목·담당자·포인트가 표시된다. — §8
- [x] Given 마지막 도메인 변경이 에이전트에 의해 이루어진 이슈, When 카드를 보면, Then 배지가 **`agent`** 로 표시된다. 그 이슈를 사람이 만들었더라도(`created_by_kind: human`) 카드 배지는 **마지막 도메인 변경의 `actor_kind`** 를 따른다. — §5.1, §8
- [x] Given 위 카드에 사람이 제목을 수정, When 다시 보면, Then 배지가 `human`으로 바뀐다. `created_by_kind`는 불변이며 카드 배지와 별개로 유지된다. — §5.1
- [x] Given API 밖에서 에디터로 직접 수정된 이슈, When 카드를 보면, Then 배지가 `external`로 표시된다(주체를 인증된 actor로 간주하지 않는다). — §5.7
- [ ] Given 유효한 claim이 걸린 이슈, When 카드를 보면, Then **claim 소유자**와 **연결된 run 상태**(진행 중 / `STALE` 등)가 배지로 표시된다. — §8  
      **→ 이월: r16·r17(M4) — claim·run 엔티티가 M4에 생긴다. 카드 배지 자리와 렌더 경로는 있다**
- [ ] Given claim 소유자와 `assignee`가 서로 다른 이슈, When 카드를 보면, Then 둘이 각각 구분되어 표시된다(assignee=계획상 책임자, claim owner=현재 실행 주체). — §5.1  
      **→ 이월: r16·r17(M4) — claim·run 엔티티가 M4에 생긴다. 카드 배지 자리와 렌더 경로는 있다**
- [ ] Given 대리 실행 중인 run(에이전트가 사람 지시로 실행), When 카드·상세를 보면, Then 실행 주체와 지시 주체(`initiated_by`)가 모두 표시된다. — §6.2  
      **→ 이월: r16·r17(M4) — claim·run 엔티티가 M4에 생긴다. 카드 배지 자리와 렌더 경로는 있다**
- [ ] Given 미완료 `blocked_by`가 있는 이슈, When 카드를 보면, Then 차단 표시가 되고 `claimable=false` 사유를 확인할 수 있다. — §5.2  
      **→ 이월: r16·r17(M4) — claim·run 엔티티가 M4에 생긴다. 카드 배지 자리와 렌더 경로는 있다**
- [x] Given 카드 배지 전반, When 에이전트 변경과 사람 변경을 비교하면, Then 시각적으로 구분되며 에이전트 변경이 사람 변경처럼 보이지 않는다. — §8

### 브랜치 무관 동일성 · 갱신 · 성능

- [x] Given 리포 루트에서 서버가 떠 있는 상태, When 코드 브랜치를 `feat/a`에서 `feat/b`로 전환한 뒤 보드를 새로고침하면, Then **동일한 보드·동일한 ACTIVE 스프린트**가 보인다. `.localjira/`는 `localjira/data` 브랜치의 worktree라 코드 브랜치를 따라가지 않는다. — AC26, D1
- [ ] Given 다른 워크트리(`.worktree/<주제>/`)에서 작업 중인 사람·에이전트, When 같은 서버 URL로 보드를 조회하면, Then 리포 루트와 동일한 보드가 보인다. — AC26, D1  
      **→ 이월: M2 이후 — 워크트리 병렬 작업 시나리오는 별도 검증이 필요하다. 코드 브랜치 전환 시 동일 보드는 확인했다**
- [x] Given 보드를 연 상태, When 에디터로 이슈 파일의 `status`를 직접 바꾸면, Then **새로고침 없이 3초 이내** 카드가 해당 컬럼으로 이동한다(반영 경로는 R8). — AC3
- [x] Given 이슈 5,000건 데이터셋의 ACTIVE 스프린트, When 보드를 열면, Then 첫 콘텐츠 렌더가 N1 기준(p95 ≤ 1s)을 만족한다.
- [x] Given 라이트/다크 테마, When 보드를 보면, Then 양쪽에서 컬럼·카드·배지 대비가 유지된다. — §8 *(스택은 S2-D1로 바닐라 확정)*

> ✅ 해소(S2-D6): **§5.2의 상태 전부가 컬럼**이고 작업이 흐르는 순서로 놓는다. 다만
> `BLOCKED`·`CANCELLED`는 **비어 있으면 감춘다** — 모든 보드에서 늘 비어 있는 컬럼은
> 자리만 차지하고, 반대로 차 있는데 감추면 작업이 사라진다. `BACKLOG`는 계획 중 담긴
> 이슈가 거기 있을 수 있으므로 항상 보인다.
> ✅ 해소(S2-D6): **M2에서는 두지 않는다.** 보드는 이미 한 스프린트로 좁혀져 있고, 그
> 범위가 곧 필터다. 카드 30장짜리 화면에 필터를 얹는 것은 아직 없는 문제를 푸는 일이며,
> 필요해지면 저장된 뷰(R24)와 함께 정한다.
> ✅ 해소(S2-D6): **별도 컬럼**이다. §5.2가 `BLOCKED`를 실제 상태로 두었으므로, 카드가
> 자기 상태가 아닌 헤딩 아래 앉아 있으면 **누가 끌어 옮기는 순간 그 배치가 거짓이 된다**.
> 대신 카드에 `blocked_from`을 실어 풀렸을 때 어디로 돌아가는지 보여 준다.

## 범위 밖 (Out of Scope)

- 드래그 전이 판정과 `board_rank` 갱신 → `r07b-board-drag-transition-rank.md`
- claim 취득·해제·lease·heartbeat·STALE 판정 로직 → R16·R17 (여기서는 표시만)
- 이슈 상세 화면·활동 타임라인 → R1·R14
- 번다운 차트 → `r20-sprint-burndown.md`
- 격리 배너 컴포넌트 → `r11b-integrity-error-banner.md`
- 전역 헤더의 git 상태 배지 → `r25-git-status-badge.md`

## 선행 의존 (Depends on)

- `r05b-sprint-start-close-carryover.md`
- `r06-sprint-planning-capacity.md`
- `r14a-event-recording.md` (마지막 변경 `actor_kind` 산출)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(주체 표기·정렬 영역) · §5.2(상태·claimable) · §5.7(external 주체) · §6.1·§6.2(claim·run 표시) · §7 R7 · §8(보드 IA·주체 표기 규칙) · §9 N1 · §13 D1
- ADR `../../0_decisions/adr-006-shared-board-data-branch.md` (D1 — 보드가 하나인 이유)
- 검증: PRD AC14(전이는 `r07b`), AC26, AC3
