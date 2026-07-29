---
uid: 01KYPM94G8WB5Z0JB38MVEFTCH
key: LJ-6
former_keys: []
type: story
title: r01a 이슈 생성·조회 (파일 SoT)
status: DONE
points: 3
labels: [M1, P0, R1]
backlog_rank: "zfqzzzyudfqvhqzi"
acceptance:
  - id: ac1
    text: Given 프로젝트 LJ가 초기화된 상태, When POST /issues에 type=story, title="백로그 리스트 가상 스크롤"을 보내면, Then 201과 함께 uid(ULID)·서버 발급 표시 키 LJ-<n>이 반환되고 .localjira/issues/LJ/LJ-<n>.md 파일 1개가 생성된다.
    done: false
  - id: ac2
    text: Given 위 생성 직후, When git -C .localjira status를 확인하면, Then 신규 파일은 그 이슈 파일 1개만 잡힌다(인덱스·outbox·runtime은 .local/이라 추적 대상이 아니다). — AC1
    done: false
  - id: ac3
    text: "Given 생성 요청, When 파일이 기록되면, Then frontmatter에 uid, key, former_keys: , type, title, status, created_at, updated_at, created_by_kind, schema_version: 1이 포함되고 모든 시각은 프로젝트 timezone of"
    done: false
  - id: ac4
    text: Given type이 epic|story|task|bug|spike|subtask 중 하나가 아닌 요청, When POST /issues를 호출하면, Then 400과 함께 허용 타입 목록이 반환되고 파일은 생성되지 않는다.
    done: false
  - id: ac5
    text: Given assignee(human 또는 agent User), labels, points, acceptance를 포함한 생성 요청, When 저장되면, Then acceptance는 frontmatter에 {id, text, done} 객체 배열로 기록되고 본문 heading으로는 기록되지 않는다.
    done: false
  - id: ac6
    text: Given 설명(description)을 포함한 생성 요청, When 저장되면, Then 설명은 frontmatter 아래 본문에 원문 그대로 들어가고, 서버는 본문의 heading을 도메인 구분자로 해석하지 않는다.
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
