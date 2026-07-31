---
title: "웹 코멘트 — 읽기·작성·해결과 게이팅 표시"
status: done
owner: 이성훈
created: 2026-07-31
updated: 2026-07-31
related_prd: ../prd/backlog-sprint.md
requirement: R19
milestone: M5
priority: P0
---

# 웹 코멘트 — 읽기·작성·해결과 게이팅 표시

> R19의 **화면 절반**이다. `r19a`가 코멘트 모델과 op 재생을, `r19b`가 미해결 질문의 게이팅을
> 만들었지만 **화면에는 코멘트가 아예 없다** — 읽기도, 쓰기도, 해결 처리도.
>
> 그래서 Sprint 04의 대표 기능이 웹에서 **쓸 수 없는 상태**다. "사람이 남긴 말이 에이전트를
> 멈춘다"는 것이 그 스프린트의 목표였는데, 질문을 남길 방법이 없으면 멈출 것도 없다. 게이팅은
> 동작하지만 그것을 거는 유일한 길이 CLI와 API다.
>
> P0으로 둔 이유가 그것이다. 다른 화면 구멍(삭제·부모 지정)은 CLI로 우회할 수 있는 편의의
> 문제지만, 이것은 **이미 만들어 둔 기능 하나가 통째로 닿지 않는** 상태다.

## 사용자 스토리 (User Story)

> **As a** 에이전트가 뭘 하고 있는지 보다가 "이거 맞나?"가 떠오른 개발자·PO,
> **I want** 그 이슈에 질문을 남기고, 답을 받으면 해결로 표시하기를,
> **so that** 내 질문이 활동 피드에 묻힌 채 에이전트가 계속 진행하지 않고, 그 흐름 전체를
> 터미널을 열지 않고 처리한다.

## 인수 조건 (Acceptance Criteria)

### 읽기

- [x] Given 이슈 상세, When 열면, Then 그 이슈의 코멘트가 **작성 순서대로** 표시되고 각 코멘트에 작성자·`actor_kind` 배지·종류·시각·해결 여부가 보인다. *(§5.1, §8)*
- [x] Given 에이전트가 남긴 코멘트, When 목록을 보면, Then **사람이 쓴 것과 시각적으로 구분된다.** *(§8 주체 표기 규칙)*
- [x] Given `delete` op로 철회된 코멘트, When 목록을 보면, Then 나타나지 않는다. *(§5.3 — 파일은 남지만 목록에는 없다)*
- [x] Given 코멘트가 하나도 없는 이슈, When 열면, Then 빈 상태 안내가 보이고 오류가 아니다.

### 쓰기

- [x] Given 이슈 상세, When 코멘트를 쓰고 [남기기]를 누르면, Then `POST /issues/{key}/comments` **하나만** 호출되고 목록에 바로 나타난다.
- [x] Given 작성 폼, When 종류를 고르면, Then `general`·`question`·`decision`·`review_request` 넷이며 **기본값은 `general`** 이다. *(§6.3, S4-D1)*
- [x] Given 빈 본문, When [남기기]를 누르면, Then 요청을 보내지 않고 폼에서 막는다.
- [x] Given 작성 요청, When 헤더를 확인하면, Then `Idempotency-Key`가 실려 더블클릭이 코멘트를 두 개 만들지 않는다. *(§5.4, r15)*
- [x] Given `issue:comment` 권한이 없는 역할·토큰, When 상세를 보면, Then 작성 폼이 노출되지 않거나 비활성이다. *(§6.4, AC7)*

### 해결과 게이팅

- [x] Given 미해결 `question`·`review_request`, When 그 코멘트를 보면, Then [해결] 버튼이 있고 누르면 `resolved`로 바뀐다. *(§6.3)*
- [x] Given 해결된 코멘트, When 보면, Then [해결 취소]가 있고 누르면 다시 미해결이 된다 — 상태는 op 재생 결과다. *(S4-D3)*
- [x] Given 자기가 쓰지 않은 코멘트, When 에이전트 역할로 보면, Then [해결]이 노출되지 않는다. *(S4-D2 — 질문받은 쪽이 스스로 닫으면 게이팅이 장치가 아니다)*
- [x] Given 미해결 `question`·`review_request`가 있는 이슈, When 카드와 상세를 보면, Then **그 이슈가 지금 막혀 있다는 사실**과 무엇이 막는지가 보인다 — 미완료 `blocked_by`와 구분되는 형태로. *(§5.2, r19b)*
- [x] Given 그 코멘트를 해결하면, When 카드를 다시 보면, Then 막힘 표시가 사라진다.

### 그 밖

- [x] Given 자기가 쓴 코멘트, When 보면, Then [수정]·[삭제]가 있고 남의 코멘트에는 없다. *(S4-D2)*
- [x] Given 서버가 거부하는 입력, When 응답을 받으면, Then **서버가 준 메시지**를 그 자리에 보여주고 입력이 지워지지 않는다. *(r01c·r01d와 같은 원칙)*
- [x] Given 라이트/다크 테마, When 코멘트를 보면, Then 두 테마 모두에서 기존 규약으로 렌더되고 의존성 0개 바닐라를 유지한다. *(S2-D1)*
- [x] Given 네트워크가 없는 환경, When 코멘트를 쓰고 해결하면, Then 정상 동작한다. *(N4)*

## 범위 밖 (Out of Scope)

- 코멘트 종류 변경 — S4-D1이 사후 변경을 하지 않기로 닫았다
- 코멘트 알림 — §3 비목표, 1차는 In-App 활동 피드까지
- 코멘트 전문 검색 — R4가 이슈를 대상으로 한다
- 멘션·스레드 답글 — PRD가 규정하지 않는다
- 코멘트를 LLM에 전송 — Q10 기본 가정상 미전송

> **만들다 나온 것(2026-07-31).** 막힘 배지가 보드에만 있고 **백로그 목록에는 없었다.**
> `unanswered`를 `respondBoard`만 실어 보내고 `GET /issues`는 안 보냈기 때문인데, 이슈를
> 훑어보는 화면이 백로그라 정작 필요한 곳에서 안 보였다. 목록 응답에도 실었고, 카드마다 따로
> 묻지 않도록 페이지 전체를 한 번에 조회한다.

## 선행 의존 (Depends on)

- `r19a-comment-kind-and-resolution.md` (모델·op·API)
- `r19b-unresolved-comment-gating.md` (막힘 판정과 사유)
- `r01c-web-issue-create-form.md` (폼·검증 메시지 규약)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1·§5.3·§6.3·§6.4·§8·§9 N4·N7
- 검증: PRD AC17 · AC22 (보조 AC7·AC18)
- 드러난 경로: Sprint 04 완료 후 화면 점검
