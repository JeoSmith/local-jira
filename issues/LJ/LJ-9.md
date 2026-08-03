---
uid: 01KYPM95EFRJR8344ZPBNJGABW
key: LJ-9
former_keys: []
type: story
title: r02b 이슈 관계 링크와 blocked_by 기반 claimable 판정
status: DONE
points: 2
labels: [M1, P0, R2]
backlog_rank: "5zzzzr"
acceptance:
  - id: ac1
    text: "Given 이슈 A와 B, When A에 {kind: blocked_by, to: <B.uid>} 링크를 추가하면, Then 201이고 A의 파일 frontmatter links에 해당 항목이 uid 참조로 기록된다."
    done: false
  - id: ac2
    text: Given kind가 blocks|blocked_by|relates_to|duplicates 외의 값, When 링크 추가를 요청하면, Then 400이고 허용 종류 목록이 반환된다.
    done: false
  - id: ac3
    text: Given to가 존재하지 않는 uid, When 링크 추가를 요청하면, Then 400이다.
    done: false
  - id: ac4
    text: Given A가 미완료(=DONE/CANCELLED가 아닌) B를 blocked_by로 걸고 있는 상태, When GET /issues/{A}를 조회하면, Then claimable=false와 함께 사유(차단 중인 이슈 키 목록)가 반환된다.
    done: false
  - id: ac5
    text: Given 위 상태에서 B가 DONE으로 전이되면, When A를 다시 조회하면, Then claimable을 막던 사유가 사라진다.
    done: false
  - id: ac6
    text: Given A가 claimable=false인 상태, When 에이전트가 POST /issues/{A}/claim을 호출하면, Then 거부되고 응답에 사유가 포함된다(claim 처리 자체는 R16 / AC19).
    done: false
sprint: LJ-S1
parent: 01KYPM933BYXX27G7012W6HZCH
created_at: 2026-07-29T18:46:21+09:00
updated_at: 2026-08-03T12:58:32+09:00
created_by_kind: human
last_actor_kind: human
rev: 8
schema_version: 1
---
