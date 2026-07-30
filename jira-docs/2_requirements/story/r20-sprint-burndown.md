---
title: "번다운·완료율 — 스코프 대비 DONE 포인트"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-30
related_prd: ../prd/backlog-sprint.md
requirement: R20
milestone: M4
priority: P1
---

# 번다운·완료율 — 스코프 대비 DONE 포인트

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** 진행 중·종료된 스프린트의 남은 포인트 추이를 보되 스코프가 중간에 늘어난 사실이 그래프에 따로 드러나기를,
> **so that** "왜 안 줄어드는가"를 진척 문제와 스코프 추가 문제로 구분해 판단할 수 있다.

## 인수 조건 (Acceptance Criteria)

### 분모·분자 정의

- [x] Given ACTIVE 스프린트 `LJ-S3`, When `/projects/LJ/sprints`에서 번다운을 열면, Then **현재 스코프 총 points**와 **`DONE` 상태 이슈의 points 합**이 표시되고 완료율이 `DONE points / 총 points`로 계산된다. — §7 R20
- [x] Given 스코프에 points 5·8·3인 이슈 3건과 `CANCELLED`(points 5) 1건, When 총 points를 계산하면, Then `16`이다. **`CANCELLED` 이슈는 분모에서 제외**된다. — AC23, D8
- [x] Given 스코프에 `points`가 비어 있는(무추정) 이슈 2건, When 총 points를 계산하면, Then 두 건은 **분모에서 제외**되고, 화면에 "무추정 2건"이 별도로 표시되어 그래프가 스코프 전부를 대표하지 않음을 드러낸다. — AC23, D8
- [x] Given 무추정 이슈가 `DONE`이 됨, When 분자를 계산하면, Then 분자에도 포함되지 않는다(분모에서 뺀 항목은 분자에도 넣지 않는다).
- [x] Given 분모가 0인 스프린트(추정된 이슈가 하나도 없음), When 번다운을 열면, Then 오류가 아니라 "추정된 이슈 없음" 안내가 표시되고 완료율은 계산되지 않는다.
- [x] Given 이슈 상태가 `IN_REVIEW`, When 분자를 계산하면, Then 포함되지 않는다. 완료는 `DONE`만이다. — §5.2

### 스코프 증감 선

- [x] Given 스프린트 시작 시 총 24 포인트, When 진행 중에 points 5짜리 이슈가 스코프에 추가되면, Then 번다운 차트에 **스코프 선이 별도 계열로** 표시되어 24 → 29로 올라간 지점이 드러난다. 남은 포인트 선과 시각적으로 구분된다. — AC23
- [x] Given 진행 중에 이슈가 스프린트에서 제외되거나 `CANCELLED`로 전환됨, When 차트를 보면, Then 스코프 선이 그만큼 **내려가고**, 그 감소가 "완료"로 오독되지 않도록 남은 포인트 선과 구분 표기된다. — AC23
- [x] Given 스프린트 진행 중 스코프 변동이 전혀 없었던 경우, When 차트를 보면, Then 스코프 선은 수평선으로 표시된다.

### 조회 범위와 표기

- [x] Given `CLOSED` 스프린트, When 번다운을 열면, Then 종료 시점 기준의 최종 그래프와 완료율이 조회된다(종료 후에도 이력이 남는다).
- [x] Given `PLANNED` 스프린트, When 번다운을 열면, Then 아직 시작 전임을 안내하고 계획 스코프 합계만 표시한다.
- [x] Given 차트의 시간축, When 눈금을 확인하면, Then 프로젝트 timezone 기준으로 표시되고, 원본 시각은 RFC 3339로 저장된 값에서 렌더링 시점에 변환된다. — §5.2
- [x] Given 모든 단위, When 축·수치를 확인하면, Then **스토리 포인트**다. 시간 단위는 없다. — D8
- [x] Given 격리(`INVALID`)된 이슈가 스프린트에 있음, When 집계하면, Then 그 이슈는 집계에서 제외되고 그 사실이 차트 옆에 명시된다. — §5.6
- [x] Given 라이트/다크 테마, When 차트를 보면, Then 양쪽에서 두 계열(남은 포인트·스코프)의 대비가 유지되며 색만으로 계열을 구분하지 않는다. — §8

> **이미 결정돼 있었다(D12).** 시계열은 **일별 스냅샷을 스프린트 파일의
> `burndown_snapshots[]`에 append**한다. 이벤트 재생은 하지 않는다 — 이벤트 로그는 변조
> 방지가 아니고(§5.7) 누구나 편집할 수 있어 차트 정확도를 걸 수 없으며, 스냅샷이 파일 SoT에
> 있어야 인덱스 재빌드 후에도 같은 차트가 나온다(AC2). 이 스토리에서 새로 연 질문이 아니었다.
> 결정됨(S4-D7): x축 표본은 하루이며 같은 날짜는 덮어쓴다. **이상선은 그리지 않는다** —
> 스프린트에 고정 기간이 없다는 것이 이 프로젝트의 전제이고, 끝나는 날을 모르면 이상선은
> 그을 수 없다. 에픽·프로젝트 단위 번다운은 범위 밖이다.
> 결정됨(S4-D8): 스냅샷은 서버가 기동 시 한 번, 그 뒤 스코프·상태를 바꾸는 쓰기마다 갱신한다.
> 상시 데몬이 아니므로 자정에 기록할 주체가 없다. **서버를 켜지 않은 날은 표본이 없고, 그
> 날의 값을 지어내지 않는다.**
>
> 구현 메모: 격리된 이슈는 전체 재빌드 후 행이 남지 않아 어느 스프린트 것인지 알 수 없다.
> 그래서 스프린트별 `quarantined`와 별개로 보드 전체의 `unindexed` 건수를 차트 옆에 낸다 —
> 모르는 것을 스프린트에 귀속시키면 아무것도 뒷받침하지 않는 숫자가 된다.

## 범위 밖 (Out of Scope)

- 스프린트 시작·종료·이월 → `r05b-sprint-start-close-carryover.md`
- 계획 시점의 포인트 합계 vs capacity 경고 → `r06-sprint-planning-capacity.md`
- 속도(velocity)·여러 스프린트 비교 리포트 — PRD에 없음
- 워크로그·시간 기록 기반 지표 — §3 비목표
- CSV/JSON 내보내기 → R24
- 이벤트 저장 형식 → `r14a-event-recording.md`

## 선행 의존 (Depends on)

- `r05b-sprint-start-close-carryover.md`
- `r06-sprint-planning-capacity.md`
- `r14a-event-recording.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.2(상태·RFC 3339) · §5.6(격리 제외) · §7 R20 · §8(스프린트 화면 — 번다운 P1) · §12 M4 · §13 D8
- 검증: PRD AC23
