# Local Jira 문서

Local Jira의 제품 요구사항부터 구현 계획까지 관리하는 문서 루트다.

## 문서 구조

```text
jira-docs/
  0_decisions/             ADR-001~006
  2_requirements/
    prd/                    제품 요구사항
    story/                  R1~R26에서 분해한 스토리 42건
  3_designs/
    detailed/               저장 계층·M0·구현 스택 상세 설계
    database/               SQLite 스키마
  4_plans/
    sprints/                스프린트 실행 계획
```

## 주요 문서

- [메인 PRD](2_requirements/prd/backlog-sprint.md)
- [스토리 인덱스](2_requirements/story/README.md)
- [ADR 목록](0_decisions/)
- [저장 계층 상세 설계](3_designs/detailed/storage-layer.design.md)
- [SQLite 스키마](3_designs/database/index-schema.md)
- [M0 부트스트랩 상세 설계](3_designs/detailed/m0-bootstrap.design.md)
- [구현 스택과 프로젝트 구조](3_designs/detailed/implementation-stack.design.md)
- [Sprint 01 계획](4_plans/sprints/sprint-01-m1-reliable-core.md)

## 문서 흐름

```text
PRD → Story → ADR/상세 설계/DB 스키마 → Sprint 계획 → 구현
```

PRD의 요구사항을 바꾸면 관련 Story와 설계를 함께 확인하고, 구현 계약이 바뀌는 결정은 ADR에 남긴다.
