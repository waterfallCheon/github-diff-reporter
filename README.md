# GitHub Diff Reporter

브랜치에 푸시된 커밋을 Groq로 분석하고, 커밋마다 자세한 한국어 이해 문서를 Notion 데이터베이스에 생성하는 GitHub Action입니다. 별도 서버는 필요하지 않습니다.

Groq가 꺼져 있거나 API 키가 없거나, 민감정보 패턴이 발견되거나, 무료 한도를 초과하면 외부 AI 없이 파일 메타데이터 기반 로컬 보고서를 생성합니다.

## 처리 흐름

1. 브랜치에 푸시된 커밋을 순서대로 찾습니다.
2. `.env`, 개인키, 인증서, `credentials`, `secrets`와 추가 제외 경로를 완전히 제외합니다.
3. 남은 Diff와 커밋 메시지에서 알려진 API 키·토큰·비밀번호 패턴을 검사합니다.
4. 하나라도 발견되면 Groq 전송을 취소하고 로컬 보고서를 만듭니다.
5. 검사에 통과한 Diff만 Groq로 보내 상세 보고서를 생성합니다.
6. Groq 오류 또는 `429` 무료 한도 초과 시 재과금이나 유료 모델 전환 없이 로컬 보고서로 대체합니다.
7. 같은 `저장소 + Commit SHA`가 없을 때만 Notion 페이지를 생성합니다.

## 외부로 전송되는 정보

AI 분석이 켜진 경우 Groq에는 다음 정보가 전달됩니다.

- 비밀 패턴을 제거·검사한 커밋 메시지
- 민감 경로를 제외한 파일명
- 해당 파일의 실제 코드 Diff
- 추가·삭제 줄 수

Groq에는 저장소명, 브랜치명, 작성자, 이메일, Commit SHA와 Notion 토큰을 보내지 않습니다. 그러나 정규식 기반 검사는 모든 회사 고유 정보와 새로운 비밀 형식을 완벽하게 탐지할 수 없습니다. 기밀 코드가 포함된 프로젝트는 `ai-enabled: "false"`를 사용하세요.

Notion에는 사용자가 원한 프로젝트 문서를 만들기 위해 프로젝트명, 브랜치, 작성자, SHA, 커밋 링크, 보고서와 선택적으로 파일명이 전달됩니다.

## Groq를 무료로만 사용하기

1. Groq Console의 `Settings → Billing`에서 플랜이 `Free`인지 확인합니다.
2. `Upgrade to Developer`를 누르지 않습니다.
3. 결제수단을 등록하지 않습니다.
4. `Settings → Data Controls`에서 Zero Data Retention을 활성화합니다.
5. 무료 조직에서 API 키를 생성합니다.

이 Action은 `service_tier: auto`나 유료 모델 자동 전환을 사용하지 않습니다. Free 플랜 한도를 넘겨 Groq가 `429`를 반환하면 즉시 로컬 보고서로 바뀝니다.

## GitHub Secret 등록

API를 사용할 프로젝트의 GitHub 저장소에서 `Settings → Secrets and variables → Actions → New repository secret`으로 이동해 다음 두 값을 등록합니다.

```text
GROQ_API_KEY   Groq에서 생성한 API 키
NOTION_TOKEN   Notion Integration 토큰
```

실제 값은 코드, `.env`, README, Issue 또는 로그에 넣지 마세요.

## Notion 데이터베이스

필수 속성:

| 이름 | 형식 | 설명 |
| --- | --- | --- |
| `이름` | 제목 | AI 또는 커밋 메시지 기반 보고서 제목 |
| `날짜` | 날짜 | 한국 시간 기준 보고서 작성일 |
| `카테고리` | 다중 선택 | `owner/repository` 프로젝트 구분 |

권장 속성:

| 이름 | 형식 |
| --- | --- |
| `Commit SHA` | 텍스트 |
| `저장소` | 텍스트 |
| `브랜치` | 텍스트 |
| `작성자` | 텍스트 |
| `Commit URL` | URL |
| `변경 파일 수` | 숫자 |
| `상태` | 선택 |
| `변경 유형` | 선택 |

`Commit SHA`가 있으면 중복 페이지 생성을 방지합니다. 권장 속성이 없어도 Action은 실행됩니다. Notion Integration에는 대상 데이터베이스에 대한 콘텐츠 읽기·삽입·수정 권한이 필요합니다.

## 각 프로젝트에서 사용하기

각 프로젝트에 `.github/workflows/project-diff.yml`을 만들고 다음 내용을 추가합니다.

```yaml
name: Document pushed commits

on:
  push:
    branches:
      - "**"

permissions:
  contents: read

jobs:
  create-report:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: YOUR_GITHUB_ID/github-diff-reporter@v1
        with:
          groq-api-key: ${{ secrets.GROQ_API_KEY }}
          notion-token: ${{ secrets.NOTION_TOKEN }}
          notion-data-source-id: 3a17bcc1-71bc-805f-b1ae-000bb54445d3
          ai-enabled: "true"
          include-file-paths: "true"
          exclude-paths: |
            private/**
            internal/customer-data/**
```

`YOUR_GITHUB_ID`를 실제 GitHub 사용자명으로 바꾸세요. GitHub Models 권한은 필요하지 않습니다.

## 입력 옵션

| 입력 | 기본값 | 설명 |
| --- | --- | --- |
| `groq-api-key` | 빈 값 | GitHub Secret에서 받은 Groq API 키 |
| `ai-enabled` | `true` | Groq 분석 사용 여부 |
| `groq-model` | `openai/gpt-oss-120b` | Groq 모델 ID |
| `max-diff-characters` | `14000` | 무료 토큰 한도를 고려한 커밋당 최대 정제 Diff 길이 |
| `title-property` | `이름` | Notion 제목 속성 |
| `date-property` | `날짜` | Notion 날짜 속성 |
| `category-property` | `카테고리` | 프로젝트 다중 선택 속성 |
| `include-file-paths` | `true` | Notion 본문에 비민감 파일명 포함 여부 |
| `exclude-paths` | 빈 값 | 쉼표 또는 줄바꿈으로 구분한 추가 제외 glob |
| `max-files-per-section` | `30` | Notion 본문에 나열할 최대 파일 수 |
| `skip-merge-commits` | `true` | 병합 커밋 제외 여부 |

## 보안 경계

- `.env*`, 인증정보·비밀정보 경로, SSH 키, 인증서와 키 저장소 파일은 AI와 Notion 파일 목록에서 제외합니다.
- 알려진 GitHub, Groq, Google, AWS, Slack 토큰과 개인키, 인증 URL, 비밀값 할당을 감지하면 해당 커밋의 AI 호출을 차단합니다.
- 코드 Diff는 로그에 출력하지 않으며 Groq 오류 응답 본문도 로그에 남기지 않습니다.
- AI 요청에는 Notion 토큰이나 Groq API 키가 포함되지 않습니다.
- 저장소마다 `exclude-paths`에 회사 내부 경로를 추가하는 것을 권장합니다.
- 외부 기여자의 코드가 실행될 수 있는 `pull_request_target` 이벤트에서는 사용하지 마세요.
- 필터는 보조 안전장치이며 비밀정보를 커밋해도 된다는 의미가 아닙니다.

## 로컬 보고서로만 사용하기

민감한 프로젝트에서는 Groq 키를 제거할 필요 없이 다음 설정만 사용하면 됩니다.

```yaml
with:
  ai-enabled: "false"
```

이 모드에서는 실제 Diff를 외부 AI에 보내지 않고 파일 종류와 추가·삭제 줄 수만으로 보고서를 만듭니다.

## 개발

Node.js 20 이상에서 외부 패키지 없이 동작합니다.

```bash
npm test
```

첫 안정 버전을 배포할 때:

```bash
git tag v1
git push origin main --tags
```
