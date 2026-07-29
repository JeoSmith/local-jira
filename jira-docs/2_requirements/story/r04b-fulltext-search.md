---
title: "이슈 전문 검색 (FTS5)과 표시 키 alias 조회"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R4
milestone: M1
priority: P0
---

# 이슈 전문 검색 (FTS5)과 표시 키 alias 조회

> R4를 둘로 쪼갠 뒤쪽. FTS5 인덱스 구축·재빌드 동치성·`former_keys` alias 해석은 구조화 필터(r04a)와 검증 방법이 완전히 다르다.

## 사용자 스토리 (User Story)

> **As a** 개발자,
> **I want** 제목·본문·인수조건에 들어간 단어나 예전에 쓰던 이슈 키로 이슈를 찾기를,
> **so that** 키가 재발급된 뒤에도 기억하던 키로 티켓을 찾을 수 있고, 관련 작업을 놓치지 않는다.

## 인수 조건 (Acceptance Criteria)

- [x] Given 제목·본문·인수조건 텍스트가 색인된 상태, When `GET /issues?q=가상 스크롤`을 호출하면, Then 해당 단어를 포함한 이슈만 반환되고 구조화 필터(`status`, `label` 등)와 AND로 결합된다.
- [x] Given 검색 결과, When 응답을 확인하면, Then 각 항목에 매칭 근거(스니펫 또는 매칭 필드)가 포함되어 어디가 걸렸는지 알 수 있다.
- [x] Given `LJ-13`이 `LJ-14`로 재키잉되어 `former_keys: [LJ-13]`을 가진 이슈와, 같은 키 `LJ-13`을 원래 보유한 다른 이슈가 함께 있는 상태, When `LJ-13`으로 조회·검색·링크 참조를 하면, Then 두 이슈가 구분되어 해석되고 **현재 키 보유자(원 소유자)가 우선** 매칭되며, alias 매칭은 그 사실이 표시된다. — AC25
- [x] Given `INVALID`로 격리된 이슈 파일, When 전문 검색을 하면, Then 결과에 포함되지 않는다(§5.6).
- [x] Given 이슈 5,000건 데이터셋(기준 장비·production build·warm cache), When 본문 전문 검색을 10회 반복 호출하면, Then p95 응답이 300ms 이하다. — AC13, N1
- [x] Given `.local/index.sqlite`(FTS5 테이블 포함)를 삭제하고 재기동한 상태, When 동일한 검색어로 조회하면, Then 검색 **score를 제외한** 결과 집합이 삭제 전과 동일하다 — 검색 인덱스는 파일에서 100% 재생성 가능해야 한다. — AC2
- [x] Given 파일 1건을 에디터로 직접 수정한 상태, When debounce·조정이 끝나면, Then 새 본문 단어로 검색되고 옛 단어로는 검색되지 않는다(증분 색인 ≤ 100ms — N2).
- [x] Given 검색어가 비어 있거나 공백뿐인 요청, When 호출하면, Then 검색 조건 없이 구조화 필터만 적용된 목록이 반환된다(400이 아니다).

> ✅ 해소(S2-D2): **`trigram`**. 5,000건 실측에서 `unicode61`은 `스크롤` 검색이 실제 일치
> 4,986건 중 **2,323건만** 찾았다 — 조사가 붙은 `스크롤을`·`스크롤에서`가 다른 토큰이 되기
> 때문이다. 느린 게 아니라 틀린 답이다. 비용은 인덱스 1.8배(설계 예상 3~5배보다 작다),
> p95는 5,000건 API 검색 **55ms**로 예산 300ms 대비 여유가 크다. 3자 미만 항은 trigram이
> 조용히 0건을 주므로 LIKE로 폴백한다.
> ✅ 해소: **제목·본문·인수조건·키 alias**까지다(인덱스 스키마의 `issues_fts` 컬럼이 곧 범위다).
> 코멘트는 M3에 엔티티가 생기고, 라벨·담당자는 이미 구조화 필터로 정확히 걸린다 —
> 전문 검색에 넣으면 `perf`를 찾는 사람이 본문에 perf가 적힌 이슈까지 받게 된다.

## 범위 밖 (Out of Scope)

- 표시 키 충돌 감지와 자동 재키잉 로직 자체 — R26 (여기서는 `former_keys[]`가 이미 있는 상태의 조회만 다룬다)
- 구조화 필터 파라미터 규격·기본 정렬 — `r04a-issue-filter.md`
- 인덱스 재빌드·전체 검증 버튼 — R21
- 코멘트·AgentRun·이벤트 검색 (1차 범위 아님)
- LLM 기반 의미 검색 (PRD에 없음)

## 선행 의존 (Depends on)

- `r01a-issue-create-read.md`
- `r04a-issue-filter.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.3, §5.4(식별자 발급·재키잉), §5.6, §7 R4·R26, §9 N1·N2, §13 D3
- 검증: PRD AC13, AC2, AC25
