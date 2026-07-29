---
uid: 01KYPM95492ZPV13Q2VHMXHB29
key: LJ-8
former_keys: []
type: story
title: r02a 이슈 계층 규칙과 부모 삭제 전략
status: DONE
points: 3
labels: [M1, P0, R2]
backlog_rank: "zuxqzzzplcxpvfqvhqzi"
acceptance:
  - id: ac1
    text: Given type=epic 이슈, When parent를 지정해 생성·수정하면, Then 400이다 — epic은 최상위다.
    done: false
  - id: ac2
    text: Given type=story|task|bug|spike 이슈, When parent를 epic으로 지정하면 200/201이고, parent를 story나 task로 지정하면 400이다.
    done: false
  - id: ac3
    text: Given type=subtask 이슈, When parent를 epic으로 지정하면, Then 400이다 — subtask는 epic을 제외한 작업형 이슈(story|task|bug|spike)만 부모로 가진다. — AC12
    done: false
  - id: ac4
    text: Given type=subtask 이슈 X, When 다른 이슈의 parent를 X로 지정하면, Then 400이다 — subtask는 자식을 가질 수 없다.
    done: false
  - id: ac5
    text: Given A의 부모가 B인 상태, When B의 부모를 A로 설정하면 400이고, A←B←C 체인에서 A의 부모를 C로 설정해도 400이다 — 순환 금지. — AC12
    done: false
  - id: ac6
    text: Given 존재하지 않는 uid를 parent로 보낸 API 요청, When 호출하면, Then 400이다. (같은 위반이 API 밖 파일 편집으로 들어온 경우는 격리 대상 — R11 §5.6)
    done: false
sprint: LJ-S1
parent: 01KYPM933BYXX27G7012W6HZCH
created_at: 2026-07-29T18:46:20+09:00
updated_at: 2026-07-29T18:52:02+09:00
created_by_kind: human
last_actor_kind: human
rev: 7
schema_version: 1
---
