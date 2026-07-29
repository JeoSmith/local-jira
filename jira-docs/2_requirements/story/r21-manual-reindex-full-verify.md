---
title: "수동 전체 리인덱스·전체 검증"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R21
milestone: M1
priority: P1
---

# 수동 전체 리인덱스·전체 검증

## 사용자 스토리 (User Story)

> **As a** 오너/PO(또는 보드를 운영하는 개발자),
> **I want** 설정 화면에서 인덱스 상태를 보고 버튼 한 번으로 전체 재인덱스나 전체 검증을 돌리기를,
> **so that** 보드가 파일과 어긋난 것 같을 때 터미널에서 `.local/index.sqlite`를 지우는 대신 화면에서 확실하게 되돌릴 수 있다.

## 인수 조건 (Acceptance Criteria)

- [x] Given `/settings`를 열면, When 인덱스 섹션을 보면, Then 마지막 인덱싱 시각, 인덱싱된 엔티티 건수(이슈/코멘트/스프린트/run), 격리 건수, 마지막 전체 검증 시각이 표시되고 **[전체 재인덱스]**·**[전체 검증]** 두 버튼이 있다. *(§8)*
- [x] Given [전체 재인덱스] 실행, When 완료되면, Then `.local/index.sqlite`가 폐기·재생성되고 실행 전후 API 응답이 정규화 비교로 **동일**하다(제외: 검색 score, 인덱싱 시각, claim/lease 런타임 상태). *(AC2)*
- [ ] Given 5,000 파일 데이터셋, When [전체 재인덱스]를 실행하면, Then **≤ 10s**에 완료되고 진행률(처리/전체 파일 수)이 화면에 표시된다. *(N2)*  
      **→ 이월: M2 UI — 5,000파일 재빌드가 682ms(예산 10s)라 진행률 표시가 화면에 머무를 시간이 없다. 실행 중 표시와 버튼 비활성화는 구현했다. 파일 단위 진행률은 재빌드가 느려지면 그때 붙인다**
- [x] Given [전체 검증] 실행, When 완료되면, Then `(path, file identity, mtime, size)` 기반 후보 추정을 **건너뛰고 모든 파일의 content hash를 재계산**한다. mtime·size가 그대로인데 내용만 다른 파일도 검출된다.
- [x] Given mtime을 원래 값으로 되돌린 채 내용만 바꾼 이슈 파일 1건, When [전체 검증]을 실행하면, Then 그 1건이 변경으로 검출되어 인덱스가 갱신된다(일반 기동 시 후보 추정으로는 놓치는 케이스).
- [x] Given [전체 검증] 중 무결성 위반 발견, When 완료되면, Then R11의 격리 절차가 그대로 적용되고 결과 요약(검사 파일 수, 신규 격리 건수, 해소된 격리 건수, 소요 시간)이 표시된다.
- [x] Given [전체 재인덱스]·[전체 검증] 실행, When 완료 후 `git -C .localjira status`를 보면, Then **clean**이다 — 두 명령 모두 도메인 파일을 수정하지 않는다.
- [x] Given 두 명령 실행, When 활동 타임라인을 보면, Then 도메인 이벤트가 추가되지 않는다(인덱스는 파생물). 실행 사실은 서버 로그와 설정 화면의 마지막 실행 시각으로만 남는다.
- [x] Given 실행 중 프로세스가 죽음, When 재기동하면, Then 부분 재인덱스 결과가 남지 않고 기동 시 조정으로 정상 상태에 도달한다.
- [x] Given 실행이 진행 중, When 같은 버튼을 다시 누르면, Then 중복 실행되지 않고 진행 중임이 표시된다.

> ✅ 이미 결정돼 있었다 — `sprint-01-decisions.md` §1: 설계 §3.7의 **큐잉**(최대 30초, 초과 시
> 503 + `Retry-After`). 재빌드만 해당하고 **전체 검증은 무중단**이다.
> ✅ 이미 결정돼 있었다 — 같은 곳: **재빌드 `admin`, 검증 `member` 이상**. 재빌드는 인덱스
> 세대를 교체하고 쓰기를 멈추는 운영 행위지만, 검증은 읽고 보고할 뿐이다.

## 범위 밖 (Out of Scope)

- 인덱스 재빌드 엔진 자체 → R8 (`r08a-file-index-sync.md`)
- 자동 트리거되는 조정(기동·워처·git 변화) → R8 (`r08b`, `r08c`)
- 격리 판정 로직과 오류 배너 → R11
- 파일 SoT 데이터의 백업·복원 — D5에 따라 `.local/`은 백업 대상이 아니다
- 인덱스 성능 튜닝·프로파일링 UI

## 선행 의존 (Depends on)

- `r08a-file-index-sync.md`
- `r11a-integrity-validation-quarantine.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.5(기동 시 후보 좁히기 · 명시적 전체 검증 · 인덱스 손상 시 재빌드) · §8(설정 화면) · §12 M1
- 검증: PRD AC2, NFR N2
