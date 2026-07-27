---
title: "이슈 관계 링크와 blocked_by 기반 claimable 판정"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R2
milestone: M1
priority: P0
---

# 이슈 관계 링크와 blocked_by 기반 claimable 판정

> R2를 둘로 쪼갠 뒤쪽. 링크 자체보다 `blocked_by → claimable=false` 파생 계산이 이 스토리의 핵심이며, 에이전트 후보 조회(R4·R16)가 이 값을 그대로 쓴다.

## 사용자 스토리 (User Story)

> **As a** AI 에이전트,
> **I want** 이슈에 걸린 관계 링크와 그로부터 계산된 `claimable` 값·사유를 API로 받기를,
> **so that** 선행 작업이 안 끝난 이슈를 집어 헛돌지 않고, 왜 못 집는지를 사람에게 그대로 보고할 수 있다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 이슈 A와 B, When A에 `{kind: blocked_by, to: <B.uid>}` 링크를 추가하면, Then 201이고 A의 파일 frontmatter `links[]`에 해당 항목이 uid 참조로 기록된다.
- [ ] Given `kind`가 `blocks|blocked_by|relates_to|duplicates` 외의 값, When 링크 추가를 요청하면, Then 400이고 허용 종류 목록이 반환된다.
- [ ] Given `to`가 존재하지 않는 uid, When 링크 추가를 요청하면, Then 400이다.
- [ ] Given A가 미완료(=`DONE`/`CANCELLED`가 아닌) B를 `blocked_by`로 걸고 있는 상태, When `GET /issues/{A}`를 조회하면, Then `claimable=false`와 함께 사유(차단 중인 이슈 키 목록)가 반환된다.
- [ ] Given 위 상태에서 B가 `DONE`으로 전이되면, When A를 다시 조회하면, Then `claimable`을 막던 사유가 사라진다.
- [ ] Given A가 `claimable=false`인 상태, When 에이전트가 `POST /issues/{A}/claim`을 호출하면, Then 거부되고 응답에 사유가 포함된다(claim 처리 자체는 R16 / AC19).
- [ ] Given 링크가 있는 이슈, When `DELETE /issues/{key}/links/{link_id}`를 호출하면, Then 200/204이고 `links[]`에서 제거되며 `claimable` 재계산 결과가 즉시 반영된다.
- [ ] Given 관계가 걸린 이슈 상세 화면, When 화면을 열면, Then 관계 종류별로 상대 이슈 키·제목·상태가 표시된다.
- [ ] Given 링크 상대편 이슈가 `INVALID`로 격리된 상태, When 그 링크를 변경하려 하면, Then 복구 전까지 차단된다(§5.6, 응답 규격은 R11).

> ⚠ 미정: `blocks`와 `blocked_by`의 역방향 링크를 서버가 자동으로 상대 이슈 파일에 기록하는지(양방향 저장) 아니면 인덱스에서만 역참조로 계산하는지, 그리고 자기 자신 링크·동일 쌍 중복 링크의 처리를 PRD가 정하지 않았다.
> ⚠ 미정: "미완료 `blocked_by`"에서 `CANCELLED` 상태 차단자를 완료로 볼지 여부가 §5.2·§6.1에 명시되어 있지 않다(위 AC는 완료로 간주한 안).

## 범위 밖 (Out of Scope)

- claim 취득·lease·강제 해제 — R16
- 미해결 `question`/`review_request`에 의한 claim 게이팅 — R19
- `duplicates` 관계에 따른 자동 상태 변경·병합 (PRD 미정의)
- `claimable` 필터 파라미터의 목록 API 노출 — `r04a-issue-filter.md`
- 관계 위반·순환 참조의 격리 처리 — R11

## 선행 의존 (Depends on)

- `r01a-issue-create-read.md`
- `r01b-issue-update-delete.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1, §5.2, §6.1, §7 R2, §8(이슈 상세)
- 검증: PRD AC12(관계 링크 요구 근거), AC19(claimable 거부 사유)
