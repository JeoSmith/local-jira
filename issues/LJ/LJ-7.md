---
uid: 01KYPM94T7CAB6R9JE878SRQMC
key: LJ-7
former_keys: []
type: story
title: r01b 이슈 수정·상태 전이·삭제
status: DONE
points: 3
labels: [M1, P0, R1]
backlog_rank: "4nzzzt"
acceptance:
  - id: ac1
    text: "Given ETag E1으로 읽은 이슈, When If-Match: E1과 함께 title·assignee·labels·points·acceptance를 수정하면, Then 200과 새 ETag가 반환되고 updated_at이 갱신되며 변경 파일은 그 이슈 파일 1개다."
    done: false
  - id: ac2
    text: Given 같은 수정 요청, When 저장되면, Then 요청에 없던 frontmatter 키와 본문은 그대로 보존된다.
    done: false
  - id: ac3
    text: Given 수정 요청 본문에 uid, key, created_by_kind, created_at이 포함된 경우, When 호출하면, Then 400을 반환한다 — created_by_kind는 불변이고 key는 서버 발급 값이다.
    done: false
  - id: ac4
    text: Given status=BACKLOG인 이슈, When IN_PROGRESS로 전이를 요청하면, Then §5.2 표에 없는 전이이므로 400과 함께 허용 전이 목록이 반환되고 파일은 변경되지 않는다.
    done: false
  - id: ac5
    text: Given status=BACKLOG인 이슈, When TODO로 전이하면 200이고, TODO → IN_PROGRESS → IN_REVIEW → DONE도 각각 200이며, DONE → IN_PROGRESS는 200이지만 DONE → TODO는 400이다.
    done: false
  - id: ac6
    text: Given status=IN_PROGRESS인 이슈, When BLOCKED로 전이하면, Then 진입 직전 상태가 blocked_from으로 보존되고, BLOCKED에서의 복귀는 blocked_from 값으로만 허용되며 다른 상태로의 복귀는 400이다(CANCELLED 전이는 허용).
    done: false
sprint: LJ-S1
parent: 01KYPM933BYXX27G7012W6HZCH
created_at: 2026-07-29T18:46:20+09:00
updated_at: 2026-08-03T12:58:32+09:00
created_by_kind: human
last_actor_kind: human
rev: 8
schema_version: 1
---
