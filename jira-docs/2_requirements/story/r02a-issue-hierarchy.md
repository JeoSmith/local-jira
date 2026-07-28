---
title: "이슈 계층 규칙과 부모 삭제 전략"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R2
milestone: M1
priority: P0
---

# 이슈 계층 규칙과 부모 삭제 전략

> R2를 둘로 쪼갠 앞쪽. 계층(parent)은 타입별 허용 조합·순환 검사·삭제 전략이라는 한 덩어리이고, 관계 링크(r02b)는 `claimable` 계산까지 물고 있어 검증 축이 다르다.

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** 에픽–스토리–서브태스크 계층이 규칙에 맞게만 만들어지고, 하위가 달린 부모를 지울 때 처리 방식을 내가 고르기를,
> **so that** 머지·대량 편집 이후에도 트리가 깨지지 않고, 하위 이슈가 조용히 고아가 되지 않는다.

## 인수 조건 (Acceptance Criteria)

- [x] Given `type=epic` 이슈, When `parent`를 지정해 생성·수정하면, Then 400이다 — `epic`은 최상위다.
- [x] Given `type=story|task|bug|spike` 이슈, When `parent`를 `epic`으로 지정하면 200/201이고, `parent`를 `story`나 `task`로 지정하면 400이다.
- [x] Given `type=subtask` 이슈, When `parent`를 `epic`으로 지정하면, Then 400이다 — `subtask`는 epic을 제외한 작업형 이슈(`story|task|bug|spike`)만 부모로 가진다. — AC12
- [x] Given `type=subtask` 이슈 X, When 다른 이슈의 `parent`를 X로 지정하면, Then 400이다 — `subtask`는 자식을 가질 수 없다.
- [x] Given A의 부모가 B인 상태, When B의 부모를 A로 설정하면 400이고, A←B←C 체인에서 A의 부모를 C로 설정해도 400이다 — 순환 금지. — AC12
- [x] Given 존재하지 않는 uid를 `parent`로 보낸 API 요청, When 호출하면, Then 400이다. (같은 위반이 API 밖 파일 편집으로 들어온 경우는 격리 대상 — R11 §5.6)
- [x] Given 하위 이슈 2건이 달린 부모, When `DELETE /issues/{key}`를 `strategy` 없이 호출하면, Then 409와 함께 하위 이슈 목록·필요한 `strategy` 값(`promote`, `cascade_cancel`)이 반환되고 아무 파일도 변경되지 않는다. — AC12
- [x] Given 같은 부모, When `DELETE /issues/{key}?strategy=promote`를 호출하면, Then 하위 이슈의 `parent`가 제거되어 부모 없는 최상위가 된 뒤 부모 파일이 삭제되고, 하위 이슈 파일도 각각 변경된다.
- [x] Given 같은 부모, When `DELETE /issues/{key}?strategy=cascade_cancel`을 호출하면, Then 하위 이슈가 먼저 `CANCELLED`로 전이(§5.2 표상 모든 상태에서 허용)된 뒤 부모가 삭제된다.
- [x] Given `GET /issues/{key}`, When 하위 이슈가 있는 부모를 조회하면, Then 하위 이슈 목록이 함께 반환되어 이슈 상세 화면의 "하위이슈" 영역에 표시된다.

> ✅ 해소(S1-D14): **409로 거부한다**(`E_STRATEGY_IMPOSSIBLE`). 부모 없는 subtask는 생성 경로가
> 400으로 막는 형태이므로, 승격으로 만들어내면 **API가 결코 만들 수 없는 것을 인덱스가 갖게 되고**
> R11이 나중에 격리 대상으로 집는다. 응답은 어떤 subtask가 걸렸는지와 `cascade_cancel` 대안을 함께 준다.
> subtask를 최상위로 허용하는 선택지는 기각했다 — 그러면 생성과 승격이 서로 다른 규칙을 갖게 된다.

## 범위 밖 (Out of Scope)

- `blocks/blocked_by/relates_to/duplicates` 관계 링크 — `r02b-issue-links.md`
- 파일 직접 편집·머지로 유입된 계층 위반의 격리(INVALID)와 오류 배너 — R11
- 부모–하위 간 포인트 합산·롤업 표시 (PRD 미정의, 1차 범위 아님)
- 계층 기준 정렬·들여쓰기 트리 렌더링 — 백로그 화면(R3·R4 목록 계약을 따름)

## 선행 의존 (Depends on)

- `r01a-issue-create-read.md`
- `r01b-issue-update-delete.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1, §5.2, §7 R2, §8(이슈 상세)
- 검증: PRD AC12
