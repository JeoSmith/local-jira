---
title: "이슈 목록 구조화 필터 (상태·타입·담당자·라벨·스프린트·claimable)"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R4
milestone: M1
priority: P0
---

# 이슈 목록 구조화 필터 (상태·타입·담당자·라벨·스프린트·claimable)

> R4를 둘로 쪼갠 앞쪽. 구조화 필터는 인덱스 컬럼·정렬·성능 예산의 문제이고, 전문 검색(r04b)은 FTS5 인덱스와 키 alias 해석이라는 별개 문제다.

## 사용자 스토리 (User Story)

> **As a** AI 에이전트,
> **I want** `GET /issues?sprint=active&status=TODO&claimable=true` 같은 복합 필터로 착수 가능한 작업 후보만 받기를,
> **so that** 백로그 전체를 읽고 스스로 판단하지 않고도 집을 수 있는 이슈만 골라낼 수 있다.

## 인수 조건 (Acceptance Criteria)

- [x] Given 이슈 목록 API, When `status`, `type`, `assignee`, `label`, `sprint`, `claimable` 파라미터를 조합해 호출하면, Then 조건들은 AND로 결합되어 모두 만족하는 이슈만 반환된다.
- [x] Given `claimable=true` 필터, When 호출하면, Then 미완료 `blocked_by`가 걸린 이슈는 결과에서 제외된다(판정 근거는 `r02b-issue-links.md`).
- [x] Given 정렬 파라미터가 없는 요청, When 백로그 목록을 조회하면, Then `(backlog_rank, uid)` 순으로 결정적으로 정렬되어 반환된다.
- [x] Given 파싱 실패·conflict marker로 `INVALID` 격리된 이슈가 있는 프로젝트, When 목록을 조회하면, Then 격리 항목은 일반 목록·집계에서 제외되고 나머지는 정상 반환된다(격리 목록 자체는 R11 화면에서 본다). — AC10
- [x] Given 허용되지 않은 필터 값(예: `status=REVIEWING`), When 호출하면, Then 400과 함께 허용값 목록이 반환된다.
- [x] Given 이슈 5,000건 데이터셋(기준 장비·production build·warm cache), When 상태+라벨+claimable 복합 필터를 10회 반복 호출하면, Then p95 응답이 300ms 이하다. — AC13, N1
- [ ] Given 같은 데이터셋, When 백로그 화면을 필터가 걸린 상태로 열면, Then 첫 콘텐츠 렌더 p95가 1s 이하다. — N1  
      **→ 이월: M2 UI — 목록 API p95 5ms는 측정했다. 렌더 예산은 화면이 생긴 뒤 잰다**
- [x] Given `.local/index.sqlite`를 삭제하고 서버를 재기동한 상태, When 동일한 필터 요청을 보내면, Then 삭제 전과 동일한 결과 집합·순서를 반환한다(인덱싱 시각 등 파생 값 제외). — AC2
- [ ] Given 백로그 화면, When 사용자가 여러 항목을 선택하면, Then 하단에 선택 항목의 포인트 합계가 표시된다(§8).  
      **→ 이월: M2 UI — API는 페이지 포인트 합계를 반환한다. 다중 선택 UI가 M2 화면 작업**

> ✅ 해소: **같은 파라미터의 반복 값은 OR, 서로 다른 파라미터는 AND**다. 필드마다 규칙이
> 다르면(라벨은 AND, 상태는 OR) 사용자가 매번 시험해 봐야 믿을 수 있다. "라벨을 모두 가진"
> 조건은 M1에서 표현할 수 없으며, 필요해지면 질의 언어(R24)와 함께 정한다.
>
> 페이지네이션은 **커서**다(기본 50, 최대 500). 목록은 재정렬되는 것이 목적이므로
> offset은 순서가 바뀐 뒤 행을 **말없이 건너뛰거나 중복**시킨다. 커서는 정렬 키
> `(backlog_rank, uid)` 자체를 인코딩하며, 손으로 만들어 offset처럼 쓰지 못하도록 불투명하다.
> ✅ 해소: 예약어로 **인정하되 M1에서는 400으로 거부**한다. 스프린트 엔티티가 r05(M2)에
> 생기므로 지금은 해석할 수 없는데, 값 필터로 흘려보내면 빈 목록이 반환되어 에이전트가
> **"할 일이 없다"로 읽는다**. 없는 것과 아직 없는 것은 다르게 답해야 한다.

## 범위 밖 (Out of Scope)

- 전문 검색·`former_keys` alias 조회 — `r04b-fulltext-search.md`
- 스프린트 엔티티 자체와 ACTIVE 판정 — R5 (M2). M1에서는 `sprint` 필터를 값 기준 필터로만 다룬다.
- claim 소유자·run 상태 기준 필터 — R16·R17 (M3)
- 저장된 필터(saved view)·커맨드 팔레트 — R24 (M5)
- 인덱스 재빌드·조정 로직 — R8·R21

## 선행 의존 (Depends on)

- `r01a-issue-create-read.md`
- `r02b-issue-links.md` (claimable 판정)
- `r03-backlog-rank-lexorank.md` (기본 정렬 키)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §4 S3, §5.6, §7 R4, §8(백로그), §9 N1
- 검증: PRD AC13, AC2, AC10
